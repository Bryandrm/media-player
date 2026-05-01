//! Extracción de metadata desde archivos de audio usando `lofty-rs`.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §5.5.

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::*;
use lofty::probe::Probe;
use std::path::{Path, PathBuf};

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

/// Nombres de archivos comunes para cover art al lado del audio (ripeos
/// tradicionales con foobar/EAC/etc).
const SIBLING_COVER_NAMES: &[&str] = &[
    "cover.jpg",
    "cover.png",
    "Cover.jpg",
    "Cover.png",
    "folder.jpg",
    "folder.png",
    "Folder.jpg",
    "Folder.png",
    "front.jpg",
    "front.png",
    "AlbumArt.jpg",
];

/// Extrae cover art de un archivo de audio. Estrategia:
/// 1. Si el archivo tiene picture embebido (mp3 con APIC, FLAC METADATA_BLOCK_PICTURE,
///    m4a covr atom), lo escribe a `<cache_dir>/thumbnails/<track_id>.<ext>`.
/// 2. Si no, busca un cover.jpg / folder.jpg / etc al lado del archivo y
///    devuelve esa ruta directamente (sin copiar — `convertFileSrc` puede
///    leer cualquier path).
/// 3. Si no hay nada, devuelve `Ok(None)`.
pub fn extract_cover_art(
    file_path: &Path,
    track_id: i64,
    cache_dir: &Path,
) -> AppResult<Option<PathBuf>> {
    // 1) Picture embebido vía lofty
    let probe_result = Probe::open(file_path).and_then(|p| p.read());
    if let Ok(tagged_file) = probe_result {
        let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
        if let Some(tag) = tag {
            if let Some(picture) = tag.pictures().first() {
                let ext = picture
                    .mime_type()
                    .and_then(|m| m.ext())
                    .unwrap_or("jpg");
                let thumbs_dir = cache_dir.join("thumbnails");
                std::fs::create_dir_all(&thumbs_dir)?;
                let out_path = thumbs_dir.join(format!("{}.{}", track_id, ext));
                std::fs::write(&out_path, picture.data())?;
                return Ok(Some(out_path));
            }
        }
    }

    // 2) Fallback: sibling cover.jpg / folder.jpg / etc.
    if let Some(parent) = file_path.parent() {
        for name in SIBLING_COVER_NAMES {
            let candidate = parent.join(name);
            if candidate.is_file() {
                return Ok(Some(candidate));
            }
        }
    }

    // 3) Sin cover.
    Ok(None)
}
