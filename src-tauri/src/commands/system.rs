//! Comandos de sistema: detección de dependencias externas.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §2.2 — yt-dlp + ffmpeg son
//! requisitos del sistema, no se bundlean.

use crate::contracts::DependencyStatus;

/// Devuelve si yt-dlp y ffmpeg están disponibles en PATH. El frontend muestra
/// un banner si falta alguno y desactiva el tab de descargas.
#[tauri::command]
pub fn check_dependencies() -> DependencyStatus {
    DependencyStatus {
        yt_dlp: which::which("yt-dlp").is_ok(),
        ffmpeg: which::which("ffmpeg").is_ok(),
    }
}
