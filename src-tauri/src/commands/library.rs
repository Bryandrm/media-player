//! Comandos Tauri de la biblioteca: scan de directorios + listado.

use serde::Serialize;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::Instant;
use walkdir::WalkDir;

use crate::audio;
use crate::contracts::{ScanReport, Track};
use crate::db;
use crate::errors::{AppError, AppResult};
use crate::identification::{coverartarchive, musicbrainz};

/// Importa un único archivo de audio: extrae metadata, inserta en `tracks`
/// (idempotente por `file_path`), y materializa el cover art si es nuevo.
/// Actualiza `report` con el resultado. No-op si no es un archivo de audio.
/// Corre dentro de un contexto blocking (lofty es sync) — usa `block_on` para
/// los inserts async. Compartido por el scan de directorios y el import por
/// drag & drop.
fn import_one_file(
    pool: &SqlitePool,
    file_path: &Path,
    cache_dir: &Path,
    report: &mut ScanReport,
) {
    if !audio::is_audio_file(file_path) {
        return;
    }
    report.scanned += 1;

    let meta = match audio::extract_metadata(file_path) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[import] skip {}: {}", file_path.display(), e);
            report.errors += 1;
            return;
        }
    };

    let insert_result = tauri::async_runtime::block_on(db::tracks::insert_from_metadata(
        pool, file_path, meta, "local", None,
    ));

    match insert_result {
        Ok(Some(track_id)) => {
            report.inserted += 1;
            // Cover art best-effort: el track es válido aunque falle.
            if let Ok(Some(cover_path)) = audio::extract_cover_art(file_path, track_id, cache_dir) {
                let _ = tauri::async_runtime::block_on(db::tracks::set_cover_art(
                    pool,
                    track_id,
                    Some(&cover_path),
                ));
            }
        }
        Ok(None) => report.skipped += 1,
        Err(e) => {
            eprintln!("[import] insert failed {}: {}", file_path.display(), e);
            report.errors += 1;
        }
    }
}

/// Escanea recursivamente un directorio e inserta todos los archivos de audio
/// legibles en `tracks`. Devuelve un `ScanReport` con contadores.
///
/// Tracks ya existentes (por `file_path`) se saltean silenciosamente — esto
/// hace el scan idempotente: re-escanear el mismo directorio no duplica.
/// Para tracks recién insertados, también extrae el cover art (embebido o
/// sibling cover.jpg) y lo guarda en `<app_cache>/thumbnails/<id>.<ext>`.
#[tauri::command]
pub async fn library_scan_directory(
    path: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<ScanReport> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "not a directory: {}",
            root.display()
        )));
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("cache dir unavailable: {}", e)))?;

    // Recorrido + lectura de metadata en un pool de blocking threads —
    // lofty es sync y no queremos bloquear el runtime async principal.
    let pool_for_blocking = pool.inner().clone();
    let root_for_blocking = root.clone();

    let report = tauri::async_runtime::spawn_blocking(move || -> ScanReport {
        let mut report = ScanReport {
            scanned: 0,
            inserted: 0,
            skipped: 0,
            errors: 0,
        };

        for entry in WalkDir::new(&root_for_blocking).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            import_one_file(&pool_for_blocking, entry.path(), &cache_dir, &mut report);
        }

        report
    })
    .await
    .map_err(|e| AppError::Other(format!("scan task joined with error: {}", e)))?;

    eprintln!(
        "[scan] {} → scanned={} inserted={} skipped={} errors={}",
        root.display(),
        report.scanned,
        report.inserted,
        report.skipped,
        report.errors
    );

    Ok(report)
}

/// Importa una lista de paths (archivos o directorios), típicamente de un
/// drag & drop desde el explorador del sistema. Los archivos de audio se
/// importan directo; los directorios se escanean recursivo. Reusa
/// `import_one_file` (idempotente por `file_path` → re-importar no duplica).
/// Devuelve un `ScanReport` agregado.
#[tauri::command]
pub async fn library_import_paths(
    paths: Vec<String>,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<ScanReport> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("cache dir unavailable: {}", e)))?;
    let pool_for_blocking = pool.inner().clone();
    let n_paths = paths.len();

    let report = tauri::async_runtime::spawn_blocking(move || -> ScanReport {
        let mut report = ScanReport {
            scanned: 0,
            inserted: 0,
            skipped: 0,
            errors: 0,
        };
        for p in &paths {
            let path = PathBuf::from(p);
            if path.is_dir() {
                for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
                    if entry.file_type().is_file() {
                        import_one_file(&pool_for_blocking, entry.path(), &cache_dir, &mut report);
                    }
                }
            } else if path.is_file() {
                import_one_file(&pool_for_blocking, &path, &cache_dir, &mut report);
            }
        }
        report
    })
    .await
    .map_err(|e| AppError::Other(format!("import task joined with error: {}", e)))?;

    eprintln!(
        "[import] {} paths → scanned={} inserted={} skipped={} errors={}",
        n_paths, report.scanned, report.inserted, report.skipped, report.errors
    );

    Ok(report)
}

/// Devuelve todos los tracks de la biblioteca.
#[tauri::command]
pub async fn library_list_tracks(pool: State<'_, SqlitePool>) -> AppResult<Vec<Track>> {
    db::tracks::list_all(&pool).await
}

/// Para tracks ya en DB que no tienen `cover_art_path` (típicamente tracks
/// agregados antes de que existiera el feature de cover art), intenta extraer
/// cover ahora. Devuelve la cantidad de tracks que se actualizaron.
///
/// Se llama una vez al boot desde el frontend. Idempotente: re-llamarlo
/// es seguro pero hace cero trabajo si todos los tracks ya tienen cover.
#[tauri::command]
pub async fn library_backfill_covers(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<usize> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("cache dir unavailable: {}", e)))?;
    let pool_for_blocking = pool.inner().clone();

    let count = tauri::async_runtime::spawn_blocking(move || -> usize {
        let pending: Vec<(i64, String)> = match tauri::async_runtime::block_on(
            sqlx::query_as::<_, (i64, String)>(
                "SELECT id, file_path FROM tracks WHERE cover_art_path IS NULL",
            )
            .fetch_all(&pool_for_blocking),
        ) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("[backfill] query failed: {}", e);
                return 0;
            }
        };

        let mut updated = 0;
        for (id, path_str) in pending {
            let path = PathBuf::from(&path_str);
            if !path.is_file() {
                continue;
            }
            if let Ok(Some(cover_path)) = audio::extract_cover_art(&path, id, &cache_dir) {
                if tauri::async_runtime::block_on(db::tracks::set_cover_art(
                    &pool_for_blocking,
                    id,
                    Some(&cover_path),
                ))
                .is_ok()
                {
                    updated += 1;
                }
            }
        }
        updated
    })
    .await
    .map_err(|e| AppError::Other(format!("backfill task joined with error: {}", e)))?;

    if count > 0 {
        eprintln!("[backfill] cover_art populated for {} tracks", count);
    }

    Ok(count)
}

/// Aplica `cleanup_metadata` a tracks ya en DB (filtrado a `source_type =
/// 'downloaded'` — los tracks locales suelen tener metadata curada y no
/// queremos modificarla). Actualiza sólo cuando la cleanup produce un cambio
/// real respecto al valor actual — para no hacer write-amplification ni
/// mutar tracks que ya estaban limpios.
///
/// Usado para "limpiar la library" después de bumpear las heurísticas de
/// cleanup, o post-migración si el usuario tenía tracks descargados antes
/// de que existiera el cleanup.
///
/// Devuelve la cantidad de tracks que cambiaron.
#[tauri::command]
pub async fn library_backfill_metadata(pool: State<'_, SqlitePool>) -> AppResult<usize> {
    let rows = db::tracks::list_for_metadata_backfill(&pool).await?;
    let total_candidates = rows.len();

    let mut updated = 0usize;
    for (id, title, artist, source_type) in rows {
        // Construir un TrackMetadata "minimal" sólo con los campos que la
        // cleanup mira. Los otros valores (duration, bitrate, etc.) no se
        // usan por la cleanup, así que default-eados.
        let proposed = audio::cleanup::cleanup_metadata(crate::audio::TrackMetadata {
            title: title.clone(),
            artist: artist.clone(),
            album: None,
            duration_ms: 0,
            track_number: None,
            year: None,
            genre: None,
            bitrate: None,
            sample_rate: None,
            format: None,
        });

        // Skip si la cleanup no cambió nada — evita UPDATE innecesario y
        // mantiene el `last_played_at` y otros campos no tocados.
        if proposed.title == title && proposed.artist == artist {
            // Log para diagnóstico — el usuario puede ver qué tracks no
            // matchearon ninguna heurística. Sólo prefijo y comilla simple
            // para que sea legible en los logs.
            eprintln!(
                "[backfill metadata]  skip id={} src={} artist={:?} title={:?}",
                id, source_type, artist, title
            );
            continue;
        }
        eprintln!(
            "[backfill metadata]    UP id={} src={} artist {:?} → {:?}, title {:?} → {:?}",
            id, source_type, artist, proposed.artist, title, proposed.title
        );

        if let Err(e) = db::tracks::update_title_and_artist(
            &pool,
            id,
            &proposed.title,
            proposed.artist.as_deref(),
        )
        .await
        {
            eprintln!("[backfill metadata] update failed for track {}: {}", id, e);
            continue;
        }
        // Invalidar cache de lyrics: el resultado guardado fue contra la
        // metadata vieja (sucia). Sea found o not_found, ya no es válido —
        // el próximo lyrics_fetch debe re-querear con artist/title limpios.
        // Best-effort: no fail-eamos el backfill si el delete falla.
        if let Err(e) = db::lyrics::delete_for_track(&pool, id).await {
            eprintln!(
                "[backfill metadata] lyrics cache invalidation failed for {}: {}",
                id, e
            );
        }
        updated += 1;
    }

    eprintln!(
        "[backfill metadata] candidates={} updated={}",
        total_candidates, updated
    );
    Ok(updated)
}


// ============================================================================
// MB metadata backfill — genre + year + album (+ cover via Cover Art Archive)
// ============================================================================

/// Throttle conservador para MusicBrainz. Cap anonymous = 1 req/seg estricto;
/// 1.05s = 0.95 rps nos deja margen para no chocar el cap. La fetch del cover
/// via Cover Art Archive ocurre DENTRO del mismo intervalo (cuando aplica)
/// — CAA es un endpoint distinto pero no queremos pasarles de ~1 req/s combinado.
const MB_BACKFILL_MIN_INTERVAL: Duration = Duration::from_millis(1050);

#[derive(Default)]
pub struct BulkMbBackfillState {
    pub running: Arc<AtomicBool>,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MbBackfillProgress {
    done: usize,
    total: usize,
    current_track_id: i64,
    /// "updated" (algún campo MB cambió) | "no_data" (MB devolvió todo None) |
    /// "error" — para que la UI muestre el outcome del último track.
    last_status: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct MbBackfillCompleted {
    total: usize,
    /// Tracks donde al menos un campo MB se actualizó (genre, year o album).
    updated: usize,
    /// Tracks donde MB devolvió toda la metadata en None — no había nada útil.
    no_data: usize,
    /// Tracks que recibieron cover desde Cover Art Archive (subset de updated
    /// + casos donde sólo cambió cover sin tocar metadata).
    covers_updated: usize,
    error: usize,
    cancelled: bool,
}

/// Backfill de metadata via MusicBrainz para tracks identificados (con MBID).
/// Trae genre + year + album en una sola request; cuando el track no tiene
/// cover_art_path y la fetch MB devolvió un release_group_mbid, también
/// intenta descargar la portada frontal desde Cover Art Archive.
///
/// Fire-and-forget: spawneamos un task que emite `mb-backfill-progress` y
/// `mb-backfill-completed`. Throttle ~0.95 rps respetando MB anonymous (1 rps);
/// la llamada a CAA cuenta dentro del mismo intervalo (no la doblamos).
#[tauri::command]
pub async fn library_backfill_mb_metadata(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    http: State<'_, reqwest::Client>,
    bulk: State<'_, BulkMbBackfillState>,
) -> AppResult<()> {
    if bulk.running.load(Ordering::SeqCst) {
        return Err(AppError::InvalidInput(
            "mb backfill already running".into(),
        ));
    }

    let candidates = db::tracks::list_for_mb_backfill(&pool).await?;
    let total = candidates.len();

    if total == 0 {
        let _ = app.emit("mb-backfill-completed", MbBackfillCompleted::default());
        return Ok(());
    }

    bulk.running.store(true, Ordering::SeqCst);
    bulk.cancel.store(false, Ordering::SeqCst);

    let pool_clone = pool.inner().clone();
    let http_clone = http.inner().clone();
    let cancel_flag = bulk.cancel.clone();
    let running_flag = bulk.running.clone();
    let app_handle = app.clone();
    // Cache dir lazy: lo pedimos sólo si vamos a guardar al menos un cover.
    let cache_dir = app.path().app_cache_dir().ok();

    tauri::async_runtime::spawn(async move {
        let mut counts = MbBackfillCompleted {
            total,
            ..MbBackfillCompleted::default()
        };
        let mut last_request: Option<Instant> = None;

        for (i, (track_id, mbid, existing_cover)) in candidates.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                counts.cancelled = true;
                break;
            }

            // Throttle MB.
            if let Some(prev) = last_request {
                let elapsed = prev.elapsed();
                if elapsed < MB_BACKFILL_MIN_INTERVAL {
                    tokio::time::sleep(MB_BACKFILL_MIN_INTERVAL - elapsed).await;
                }
            }
            last_request = Some(Instant::now());

            // Fetch metadata (un solo request → genre + year + album +
            // release_group_mbid).
            let mb_meta = match musicbrainz::fetch_recording_metadata(&http_clone, mbid).await {
                Ok(meta) => meta,
                Err(e) => {
                    eprintln!("[mb backfill] mb lookup failed for {track_id}: {e}");
                    counts.error += 1;
                    let _ = app_handle.emit(
                        "mb-backfill-progress",
                        MbBackfillProgress {
                            done: i + 1,
                            total,
                            current_track_id: *track_id,
                            last_status: "error".into(),
                        },
                    );
                    continue;
                }
            };

            let any_metadata = mb_meta.genre.is_some()
                || mb_meta.year.is_some()
                || mb_meta.album.is_some();

            // Guardar metadata si MB devolvió al menos un campo. set_mb_metadata
            // ya respeta los campos que el usuario tenía (no pisa con None/empty).
            if any_metadata {
                if let Err(e) = db::tracks::set_mb_metadata(
                    &pool_clone,
                    *track_id,
                    mb_meta.genre.as_deref(),
                    mb_meta.year,
                    mb_meta.album.as_deref(),
                )
                .await
                {
                    eprintln!("[mb backfill] db write failed for {track_id}: {e}");
                    counts.error += 1;
                    let _ = app_handle.emit(
                        "mb-backfill-progress",
                        MbBackfillProgress {
                            done: i + 1,
                            total,
                            current_track_id: *track_id,
                            last_status: "error".into(),
                        },
                    );
                    continue;
                }
            }

            // Cover art via CAA — sólo si no tenía cover Y MB devolvió un
            // release-group ganador. Best-effort: si CAA 404/falla, NO contamos
            // error a nivel del track (la metadata principal ya quedó).
            let mut cover_updated = false;
            if existing_cover.is_none() {
                if let (Some(rg_mbid), Some(cache_root)) = (
                    mb_meta.release_group_mbid.as_deref(),
                    cache_dir.as_deref(),
                ) {
                    match coverartarchive::fetch_front_cover(&http_clone, rg_mbid).await {
                        Ok(Some(cover)) => {
                            let thumbs = cache_root.join("thumbnails");
                            if let Err(e) = std::fs::create_dir_all(&thumbs) {
                                eprintln!("[mb backfill] mkdir thumbs failed: {e}");
                            } else {
                                let out_path =
                                    thumbs.join(format!("{}.{}", track_id, cover.ext));
                                match std::fs::write(&out_path, &cover.bytes) {
                                    Ok(()) => {
                                        if let Err(e) = db::tracks::set_cover_art(
                                            &pool_clone,
                                            *track_id,
                                            Some(&out_path),
                                        )
                                        .await
                                        {
                                            eprintln!(
                                                "[mb backfill] cover db write failed for {track_id}: {e}"
                                            );
                                        } else {
                                            cover_updated = true;
                                            counts.covers_updated += 1;
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "[mb backfill] cover save failed for {track_id}: {e}"
                                        );
                                    }
                                }
                            }
                        }
                        Ok(None) => {} // 404, sin cover en CAA — silent.
                        Err(e) => {
                            eprintln!("[mb backfill] caa fetch failed for {track_id}: {e}");
                        }
                    }
                }
            }

            let status = if any_metadata || cover_updated {
                counts.updated += 1;
                "updated"
            } else {
                counts.no_data += 1;
                "no_data"
            };

            let _ = app_handle.emit(
                "mb-backfill-progress",
                MbBackfillProgress {
                    done: i + 1,
                    total,
                    current_track_id: *track_id,
                    last_status: status.into(),
                },
            );
        }

        running_flag.store(false, Ordering::SeqCst);
        let _ = app_handle.emit("mb-backfill-completed", counts);
    });

    Ok(())
}

#[tauri::command]
pub async fn library_cancel_mb_backfill(
    bulk: State<'_, BulkMbBackfillState>,
) -> AppResult<()> {
    bulk.cancel.store(true, Ordering::SeqCst);
    Ok(())
}
