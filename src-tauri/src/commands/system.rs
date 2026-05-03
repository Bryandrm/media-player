//! Comandos de sistema: detección de dependencias externas.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §2.2 — yt-dlp + ffmpeg son
//! requisitos del sistema, no se bundlean.

use crate::contracts::DependencyStatus;

/// Devuelve si las deps externas están disponibles en PATH. El frontend
/// muestra un banner por cada faltante y desactiva las features que las
/// requieren (downloader sin yt-dlp/ffmpeg, IDENTIFY sin fpcalc).
#[tauri::command]
pub fn check_dependencies() -> DependencyStatus {
    DependencyStatus {
        yt_dlp: which::which("yt-dlp").is_ok(),
        ffmpeg: which::which("ffmpeg").is_ok(),
        fpcalc: which::which("fpcalc").is_ok(),
    }
}
