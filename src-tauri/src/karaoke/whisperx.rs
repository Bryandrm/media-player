//! Wrapper sobre el binario WhisperX en modo align-only.
//!
//! No usamos la CLI de whisperx (no expone "skip transcription") sino su
//! Python API vía un script wrapper shippeado como Tauri resource. Esta
//! capa Rust:
//!   1. Encuentra el `python` del venv que pipx creó para whisperx.
//!   2. Spawnea el script con (audio, segments_json, output_path, language).
//!   3. Parsea el JSON output a `Vec<WordTiming>`.
//!
//! Los timestamps van en SEGUNDOS (no ms) porque la Python API de whisperx
//! trabaja en segundos. La conversión a ms la hace el caller.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::errors::{AppError, AppResult};

/// Segmento que enviamos a WhisperX. Bounds en segundos (whisperx los
/// quiere así). Cada segmento corresponde a una línea del LRC original —
/// pasarle line-level bounds en vez de un único `[0, dur]` da mejor
/// alignment porque limita errores within-line.
#[derive(Debug, Clone, Serialize)]
pub struct AlignSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Word timing devuelto por whisperx. `start`/`end` en segundos.
/// `score` es la confianza del alignment (0..1) — útil para futura UI
/// que muestre tracks con calidad dudosa.
///
/// `word` y `end` no se leen en build_a2_lrc (usamos las palabras del LRC
/// original para preservar texto exacto, y sólo el `start` para el
/// timestamp A2). Los mantenemos en el struct para tener la info disponible
/// para extensions futuras (ej Fase B karaoke fullscreen mostrando la
/// confianza per-palabra).
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct WordTiming {
    pub word: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub score: f64,
}

#[derive(Deserialize)]
struct WrapperOutput {
    word_segments: Vec<WordTiming>,
}

/// Encuentra el `python` del venv de pipx donde está whisperx instalado.
/// Asume el layout estándar de pipx: `~/.local/bin/whisperx` es un symlink
/// (o script-shim) que apunta al binary del venv. Resolvemos el symlink y
/// subimos un nivel para encontrar el `python` hermano.
///
/// Usa `commands::system::resolve_binary` que tiene fallback para PATH no
/// inherited (issue conocido en macOS con cargo/pnpm spawned processes).
///
/// Si pipx cambia su layout en el futuro, esto puede romperse — fallback
/// posible: parsear el shebang del script de whisperx.
fn find_python_for_whisperx() -> AppResult<std::path::PathBuf> {
    let whisperx_bin = crate::commands::system::resolve_binary("whisperx")
        .ok_or(AppError::WhisperxMissing)?;
    // canonicalize sigue symlinks. Útil en pipx donde ~/.local/bin/whisperx
    // típicamente apunta a ~/.local/pipx/venvs/whisperx/bin/whisperx.
    let resolved = std::fs::canonicalize(&whisperx_bin).unwrap_or(whisperx_bin);
    let bin_dir = resolved
        .parent()
        .ok_or_else(|| AppError::Other("whisperx path has no parent".into()))?;
    let python = bin_dir.join("python");
    if !python.exists() {
        // Algunos layouts tienen `python3` en vez de `python`.
        let python3 = bin_dir.join("python3");
        if python3.exists() {
            return Ok(python3);
        }
        return Err(AppError::Other(format!(
            "no python in whisperx venv bin dir: {}",
            bin_dir.display()
        )));
    }
    Ok(python)
}

/// Llama al wrapper Python y devuelve los word timings.
pub async fn align(
    audio_path: &Path,
    segments: &[AlignSegment],
    language: &str,
    script_path: &Path,
) -> AppResult<Vec<WordTiming>> {
    let python_bin = find_python_for_whisperx()?;

    let tmpdir = tempfile::tempdir()
        .map_err(|e| AppError::Other(format!("tempdir: {e}")))?;
    let segments_path = tmpdir.path().join("segments.json");
    let output_path = tmpdir.path().join("aligned.json");

    let segments_json = serde_json::to_string_pretty(segments)
        .map_err(|e| AppError::Other(format!("serialize segments: {e}")))?;
    std::fs::write(&segments_path, &segments_json)?;

    // DEBUG: dejar copia del JSON enviado para inspección post-mortem.
    // El tempdir se borra al return. Esta copia persiste hasta el próximo
    // realign. Útil para verificar que los bounds llegaron bien a whisperx.
    let debug_path = std::env::temp_dir().join("karaoke_debug_segments.json");
    let _ = std::fs::write(&debug_path, &segments_json);

    eprintln!(
        "[karaoke] aligning {} segments via {} (lang={})",
        segments.len(),
        script_path.display(),
        language
    );
    eprintln!("[karaoke] debug: segments dumped to {}", debug_path.display());
    // Print primeros 3 segmentos para tener visibilidad inmediata en stdout.
    for (i, seg) in segments.iter().take(3).enumerate() {
        eprintln!(
            "[karaoke]   seg[{}] start={:.2}s end={:.2}s text={:?}",
            i, seg.start, seg.end, seg.text
        );
    }

    let output = Command::new(&python_bin)
        .arg(script_path)
        .arg(audio_path)
        .arg(&segments_path)
        .arg(&output_path)
        .arg(language)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    // El wrapper escribe progreso a stderr; lo logueamos siempre para
    // debug, sea exit success o fail.
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.is_empty() {
        eprintln!("[karaoke] whisperx stderr:\n{}", stderr.trim());
    }

    if !output.status.success() {
        return Err(AppError::WhisperxFailed(stderr.trim().to_string()));
    }

    let json = std::fs::read_to_string(&output_path)?;
    let parsed: WrapperOutput = serde_json::from_str(&json)
        .map_err(|e| AppError::WhisperxParse(e.to_string()))?;

    eprintln!("[karaoke] received {} word timings", parsed.word_segments.len());
    Ok(parsed.word_segments)
}
