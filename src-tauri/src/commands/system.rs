//! Comandos de sistema: detección de dependencias externas.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §2.2 — yt-dlp + ffmpeg son
//! requisitos del sistema, no se bundlean.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

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
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    // `mut` sólo se usa bajo #[cfg(windows)] (los push de abajo); en macOS/Linux
    // queda inmutable → silenciamos el unused_mut ahí en vez de duplicar el vec.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut candidates = vec![
        format!("{}/.local/bin/{}", home, name),
        "/usr/local/bin".to_string() + "/" + name,
        "/opt/homebrew/bin".to_string() + "/" + name,
    ];
    #[cfg(windows)]
    {
        candidates.push(format!("{}\\.local\\bin\\{}.exe", home, name));
        candidates.push(format!("{}\\AppData\\Local\\Microsoft\\WinGet\\Packages\\espeak-ng\\espeak-ng.exe", home));
    }
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// Resuelve un binario buscando primero en los resources bundleados de Tauri
/// (`bin/<name>.exe` en Windows, `bin/<name>` en Unix) y cayendo a
/// `resolve_binary` (system PATH + fallback locations) si no está bundleado.
pub fn resolve_binary_or_bundled(name: &str, app: &AppHandle) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) {
        format!("bin/{name}.exe")
    } else {
        format!("bin/{name}")
    };
    if let Ok(p) = app.path().resolve(&bin_name, tauri::path::BaseDirectory::Resource) {
        if p.is_file() {
            return Some(p);
        }
    }
    resolve_binary(name)
}

/// Detecta la shared library de espeak-ng que `phonemizer` necesita para
/// convertir texto a fonemas IPA. phonemizer busca la **library** (.dll/.so),
/// no el ejecutable CLI. En Windows la instalación estándar deja la DLL en
/// `%ProgramFiles%\eSpeak NG\libespeak-ng.dll`. En Unix se busca en los
/// paths estándar de shared libraries.
pub fn resolve_espeak_ng_library() -> bool {
    #[cfg(windows)]
    {
        let pf = std::env::var("ProgramFiles")
            .unwrap_or_else(|_| r"C:\Program Files".to_string());
        let dll = std::path::PathBuf::from(&pf)
            .join("eSpeak NG")
            .join("libespeak-ng.dll");
        if dll.is_file() {
            return true;
        }
        let pf86 = std::env::var("ProgramFiles(x86)")
            .unwrap_or_else(|_| r"C:\Program Files (x86)".to_string());
        let dll86 = std::path::PathBuf::from(&pf86)
            .join("eSpeak NG")
            .join("libespeak-ng.dll");
        if dll86.is_file() {
            return true;
        }
        if let Ok(env_lib) = std::env::var("PHONEMIZER_ESPEAK_LIBRARY") {
            if std::path::PathBuf::from(&env_lib).is_file() {
                return true;
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        if let Ok(env_lib) = std::env::var("PHONEMIZER_ESPEAK_LIBRARY") {
            if std::path::PathBuf::from(&env_lib).is_file() {
                return true;
            }
        }
        let candidates = [
            "/usr/lib/libespeak-ng.so",
            "/usr/lib/x86_64-linux-gnu/libespeak-ng.so",
            "/usr/local/lib/libespeak-ng.so",
            "/opt/homebrew/lib/libespeak-ng.dylib",
            "/usr/local/lib/libespeak-ng.dylib",
        ];
        candidates.iter().any(|p| std::path::Path::new(p).is_file())
    }
}

/// Devuelve si las deps externas están disponibles. El frontend muestra
/// un banner por cada faltante y desactiva las features que las requieren
/// (downloader sin yt-dlp/ffmpeg, IDENTIFY sin fpcalc, AUTO-ALIGN sin whisperx).
#[tauri::command]
pub fn check_dependencies(app: AppHandle) -> DependencyStatus {
    DependencyStatus {
        yt_dlp: resolve_binary("yt-dlp").is_some(),
        ffmpeg: resolve_binary("ffmpeg").is_some(),
        fpcalc: resolve_binary_or_bundled("fpcalc", &app).is_some(),
        whisperx: resolve_binary("whisperx").is_some(),
        espeak_ng: resolve_espeak_ng_library(),
    }
}
