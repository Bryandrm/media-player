//! Comando Tauri del downloader: orquesta yt-dlp + extracción de metadata +
//! inserción en `tracks`. Emite eventos para que la UI muestre progreso en
//! tiempo real.
//!
//! Notas de diseño:
//! - El ID de descarga es el id de la fila en `downloads` (history persistente,
//!   ADR-011 chunk 2): insertamos al arrancar y actualizamos al terminar. El
//!   frontend carga el historial al boot.
//! - Idempotencia: yt-dlp corre con `--no-overwrites`. Si el archivo final
//!   ya existía en disco, marcamos `Skipped` (la fila en `tracks` ya está;
//!   `insert_from_metadata` es no-op gracias a `ON CONFLICT DO NOTHING`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::audio;
use crate::contracts::{Download, DownloadStatus};
use crate::db;
use crate::downloader::{self, DownloadEvent};
use crate::errors::{AppError, AppResult};
use crate::identification;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    download_id: i64,
    progress: f32,
}

/// Progreso a nivel de playlist: qué item de cuántos arrancó. La UI lo muestra
/// como "3/12". Sólo se emite en descargas de lista.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ItemProgressEvent {
    download_id: i64,
    current: u32,
    total: u32,
}

/// Registro de descargas en curso → su canal de cancelación. `download_cancel`
/// busca el sender por id y dispara el kill de yt-dlp. `Mutex` std: el lock se
/// tiene sólo para insert/remove instantáneos, nunca cruzando un `await`.
#[derive(Default)]
pub struct DownloadCancels(pub Mutex<HashMap<i64, oneshot::Sender<()>>>);

#[tauri::command]
pub async fn download_track(
    url: String,
    playlist: bool,
    cookies_browser: Option<String>,
    cookies_file: Option<String>,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    cancels: State<'_, DownloadCancels>,
) -> AppResult<Download> {
    // Insertamos la fila de descarga al arrancar → su id es el download_id que
    // usan los eventos (history persistente, ADR-011 chunk 2).
    let download_id = db::downloads::insert(pool.inner(), &url).await?;

    // Canal de cancelación: registramos el sender bajo el download_id para que
    // `download_cancel` pueda matar este yt-dlp. Se desregistra al terminar.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    cancels.0.lock().unwrap().insert(download_id, cancel_tx);

    let audio_dir = app
        .path()
        .audio_dir()
        .map_err(|e| AppError::Other(format!("audio dir unavailable: {}", e)))?;
    let library_dir = audio_dir.join("BrutalistPlayer").join("library");

    // started → la UI inserta la fila en su queue.
    let _ = app.emit(
        "download-started",
        Download {
            id: download_id,
            url: url.clone(),
            status: DownloadStatus::Downloading,
            progress: -1.0,
            title: None,
            error: None,
            track_id: None,
            completed_at: None,
            playlist_id: None,
        },
    );

    // Closure de eventos: emite progress updates y la transición a postprocess.
    // `postprocess_emitted` deduplica — yt-dlp imprime varios `[ExtractAudio]`,
    // `[Metadata]`, `[EmbedThumbnail]`; sólo queremos un cambio de estado.
    let app_for_event = app.clone();
    let url_for_event = url.clone();
    let mut postprocess_emitted = false;
    let result = downloader::run_yt_dlp(
        &url,
        &library_dir,
        playlist,
        cookies_browser.as_deref(),
        cookies_file.as_deref(),
        cancel_rx,
        move |evt| match evt {
        DownloadEvent::Progress(fraction) => {
            let _ = app_for_event.emit(
                "download-progress",
                ProgressEvent {
                    download_id,
                    progress: fraction,
                },
            );
        }
        DownloadEvent::ItemProgress { current, total } => {
            let _ = app_for_event.emit(
                "download-item",
                ItemProgressEvent {
                    download_id,
                    current,
                    total,
                },
            );
        }
        DownloadEvent::PostprocessStarted => {
            if postprocess_emitted {
                return;
            }
            postprocess_emitted = true;
            let _ = app_for_event.emit(
                "download-postprocessing",
                Download {
                    id: download_id,
                    url: url_for_event.clone(),
                    status: DownloadStatus::Postprocessing,
                    progress: -1.0,
                    title: None,
                    error: None,
                    track_id: None,
                    completed_at: None,
                    playlist_id: None,
                },
            );
        }
    })
    .await;

    // Descarga terminada (o cancelada) → desregistramos el canal de cancelación.
    cancels.0.lock().unwrap().remove(&download_id);

    match result {
        Ok((mut entries, cancelled)) => {
            let pool_ref = pool.inner();

            // Orden estable: en playlist, por índice original de la lista; un
            // video suelto tiene índice None y queda como está.
            entries.sort_by_key(|e| e.playlist_index.unwrap_or(i64::MAX));

            let mut track_ids: Vec<i64> = Vec::new();
            let mut playlist_title: Option<String> = None;
            let mut last_title = String::new();
            // Status del único archivo en descargas de un solo video — preserva
            // la distinción Completed vs Skipped que muestra la UI.
            let mut single_status = DownloadStatus::Completed;

            for entry in &entries {
                if playlist_title.is_none() {
                    playlist_title = entry.playlist_title.clone();
                }
                // Un archivo que falla al persistir (metadata corrupta, fpcalc,
                // un lock de DB puntual) NO debe abortar toda la importación de
                // la playlist. Lo salteamos y seguimos — la lista se arma con lo
                // que sí entró. Mismo espíritu que el éxito parcial de la
                // descarga (ADR-028). Para un video suelto, el guard de abajo
                // (`track_ids.is_empty()`) lo convierte en error real.
                match persist_downloaded_file(&app, pool_ref, &entry.path, &url).await {
                    Ok((status, track_id, title)) => {
                        last_title = title;
                        single_status = status;
                        if let Some(id) = track_id {
                            track_ids.push(id);
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[download] persist falló para {}: {}",
                            entry.path.display(),
                            e
                        );
                    }
                }
            }

            // Cancelado sin nada persistido → estado Cancelled (no es error).
            if cancelled && track_ids.is_empty() {
                let download = Download {
                    id: download_id,
                    url: url.clone(),
                    status: DownloadStatus::Cancelled,
                    progress: -1.0,
                    title: Some("Cancelado".to_string()),
                    error: None,
                    track_id: None,
                    completed_at: None,
                    playlist_id: None,
                };
                let _ = db::downloads::finish(pool_ref, &download).await;
                let _ = app.emit("download-completed", download.clone());
                return Ok(download);
            }

            // Si NADA se pudo persistir (y no fue cancelación), es falla real (no
            // creamos una playlist vacía ni reportamos un éxito fantasma).
            if track_ids.is_empty() {
                let msg = "no se pudo importar ningún archivo descargado".to_string();
                let download = Download {
                    id: download_id,
                    url: url.clone(),
                    status: DownloadStatus::Failed,
                    progress: -1.0,
                    title: None,
                    error: Some(msg.clone()),
                    track_id: None,
                    completed_at: None,
                    playlist_id: None,
                };
                let _ = db::downloads::finish(pool_ref, &download).await;
                let _ = app.emit("download-failed", download);
                return Err(AppError::Other(msg));
            }

            // Si era descarga de lista, además de dejar los tracks en "all
            // tracks" creamos/reusamos la playlist y los agregamos en orden.
            // get_or_create + add_track idempotente → re-bajar la misma lista
            // no duplica ni la playlist ni sus tracks.
            let (summary_title, completed_track_id, status, playlist_ref) = if playlist {
                let name = playlist_title.unwrap_or_else(|| "Imported playlist".to_string());
                let playlist_id = db::playlists::get_or_create_id(pool_ref, &name).await?;
                for track_id in &track_ids {
                    let _ = db::playlists::add_track(pool_ref, playlist_id, *track_id).await;
                }
                let suffix = if cancelled { " (cancelado)" } else { "" };
                (
                    format!("{} — {} tracks{}", name, track_ids.len(), suffix),
                    None,
                    if cancelled {
                        DownloadStatus::Cancelled
                    } else {
                        DownloadStatus::Completed
                    },
                    Some(playlist_id),
                )
            } else {
                (
                    last_title,
                    track_ids.first().copied(),
                    if cancelled {
                        DownloadStatus::Cancelled
                    } else {
                        single_status
                    },
                    None,
                )
            };

            let download = Download {
                id: download_id,
                url,
                status,
                progress: 1.0,
                title: Some(summary_title),
                error: None,
                track_id: completed_track_id,
                completed_at: None,
                playlist_id: playlist_ref,
            };
            let _ = db::downloads::finish(pool_ref, &download).await;
            let _ = app.emit("download-completed", download.clone());
            Ok(download)
        }
        Err(e) => {
            let error_msg = e.to_string();
            let download = Download {
                id: download_id,
                url,
                status: DownloadStatus::Failed,
                progress: -1.0,
                title: None,
                error: Some(error_msg.clone()),
                track_id: None,
                completed_at: None,
                playlist_id: None,
            };
            let _ = db::downloads::finish(pool.inner(), &download).await;
            let _ = app.emit("download-failed", download.clone());
            Err(AppError::Other(error_msg))
        }
    }
}

/// Devuelve el historial de descargas (más recientes primero) para poblar la
/// cola al boot.
#[tauri::command]
pub async fn download_list_history(pool: State<'_, SqlitePool>) -> AppResult<Vec<Download>> {
    db::downloads::list_recent(&pool, 100).await
}

/// Borra del historial las descargas terminales (no toca una en curso).
#[tauri::command]
pub async fn download_clear_history(pool: State<'_, SqlitePool>) -> AppResult<()> {
    db::downloads::clear_terminal(&pool).await
}

/// Borra una descarga puntual del historial (botón ✕ de la fila).
#[tauri::command]
pub async fn download_delete(id: i64, pool: State<'_, SqlitePool>) -> AppResult<()> {
    db::downloads::delete(&pool, id).await
}

/// Cancela una descarga en curso: mata el yt-dlp asociado. Los archivos que ya
/// se bajaron se conservan (la descarga termina como `Cancelled` con sus
/// parciales). No-op si la descarga ya terminó (sender ya desregistrado).
#[tauri::command]
pub fn download_cancel(download_id: i64, cancels: State<'_, DownloadCancels>) {
    if let Some(tx) = cancels.0.lock().unwrap().remove(&download_id) {
        let _ = tx.send(());
    }
}

/// Extrae metadata + cleanup, inserta en `tracks`, y materializa el cover art
/// si el track es nuevo. Devuelve `(status, track_id, title)`. Compartido entre
/// la descarga de un video suelto y la de cada entry de una playlist.
///
/// Cleanup heurístico: yt-dlp escribe metadata desde YouTube con artefactos
/// (artist="X - Topic", title="Y (Official Video)"). LRCLIB hace match exacto
/// contra (artist, title), así que un sufijo de más basta para 404. La cleanup
/// es conservadora — sólo strip-ea patrones claramente-yt-dlp. Ver
/// audio/cleanup.rs.
async fn persist_downloaded_file(
    app: &AppHandle,
    pool: &SqlitePool,
    file_path: &Path,
    url: &str,
) -> AppResult<(DownloadStatus, Option<i64>, String)> {
    let meta = audio::extract_metadata(file_path)
        .map_err(|e| AppError::Other(format!("metadata read failed: {}", e)))?;
    let meta = audio::cleanup::cleanup_metadata(meta);
    let title = meta.title.clone();

    // Dedup nivel 1 (path): mismo file_path ya en la library = mismo video
    // re-bajado. Reusamos sin fingerprintear; `--no-overwrites` ya evitó la
    // re-descarga en disco. El track igual se devuelve para sumarlo a la
    // playlist que dispare esta descarga.
    if let Some(existing) = db::tracks::find_id_by_path(pool, file_path).await? {
        return Ok((DownloadStatus::Skipped, Some(existing), title));
    }

    // Dedup nivel 2 (contenido): path nuevo, pero el audio puede ser la misma
    // grabación traída de otro upload. Fingerprint Chromaprint + match exacto.
    // Si fpcalc no está / falla, seguimos sin dedup por contenido (best-effort).
    let fingerprint = match identification::fpcalc::compute(file_path).await {
        Ok(fp) => Some(fp.fingerprint),
        Err(_) => None,
    };
    if let Some(fp) = &fingerprint {
        if let Some(dup_id) = db::tracks::find_id_by_fingerprint(pool, fp).await? {
            // Duplicado por contenido: descartamos la copia recién bajada y
            // reusamos el track existente. Borrar es seguro acá — el archivo lo
            // acabamos de crear nosotros (no es un file del usuario).
            let _ = std::fs::remove_file(file_path);
            return Ok((DownloadStatus::Skipped, Some(dup_id), title));
        }
    }

    // Track genuinamente nuevo → insert + cache del fingerprint + cover art.
    let inserted_id =
        db::tracks::insert_from_metadata(pool, file_path, meta, "downloaded", Some(url)).await?;
    let (status, track_id) = match inserted_id {
        Some(id) => {
            // Cacheamos el fingerprint para que dedup futuros (y un IDENTIFY
            // posterior) no tengan que re-correr fpcalc.
            if let Some(fp) = &fingerprint {
                let _ = db::tracks::save_fingerprint(pool, id, fp).await;
            }
            // yt-dlp ya embebió el thumbnail con `--embed-thumbnail`.
            let cache_dir = app
                .path()
                .app_cache_dir()
                .map_err(|e| AppError::Other(format!("cache dir unavailable: {}", e)))?;
            if let Ok(Some(cover_path)) = audio::extract_cover_art(file_path, id, &cache_dir) {
                let _ = db::tracks::set_cover_art(pool, id, Some(&cover_path)).await;
            }
            (DownloadStatus::Completed, Some(id))
        }
        // Carrera improbable: otro insert ganó el path entre el check y acá.
        None => {
            let id = db::tracks::find_id_by_path(pool, file_path).await?;
            (DownloadStatus::Skipped, id)
        }
    };
    Ok((status, track_id, title))
}
