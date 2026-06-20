//! Wrapper sobre el binario `fpcalc` de Chromaprint.
//!
//! `fpcalc` calcula un fingerprint acústico (base64) + la duración decodificada
//! del archivo. Lo invocamos como child process (mismo patrón que yt-dlp/ffmpeg
//! — sin C bindings, sin friction de cross-compile).
//!
//! Output formato `-json`:
//! ```json
//! {"duration": 219.43, "fingerprint": "AQAAYUmSJEoSJYmS..."}
//! ```
//!
//! Diseño:
//!   - `compute` — async, spawnea + parsea. Lo que usa el resto del backend.
//!   - `parse_output` — pura, sin I/O. Para tests con stdout hand-crafted.
//!
//! La duración la usamos del output de fpcalc (no de los tags) porque
//! AcoustID matchea por la duración **decodificada**; un mismatch grande
//! entre tag duration y fpcalc duration sería fuente de falsos negativos.

use std::path::Path;

use serde::Deserialize;
use tokio::process::Command;

use crate::errors::{AppError, AppResult};

/// Resultado exitoso de `fpcalc`. `duration_seconds` es float — fpcalc lo
/// reporta con decimales (ej `219.43`). AcoustID acepta entero, redondeamos
/// al pasarlo.
#[derive(Debug, Clone, PartialEq)]
pub struct Fingerprint {
    pub fingerprint: String,
    pub duration_seconds: f32,
}

#[derive(Deserialize)]
struct FpcalcRawOutput {
    duration: f32,
    fingerprint: String,
}

/// Spawna `fpcalc -json <path>` y devuelve el fingerprint + duración.
///
/// `fpcalc_bin` es la ruta resuelta al binario (bundleado o del sistema).
/// El caller debe resolverla vía `resolve_binary_or_bundled("fpcalc", &app)`.
///
/// Errores:
///   - `Io` si el binario no existe en la ruta dada.
///   - `FpcalcFailed` si `fpcalc` exiteó con status != 0 (archivo corrupto,
///     formato no soportado, etc.). Incluye el stderr para diagnóstico.
///   - `FpcalcParse` si el JSON no matchea la shape esperada (defensa
///     ante un upgrade futuro que cambie el formato — improbable, pero
///     mejor explícito que un panic).
pub async fn compute(fpcalc_bin: &Path, path: &Path) -> AppResult<Fingerprint> {
    let output = Command::new(fpcalc_bin)
        .arg("-json")
        .arg(path)
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::FpcalcFailed(stderr.trim().to_string()));
    }

    parse_output(&output.stdout)
}

/// Parser puro del stdout de `fpcalc -json`. Separado de `compute` para
/// poder testear sin depender del binario externo.
pub fn parse_output(stdout: &[u8]) -> AppResult<Fingerprint> {
    let raw: FpcalcRawOutput = serde_json::from_slice(stdout)
        .map_err(|e| AppError::FpcalcParse(e.to_string()))?;

    if raw.fingerprint.is_empty() {
        return Err(AppError::FpcalcParse(
            "empty fingerprint in fpcalc output".into(),
        ));
    }

    if raw.duration <= 0.0 || !raw.duration.is_finite() {
        return Err(AppError::FpcalcParse(format!(
            "invalid duration in fpcalc output: {}",
            raw.duration
        )));
    }

    Ok(Fingerprint {
        fingerprint: raw.fingerprint,
        duration_seconds: raw.duration,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_output() {
        let stdout = br#"{"duration": 219.43, "fingerprint": "AQAAYUmSJEoSJYmS"}"#;
        let result = parse_output(stdout).expect("parse should succeed");
        assert_eq!(result.fingerprint, "AQAAYUmSJEoSJYmS");
        assert!((result.duration_seconds - 219.43).abs() < 0.01);
    }

    #[test]
    fn parses_integer_duration() {
        // Algunos archivos cortos reportan duration como entero JSON ("180");
        // serde_json acepta ambos para f32.
        let stdout = br#"{"duration": 180, "fingerprint": "ABC"}"#;
        let result = parse_output(stdout).expect("parse should succeed");
        assert_eq!(result.duration_seconds, 180.0);
    }

    #[test]
    fn rejects_empty_fingerprint() {
        let stdout = br#"{"duration": 219.43, "fingerprint": ""}"#;
        let err = parse_output(stdout).expect_err("empty fp should fail");
        assert!(
            matches!(&err, AppError::FpcalcParse(msg) if msg.contains("empty fingerprint")),
            "expected FpcalcParse(empty fingerprint), got {err:?}"
        );
    }

    #[test]
    fn rejects_zero_duration() {
        let stdout = br#"{"duration": 0, "fingerprint": "ABC"}"#;
        let err = parse_output(stdout).expect_err("zero duration should fail");
        assert!(
            matches!(&err, AppError::FpcalcParse(msg) if msg.contains("invalid duration")),
            "expected FpcalcParse(invalid duration), got {err:?}"
        );
    }

    #[test]
    fn rejects_negative_duration() {
        let stdout = br#"{"duration": -5.0, "fingerprint": "ABC"}"#;
        let err = parse_output(stdout).expect_err("negative duration should fail");
        assert!(matches!(err, AppError::FpcalcParse(_)));
    }

    #[test]
    fn rejects_malformed_json() {
        let stdout = b"not json at all";
        let err = parse_output(stdout).expect_err("garbage should fail");
        assert!(matches!(err, AppError::FpcalcParse(_)));
    }

    #[test]
    fn rejects_missing_fields() {
        let stdout = br#"{"duration": 219.43}"#;
        let err = parse_output(stdout).expect_err("missing fingerprint should fail");
        assert!(matches!(err, AppError::FpcalcParse(_)));
    }

    // Integration test contra el binario real: la validación end-to-end
    // se hace manualmente al final, cuando hagamos click en IDENTIFY sobre
    // un track real desde la UI. Habilitar `tokio::test` + `rt` features
    // sólo para un test ignored sería over-engineering — el wrapping de
    // compute() sobre Command::new + parse_output ya está cubierto por
    // los tests unit del parser de arriba.
}
