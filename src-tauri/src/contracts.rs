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
    /// Ruta absoluta a la imagen de cover. Puede apuntar al cache
    /// (`<app_cache>/thumbnails/<id>.jpg`) o a un sibling como `cover.jpg`
    /// dentro de la carpeta del track. NULL si no encontramos nada.
    pub cover_art_path: Option<String>,
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

/// Estado de las dependencias externas (yt-dlp, ffmpeg). Detectadas al boot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub yt_dlp: bool,
    pub ffmpeg: bool,
}

/// Estados terminales o transitorios de una descarga, espejado en la columna
/// `downloads.status` de la DB.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Postprocessing,
    Completed,
    Failed,
    Skipped, // archivo ya existía en disco — no se re-bajó
}

/// Snapshot de una descarga. Lo que el frontend recibe en la lista del store
/// y en los eventos `download-*`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: i64,
    pub url: String,
    pub status: DownloadStatus,
    /// 0.0 a 1.0; -1 si yt-dlp aún no reporta total bytes (live streams, etc.).
    pub progress: f32,
    pub title: Option<String>,
    pub error: Option<String>,
    pub track_id: Option<i64>,
}
