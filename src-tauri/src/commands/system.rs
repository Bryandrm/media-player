//! Comandos de sistema: detección de dependencias externas.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §2.2 — yt-dlp + ffmpeg son
//! requisitos del sistema, no se bundlean.

use std::path::PathBuf;

use crate::contracts::DependencyStatus;

/// Resuelve la ruta a un binario externo. Primero intenta `which::which`
/// (usa PATH); si falla, chequea ubicaciones comunes en macOS/Linux
/// (`~/.local/bin/`, `/usr/local/bin/`, `/opt/homebrew/bin/`).
///
/// Por qué el fallback: el proceso Tauri lanzado vía `cargo run` a veces
/// no hereda el PATH completo del shell del usuario en macOS. Especialmente
/// `~/.local/bin/` (donde pipx pone los binaries) suele faltar. El
/// fallback hace la detección robusta sin depender de la herencia de PATH.
pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    let home = std::env::var("HOME").ok()?;
    let candidates = [
        format!("{}/.local/bin/{}", home, name),
        "/usr/local/bin".to_string() + "/" + name,
        "/opt/homebrew/bin".to_string() + "/" + name,
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// Devuelve si las deps externas están disponibles. El frontend muestra
/// un banner por cada faltante y desactiva las features que las requieren
/// (downloader sin yt-dlp/ffmpeg, IDENTIFY sin fpcalc, AUTO-ALIGN sin whisperx).
#[tauri::command]
pub fn check_dependencies() -> DependencyStatus {
    DependencyStatus {
        yt_dlp: resolve_binary("yt-dlp").is_some(),
        ffmpeg: resolve_binary("ffmpeg").is_some(),
        fpcalc: resolve_binary("fpcalc").is_some(),
        whisperx: resolve_binary("whisperx").is_some(),
    }
}
