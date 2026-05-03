//! Comandos Tauri de identification (AcoustID + Chromaprint).
//!
//! Cinco comandos:
//!   - identification_identify_track: corre el cascade fpcalc → AcoustID
//!     → persist. Si status='identified', invalida la cache de lyrics
//!     para que el siguiente lyrics_fetch corra con la metadata canónica.
//!   - identification_get_api_key / set_api_key: storage simple en
//!     la tabla `settings` (key = "acoustid_api_key").
//!   - identification_identify_all: bulk backfill — recorre todos los
//!     tracks con status NULL o 'api_error', con throttle 2.85 rps
//!     (debajo del cap free de AcoustID 3 rps). Cancelable.
//!   - identification_cancel_all: setea el cancel flag; el bulk task lo
//!     chequea entre iteraciones y termina al fin de la canción actual.
//!
//! Ver docs/IDENTIFICATION.md §6.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, State};
use tokio::time::Instant;

use crate::db;
use crate::errors::{AppError, AppResult};
use crate::identification::{self, IdentificationResult};

const API_KEY_SETTING: &str = "acoustid_api_key";

/// Throttle conservador. AcoustID free permite 3 rps; 350ms = ~2.85 rps
/// nos deja margen para no chocarnos con la cuota. La latencia de cada
/// request es 200-800ms, así que el sleep efectivo a veces es 0
/// (request tardó más que el intervalo) — eso es deseable, queremos saturar
/// el rate limit sin pasarlo.
const BULK_MIN_INTERVAL: Duration = Duration::from_millis(350);

/// Estado compartido del bulk identify. Se registra en `lib.rs setup()`
/// vía `app.manage()`. Una sola corrida a la vez (`running` lo enforce);
/// cancel es one-shot por corrida (se resetea al arrancar la siguiente).
#[derive(Default)]
pub struct BulkIdentifyState {
    pub running: Arc<AtomicBool>,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BulkProgress {
    done: usize,
    total: usize,
    current_track_id: i64,
    last_status: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct BulkCompleted {
    total: usize,
    identified: usize,
    low_confidence: usize,
    no_match: usize,
    fingerprint_failed: usize,
    api_error: usize,
    cancelled: bool,
}

#[tauri::command]
pub async fn identification_identify_track(
    track_id: i64,
    pool: State<'_, SqlitePool>,
    http: State<'_, reqwest::Client>,
) -> AppResult<IdentificationResult> {
    let api_key = db::settings::get(&pool, API_KEY_SETTING)
        .await?
        .ok_or(AppError::AcoustIdNoApiKey)?;

    let result =
        identification::identify_track(pool.inner(), http.inner(), track_id, &api_key).await?;

    // Si AcoustID aceptó el match, las heurísticas de lyrics que cacheamos
    // antes (con metadata sucia) ya no aplican: el track ahora tiene
    // canonical title/artist distintos. Borramos la fila de lyrics para
    // que el frontend, al llamar lyrics_fetch, reciba un cache miss y
    // corra el cascade text-based con los valores limpios. Mismo patrón
    // que library_backfill_metadata.
    if result.status == "identified" {
        db::lyrics::delete_for_track(&pool, track_id).await?;
    }

    Ok(result)
}

#[tauri::command]
pub async fn identification_get_api_key(
    pool: State<'_, SqlitePool>,
) -> AppResult<Option<String>> {
    db::settings::get(&pool, API_KEY_SETTING).await
}

#[tauri::command]
pub async fn identification_set_api_key(
    key: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    // Defensivo: rechazar key vacía o whitespace-only para que no quede
    // un setting inservible. La validación real (key correcta) la hace
    // AcoustID al primer lookup — `api_error` con mensaje claro.
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "AcoustID API key cannot be empty".into(),
        ));
    }
    db::settings::set(&pool, API_KEY_SETTING, trimmed).await
}

/// Bulk identify de toda la library. Devuelve inmediatamente — el trabajo
/// real corre en un task spawneado, comunicándose con el frontend via
/// eventos `identification-progress` y `identification-completed`.
///
/// Por qué fire-and-forget en vez de await: el bulk puede tardar minutos
/// con libraries grandes; awaitearlo desde el comando bloqueaba el invoke
/// del frontend y el usuario no podía interactuar con nada hasta el final.
/// El task usa `app.emit(...)` para reportar; el frontend listen-ea.
#[tauri::command]
pub async fn identification_identify_all(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    http: State<'_, reqwest::Client>,
    bulk: State<'_, BulkIdentifyState>,
) -> AppResult<()> {
    if bulk.running.load(Ordering::SeqCst) {
        return Err(AppError::InvalidInput(
            "bulk identify already running".into(),
        ));
    }

    let api_key = db::settings::get(&pool, API_KEY_SETTING)
        .await?
        .ok_or(AppError::AcoustIdNoApiKey)?;

    let track_ids = db::tracks::list_identifiable(&pool).await?;
    let total = track_ids.len();

    if total == 0 {
        // Edge case: nada para hacer. Emitimos completed igual para que el
        // frontend resetee su estado UI.
        let _ = app.emit(
            "identification-completed",
            BulkCompleted::default(),
        );
        return Ok(());
    }

    bulk.running.store(true, Ordering::SeqCst);
    bulk.cancel.store(false, Ordering::SeqCst);

    let pool_clone = pool.inner().clone();
    let http_clone = http.inner().clone();
    let cancel_flag = bulk.cancel.clone();
    let running_flag = bulk.running.clone();
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut counts = BulkCompleted {
            total,
            ..BulkCompleted::default()
        };
        let mut last_request: Option<Instant> = None;

        for (i, &track_id) in track_ids.iter().enumerate() {
            // Cancel checkpoint ANTES del sleep — si el user cancela
            // mientras esperábamos al rate limit, salimos rápido.
            if cancel_flag.load(Ordering::SeqCst) {
                counts.cancelled = true;
                break;
            }

            // Throttle: garantizamos un intervalo mínimo entre el INICIO de
            // requests sucesivos. Si la request anterior tardó más que el
            // intervalo (típico, ~500ms+), sleep es 0 — esto es deseable
            // (queremos saturar el rate sin pasarlo).
            if let Some(prev) = last_request {
                let elapsed = prev.elapsed();
                if elapsed < BULK_MIN_INTERVAL {
                    tokio::time::sleep(BULK_MIN_INTERVAL - elapsed).await;
                }
            }
            last_request = Some(Instant::now());

            let result = match identification::identify_track(
                &pool_clone,
                &http_clone,
                track_id,
                &api_key,
            )
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[bulk identify] error on track {track_id}: {e}");
                    // identify_track ya updatea el status en DB para sus
                    // propios errores. Si llegamos acá es algo inesperado
                    // (DB caída, track id que ya no existe, etc.) — lo
                    // contamos como api_error sin pisar la DB.
                    counts.api_error += 1;
                    let _ = app_handle.emit(
                        "identification-progress",
                        BulkProgress {
                            done: i + 1,
                            total,
                            current_track_id: track_id,
                            last_status: "api_error".into(),
                        },
                    );
                    continue;
                }
            };

            // Mismo patrón que el comando single: invalidar cache lyrics
            // tras un match aceptado.
            if result.status == "identified" {
                let _ = db::lyrics::delete_for_track(&pool_clone, track_id).await;
            }

            match result.status.as_str() {
                "identified" => counts.identified += 1,
                "low_confidence" => counts.low_confidence += 1,
                "no_match" => counts.no_match += 1,
                "fingerprint_failed" => counts.fingerprint_failed += 1,
                "api_error" => counts.api_error += 1,
                other => {
                    eprintln!("[bulk identify] unexpected status '{other}' for {track_id}");
                }
            }

            let _ = app_handle.emit(
                "identification-progress",
                BulkProgress {
                    done: i + 1,
                    total,
                    current_track_id: track_id,
                    last_status: result.status,
                },
            );
        }

        running_flag.store(false, Ordering::SeqCst);
        let _ = app_handle.emit("identification-completed", counts);
    });

    Ok(())
}

#[tauri::command]
pub async fn identification_cancel_all(
    bulk: State<'_, BulkIdentifyState>,
) -> AppResult<()> {
    // Idempotente: si no hay nada corriendo, no-op. Setear el flag fuera de
    // running es seguro — lo reseteamos al arrancar la próxima corrida.
    bulk.cancel.store(true, Ordering::SeqCst);
    Ok(())
}
