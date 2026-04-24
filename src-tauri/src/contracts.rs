//! Tipos compartidos con el frontend — serializados vía `invoke()` y eventos.
//!
//! Regla: cualquier tipo que cruce la frontera Rust ↔ TS vive acá.
//! Los módulos de dominio (`db`, `audio`, etc.) los importan.

use serde::{Deserialize, Serialize};

/// Un track en la biblioteca. Refleja la tabla `tracks` pero con sólo los
/// campos que el frontend necesita para listar y reproducir — no es 1:1.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub file_path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: i64,
    pub track_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub format: Option<String>,
}

/// Reporte de un scan de directorio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned: usize,
    pub inserted: usize,
    pub skipped: usize,
    pub errors: usize,
}
