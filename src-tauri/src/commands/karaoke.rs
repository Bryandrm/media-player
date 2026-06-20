//! Comando Tauri de karaoke: forced alignment via WhisperX.
//!
//! Un solo comando por ahora (`karaoke_auto_align`). Cuando implementemos
//! Fase B-E (vocal removal, mic, scoring) se suman acá.
//!
//! Ver docs/KARAOKE.md.

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use serde::Serialize;

use crate::errors::{AppError, AppResult};
use crate::karaoke;

/// Default language. Por ahora hardcoded a inglés porque la library del
/// autor es mayormente EN. Cuando agreguemos detección de idioma o un
/// setting per-track, se mueve a parámetro.
const DEFAULT_LANGUAGE: &str = "en";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignResponse {
    pub alignment_score: f64,
}

#[tauri::command]
pub async fn karaoke_auto_align(
    track_id: i64,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<AlignResponse> {
    let script_path = app
        .path()
        .resolve(
            "scripts/karaoke_align.py",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| AppError::Other(format!("resolve karaoke_align.py: {e}")))?;

    if !script_path.exists() {
        return Err(AppError::Other(format!(
            "karaoke_align.py not found at {} — check tauri.conf.json bundle.resources",
            script_path.display()
        )));
    }

    let result =
        karaoke::align_track(pool.inner(), track_id, DEFAULT_LANGUAGE, &script_path).await?;
    Ok(AlignResponse {
        alignment_score: result.alignment_score,
    })
}
