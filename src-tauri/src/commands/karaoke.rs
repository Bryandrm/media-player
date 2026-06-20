//! Comandos Tauri de karaoke: forced alignment + mismatch detection.
//!
//! Ver docs/KARAOKE.md.

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use serde::Serialize;

use crate::errors::{AppError, AppResult};
use crate::karaoke;

/// Default language para forced alignment. WhisperX necesita el idioma para
/// cargar el modelo de alignment correcto (wav2vec2 por idioma).
const DEFAULT_ALIGN_LANGUAGE: &str = "auto";

/// Language para mismatch detection (transcripción). "auto" deja que whisperx
/// detecte el idioma del audio automáticamente — crucial para libraries
/// multilingües donde un hardcode a "en" produciría transcripciones basura.
const MISMATCH_LANGUAGE: &str = "auto";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignResponse {
    pub alignment_score: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MismatchResponse {
    pub overall_score: f64,
    pub lines: Vec<MismatchLineResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MismatchLineResponse {
    pub index: usize,
    pub timestamp_ms: u64,
    pub lrc_text: String,
    pub transcribed_text: String,
    pub lrc_phonemes: String,
    pub transcribed_phonemes: String,
    pub score: f64,
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
        karaoke::align_track(pool.inner(), track_id, DEFAULT_ALIGN_LANGUAGE, &script_path).await?;
    Ok(AlignResponse {
        alignment_score: result.alignment_score,
    })
}

#[tauri::command]
pub async fn karaoke_detect_mismatch(
    track_id: i64,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<MismatchResponse> {
    let script_path = app
        .path()
        .resolve(
            "scripts/mismatch_detect.py",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| AppError::Other(format!("resolve mismatch_detect.py: {e}")))?;

    if !script_path.exists() {
        return Err(AppError::Other(format!(
            "mismatch_detect.py not found at {} — check tauri.conf.json bundle.resources",
            script_path.display()
        )));
    }

    let result =
        karaoke::detect_mismatch(pool.inner(), track_id, MISMATCH_LANGUAGE, &script_path)
            .await?;

    Ok(MismatchResponse {
        overall_score: result.overall_score,
        lines: result
            .lines
            .into_iter()
            .map(|l| MismatchLineResponse {
                index: l.index,
                timestamp_ms: l.timestamp_ms,
                lrc_text: l.lrc_text,
                transcribed_text: l.transcribed_text,
                lrc_phonemes: l.lrc_phonemes,
                transcribed_phonemes: l.transcribed_phonemes,
                score: l.score,
            })
            .collect(),
    })
}
