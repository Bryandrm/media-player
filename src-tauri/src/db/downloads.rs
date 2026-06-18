//! Queries sobre la tabla `downloads` — history persistente (ADR-011 chunk 2).
//!
//! El downloader inserta una fila al arrancar (`insert`, status 'downloading')
//! y la actualiza al terminar (`finish`, estado terminal + title/error/track).
//! El id de la fila pasa a ser el `download_id` de los eventos (reemplaza el
//! contador en memoria). El frontend carga el historial al boot con
//! `list_recent`.

use sqlx::SqlitePool;

use crate::contracts::{Download, DownloadStatus};
use crate::errors::AppResult;

/// Inserta una descarga nueva (status 'downloading', progress -1 = indeterminado)
/// y devuelve su id autogenerado.
pub async fn insert(pool: &SqlitePool, url: &str) -> AppResult<i64> {
    let res = sqlx::query(
        "INSERT INTO downloads (url, status, progress) VALUES (?, 'downloading', -1)",
    )
    .bind(url)
    .execute(pool)
    .await?;
    Ok(res.last_insert_rowid())
}

/// Actualiza la fila con el estado final (completed/failed/skipped) +
/// title/error/track_id + `completed_at`. Toma el `Download` que el comando ya
/// construye al terminar.
pub async fn finish(pool: &SqlitePool, d: &Download) -> AppResult<()> {
    sqlx::query(
        "UPDATE downloads SET status = ?, progress = ?, title = ?, error_message = ?, \
         track_id = ?, playlist_id = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(status_str(&d.status))
    .bind(d.progress)
    .bind(d.title.as_deref())
    .bind(d.error.as_deref())
    .bind(d.track_id)
    .bind(d.playlist_id)
    .bind(d.id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Lista las descargas más recientes (para poblar el historial al boot).
/// Orden: más nuevas primero.
pub async fn list_recent(pool: &SqlitePool, limit: i64) -> AppResult<Vec<Download>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        i64,
        String,
        String,
        f32,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<i64>,
    )> = sqlx::query_as(
        "SELECT id, url, status, progress, title, error_message, track_id, \
                strftime('%Y-%m-%dT%H:%M:%SZ', completed_at) AS completed_at, playlist_id \
         FROM downloads ORDER BY started_at DESC, id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, url, status, progress, title, error, track_id, completed_at, playlist_id)| {
                Download {
                    id,
                    url,
                    status: parse_status(&status),
                    progress,
                    title,
                    error,
                    track_id,
                    completed_at,
                    playlist_id,
                }
            },
        )
        .collect())
}

/// Borra las descargas terminales (no toca una en curso). Usado por CLEAR.
pub async fn clear_terminal(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("DELETE FROM downloads WHERE status IN ('completed', 'failed', 'skipped')")
        .execute(pool)
        .await?;
    Ok(())
}

/// Borra una descarga puntual (botón ✕ de la fila).
pub async fn delete(pool: &SqlitePool, id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM downloads WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

fn status_str(s: &DownloadStatus) -> &'static str {
    match s {
        DownloadStatus::Queued => "queued",
        DownloadStatus::Downloading => "downloading",
        DownloadStatus::Postprocessing => "postprocessing",
        DownloadStatus::Completed => "completed",
        DownloadStatus::Failed => "failed",
        DownloadStatus::Skipped => "skipped",
        DownloadStatus::Cancelled => "cancelled",
    }
}

fn parse_status(s: &str) -> DownloadStatus {
    match s {
        "queued" => DownloadStatus::Queued,
        "downloading" => DownloadStatus::Downloading,
        "postprocessing" => DownloadStatus::Postprocessing,
        "completed" => DownloadStatus::Completed,
        "skipped" => DownloadStatus::Skipped,
        "cancelled" => DownloadStatus::Cancelled,
        // 'failed' + cualquier valor inesperado caen acá.
        _ => DownloadStatus::Failed,
    }
}
