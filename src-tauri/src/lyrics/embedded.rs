//! Provider de letras embebidas en los tags del archivo. ID3v2 USLT (unsynced
//! lyrics) y equivalentes en otros containers, leídos via `lofty`.
//!
//! Fase 1: sólo plain (USLT). SYLT (synced embebido) requiere parsing
//! binario del frame y queda para Fase 2 — la mayoría de archivos con
//! letras embebidas tienen USLT, no SYLT.

use std::path::Path;

use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use lofty::tag::ItemKey;

use crate::contracts::Lyrics;
use crate::errors::AppResult;

/// Lee `ItemKey::Lyrics` (USLT en ID3v2, lyrics tag en Vorbis Comments, etc).
/// Devuelve `Some` si el tag tiene contenido no-vacío, `None` en cualquier
/// otro caso (sin tag, sin lyrics, error de probe).
pub fn try_embedded(track_id: i64, file_path: &Path) -> AppResult<Option<Lyrics>> {
    let probe_result = Probe::open(file_path).and_then(|p| p.read());
    let Ok(tagged_file) = probe_result else {
        // Probe falla en archivos corruptos o formatos no soportados — no
        // es nuestro problema acá, dejamos que LRCLIB intente.
        return Ok(None);
    };

    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());
    let Some(tag) = tag else { return Ok(None); };

    let plain = tag.get_string(&ItemKey::Lyrics).map(str::to_string);

    let plain = match plain {
        Some(s) if !s.trim().is_empty() => s,
        _ => return Ok(None),
    };

    Ok(Some(Lyrics {
        track_id,
        synced_lyrics: None,
        plain_lyrics: Some(plain),
        source: Some("embedded".to_string()),
        source_id: None,
        confidence: Some(1.0), // tag embebido = correspondencia 1:1 con el track
        offset_ms: 0,
        speed_ratio: 1.0, // embedded = mismo audio = sin drift por definición
        status: "found".to_string(),
    }))
}
