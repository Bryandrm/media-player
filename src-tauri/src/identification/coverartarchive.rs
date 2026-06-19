//! Cliente para Cover Art Archive (CAA), el repositorio de portadas
//! oficial vinculado a MusicBrainz.
//!
//! Endpoint: `GET https://coverartarchive.org/release-group/{mbid}/front`
//!
//! Responde:
//!   - 307 redirect a la imagen real (típicamente en archive.org). reqwest
//!     sigue redirects por default — recibimos el body directo.
//!   - 404 cuando no hay portada para ese release-group. Se trata como
//!     "no cover available", no como error.
//!   - 503 cuando CAA está sobrecargado (raro, pero ocurre) — sí lo
//!     propagamos como error retriable.
//!
//! Endpoints alternativos:
//!   - `/release-group/{mbid}/front-500` o `-250` para thumbnails — no los
//!     usamos porque queremos calidad máxima (la guardamos local una sola
//!     vez, el costo es one-shot).
//!   - `/release/{mbid}/front` por release individual — más granular pero el
//!     release-group suele tener la misma portada y es más estable.
//!
//! Rate limit: CAA no documenta cap explícito pero pide no agredir. El
//! caller integra esta llamada dentro del throttle de MusicBrainz (1 req/s),
//! así que en práctica nunca pasamos de 1 cover/sec.

use crate::errors::{AppError, AppResult};

const ENDPOINT_PREFIX: &str = "https://coverartarchive.org/release-group";

/// Resultado de `fetch_front_cover`.
pub struct FrontCover {
    pub bytes: Vec<u8>,
    /// Extensión sugerida (`"jpg"` o `"png"`) derivada del Content-Type. Si
    /// CAA no devolvió header válido, default `"jpg"` (la mayoría son JPEG).
    pub ext: &'static str,
}

/// Descarga la portada frontal de un release-group de Cover Art Archive.
///
/// Retorna:
///   - `Ok(Some(FrontCover))` cuando hay portada y se descargó.
///   - `Ok(None)` cuando CAA respondió 404 (no hay portada disponible).
///   - `Err(_)` para fallas de red, 503 server-busy o body inválido.
pub async fn fetch_front_cover(
    http: &reqwest::Client,
    release_group_mbid: &str,
) -> AppResult<Option<FrontCover>> {
    let url = format!("{ENDPOINT_PREFIX}/{release_group_mbid}/front");

    let response = http.get(&url).send().await?;

    // 404 = no hay portada en CAA para este release-group. Caso muy común
    // (covertura de CAA depende de uploads voluntarios de la comunidad).
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "coverartarchive {} for rg {}",
            response.status(),
            release_group_mbid
        )));
    }

    // Sniffer simple del content-type para elegir extensión. Si el header
    // es PNG → guardamos como .png; cualquier otra cosa (jpeg, jpg, default)
    // → .jpg. Otros formatos (webp, gif) son raros para portadas y los
    // tratamos como jpg también.
    let ext: &'static str = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.to_ascii_lowercase())
        .and_then(|ct| {
            if ct.contains("png") {
                Some("png")
            } else if ct.contains("jpeg") || ct.contains("jpg") {
                Some("jpg")
            } else {
                None
            }
        })
        .unwrap_or("jpg");

    let bytes = response.bytes().await?.to_vec();
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(FrontCover { bytes, ext }))
}
