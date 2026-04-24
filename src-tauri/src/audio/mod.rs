//! Extracción de metadata desde archivos de audio usando `lofty-rs`.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §5.5.

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::*;
use lofty::probe::Probe;
use std::path::Path;

use crate::errors::{AppError, AppResult};

/// Metadata cruda extraída de un archivo. Lo que `db::tracks::insert` necesita
/// para poblar una fila, sin incluir campos derivados del filesystem
/// (`file_path`, `source_type`, etc. — esos los rellena la capa de commands).
#[derive(Debug, Clone)]
pub struct TrackMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: i64,
    pub track_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub format: Option<String>,
}

/// Extensiones que consideramos "audio" para el scanner.
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "wav", "m4a", "opus", "ogg", "aac"];

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Lee tags y propiedades de audio de un archivo. Si no hay tags, usa el
/// nombre del archivo como título y deja el resto en `None`.
pub fn extract_metadata(path: &Path) -> AppResult<TrackMetadata> {
    let tagged_file = Probe::open(path)
        .map_err(|e| AppError::Other(format!("probe failed for {}: {}", path.display(), e)))?
        .read()
        .map_err(|e| AppError::Other(format!("read failed for {}: {}", path.display(), e)))?;

    let properties = tagged_file.properties();
    let duration_ms = properties.duration().as_millis() as i64;
    let bitrate = properties.audio_bitrate().map(|b| b as i64);
    let sample_rate = properties.sample_rate().map(|s| s as i64);

    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    // Preferimos primary_tag (el "canónico" del contenedor) y caemos a first_tag.
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    let title = tag
        .and_then(|t| t.title())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string()
        });

    let artist = tag.and_then(|t| t.artist()).map(|s| s.to_string());
    let album = tag.and_then(|t| t.album()).map(|s| s.to_string());
    let genre = tag.and_then(|t| t.genre()).map(|s| s.to_string());
    let track_number = tag.and_then(|t| t.track()).map(|n| n as i64);
    let year = tag.and_then(|t| t.year()).map(|y| y as i64);

    Ok(TrackMetadata {
        title,
        artist,
        album,
        duration_ms,
        track_number,
        year,
        genre,
        bitrate,
        sample_rate,
        format,
    })
}
