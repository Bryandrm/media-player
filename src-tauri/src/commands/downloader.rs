//! Comando Tauri del downloader: orquesta yt-dlp + extracción de metadata +
//! inserción en `tracks`. Emite eventos para que la UI muestre progreso en
//! tiempo real.
//!
//! Notas de diseño:
//! - El ID de descarga es un contador en memoria. Por ahora no persistimos a
//!   la tabla `downloads` — esto es chunk 1, history persistente queda para
//!   un follow-up.
//! - Idempotencia: yt-dlp corre con `--no-overwrites`. Si el archivo final
//!   ya existía en disco, marcamos `Skipped` (la fila en `tracks` ya está;
//!   `insert_from_metadata` es no-op gracias a `ON CONFLICT DO NOTHING`).

use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio;
use crate::contracts::{Download, DownloadStatus};
use crate::db;
use crate::downloader::{self, DownloadEvent};
use crate::errors::{AppError, AppResult};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    download_id: i64,
    progress: f32,
}

static NEXT_DOWNLOAD_ID: AtomicI64 = AtomicI64::new(1);

#[tauri::command]
pub async fn download_track(
    url: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<Download> {
    let download_id = NEXT_DOWNLOAD_ID.fetch_add(1, Ordering::SeqCst);

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
        },
    );

    // Closure de eventos: emite progress updates y la transición a postprocess.
    // `postprocess_emitted` deduplica — yt-dlp imprime varios `[ExtractAudio]`,
    // `[Metadata]`, `[EmbedThumbnail]`; sólo queremos un cambio de estado.
    let app_for_event = app.clone();
    let url_for_event = url.clone();
    let mut postprocess_emitted = false;
    let result = downloader::run_yt_dlp(&url, &library_dir, move |evt| match evt {
        DownloadEvent::Progress(fraction) => {
            let _ = app_for_event.emit(
                "download-progress",
                ProgressEvent {
                    download_id,
                    progress: fraction,
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
                },
            );
        }
    })
    .await;

    match result {
        Ok(file_path) => {
            let pool_ref = pool.inner();

            let meta = audio::extract_metadata(&file_path)
                .map_err(|e| AppError::Other(format!("metadata read failed: {}", e)))?;
            // Cleanup heurístico: yt-dlp escribe metadata desde YouTube que
            // viene con artefactos (artist="X - Topic", title="Y (Official
            // Video)"). LRCLIB hace match exacto contra (artist, title), así
            // que un sufijo de más basta para 404 aunque el track esté
            // indexado. La cleanup es conservadora — sólo strip-ea patrones
            // claramente-yt-dlp, no contenido legítimo. Ver audio/cleanup.rs.
            let meta = audio::cleanup::cleanup_metadata(meta);
            let title = meta.title.clone();

            let inserted_id = db::tracks::insert_from_metadata(
                pool_ref,
                &file_path,
                meta,
                "downloaded",
                Some(&url),
            )
            .await?;

            // Si insertó nuevo, extraemos el cover art (yt-dlp ya embebió el
            // thumbnail con `--embed-thumbnail`, así que casi siempre va a
            // haber). Si era re-download (skipped), no tocamos el cover
            // existente.
            let (status, track_id) = match inserted_id {
                Some(id) => {
                    let cache_dir = app
                        .path()
                        .app_cache_dir()
                        .map_err(|e| AppError::Other(format!("cache dir unavailable: {}", e)))?;
                    if let Ok(Some(cover_path)) =
                        audio::extract_cover_art(&file_path, id, &cache_dir)
                    {
                        let _ = db::tracks::set_cover_art(pool_ref, id, Some(&cover_path)).await;
                    }
                    (DownloadStatus::Completed, Some(id))
                }
                None => {
                    let id = db::tracks::find_id_by_path(pool_ref, &file_path).await?;
                    (DownloadStatus::Skipped, id)
                }
            };

            let download = Download {
                id: download_id,
                url,
                status,
                progress: 1.0,
                title: Some(title),
                error: None,
                track_id,
            };
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
            };
            let _ = app.emit("download-failed", download.clone());
            Err(AppError::Other(error_msg))
        }
    }
}
