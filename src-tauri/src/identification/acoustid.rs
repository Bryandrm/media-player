//! Cliente HTTP de la API de AcoustID.
//!
//! Endpoint: `GET https://api.acoustid.org/v2/lookup`
//! Docs:    https://acoustid.org/webservice
//!
//! Recibe un fingerprint (de fpcalc) + duración + API key del usuario;
//! devuelve, si hay match con score >= threshold, el MBID de MusicBrainz +
//! metadata canónica (title, artist).
//!
//! Diseño:
//!   - `lookup` — async, HTTP + parse. Lo que usa el cascade.
//!   - `parse_response` — pura, sin red. Para tests con JSON hand-crafted
//!     (mismo patrón que `fpcalc::parse_output`, evita agregar deps de HTTP
//!     mocking sólo para esto).
//!
//! El threshold de score (0.85) está en el caller, no acá — esta capa
//! devuelve **el mejor match** que haya y deja que `identify_track` decida
//! si lo acepta o lo marca como `low_confidence`.

use serde::Deserialize;

use crate::errors::{AppError, AppResult};

const ENDPOINT: &str = "https://api.acoustid.org/v2/lookup";

/// Match aceptado de AcoustID. Devuelto sólo si hubo al menos un result con
/// `recordings` no vacío. Multiple recordings dentro de un result representan
/// la misma grabación en distintos releases (mismo MBID o MBIDs distintos
/// según la cobertura de MB) — tomamos el primero con MBID no vacío.
#[derive(Debug, Clone, PartialEq)]
pub struct AcoustIdMatch {
    pub score: f64,
    pub acoustid_id: String,
    pub mbid: String,
    pub title: String,
    pub artist: String,
}

// Shapes de la respuesta JSON. Todos los campos string nullable porque
// AcoustID a veces devuelve recordings con metadata incompleta (recording
// existe en MB pero sin title o sin artists todavía).

#[derive(Deserialize)]
struct RawResponse {
    status: String,
    #[serde(default)]
    results: Vec<RawResult>,
    #[serde(default)]
    error: Option<RawError>,
}

#[derive(Deserialize)]
struct RawResult {
    id: String,
    score: f64,
    #[serde(default)]
    recordings: Vec<RawRecording>,
}

#[derive(Deserialize)]
struct RawRecording {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    artists: Option<Vec<RawArtist>>,
}

#[derive(Deserialize)]
struct RawArtist {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawError {
    #[serde(default)]
    message: Option<String>,
    // Código de error de AcoustID. El 4 es "invalid API key" — lo tratamos
    // distinto (AcoustIdInvalidKey) para que el frontend reabra el modal.
    #[serde(default)]
    code: Option<i64>,
}

/// Código de AcoustID para "invalid API key".
const ACOUSTID_ERR_INVALID_KEY: i64 = 4;

/// Llama a AcoustID `/v2/lookup` y devuelve el mejor match disponible
/// (mayor `score` con al menos un recording que tenga MBID). `Ok(None)` si
/// la API respondió pero no encontró ningún match utilizable.
pub async fn lookup(
    http: &reqwest::Client,
    api_key: &str,
    fingerprint: &str,
    duration_seconds: f32,
) -> AppResult<Option<AcoustIdMatch>> {
    // AcoustID quiere duración entera en segundos (la query rechaza floats).
    // round() es importante: truncar 219.6 a 219 puede caer fuera del rango
    // de tolerancia que AcoustID usa internamente (~7s).
    let duration_int = duration_seconds.round() as u32;

    let response = http
        .get(ENDPOINT)
        .query(&[
            ("client", api_key),
            ("format", "json"),
            ("duration", &duration_int.to_string()),
            ("fingerprint", fingerprint),
            // `recordings` incluye el MBID + title + artists. Sin este meta,
            // AcoustID sólo devuelve sus propios IDs.
            ("meta", "recordings"),
        ])
        .send()
        .await?;

    // NO usamos `error_for_status()`: AcoustID manda el detalle del error en el
    // body JSON incluso con 400 (ej `{"error":{"code":4,"message":"invalid API
    // key"}}`). Si cortáramos por el status code perderíamos ese mensaje y
    // tendríamos sólo "400 Bad Request". Parseamos el body siempre.
    let body = response.bytes().await?;
    parse_response(&body)
}

/// Parser puro. Devuelve `Ok(None)` si la API respondió ok pero sin
/// matches utilizables; `Err(AcoustIdApi)` si la API reportó error o el
/// JSON está malformado.
pub fn parse_response(body: &[u8]) -> AppResult<Option<AcoustIdMatch>> {
    let raw: RawResponse = serde_json::from_slice(body)
        .map_err(|e| AppError::AcoustIdApi(format!("invalid response JSON: {e}")))?;

    if raw.status != "ok" {
        // Key inválida (código 4) → error tipado para que el frontend reabra
        // el modal. Cualquier otro error → AcoustIdApi con el mensaje real.
        if let Some(err) = &raw.error {
            if err.code == Some(ACOUSTID_ERR_INVALID_KEY) {
                return Err(AppError::AcoustIdInvalidKey);
            }
        }
        let msg = raw
            .error
            .and_then(|e| e.message)
            .unwrap_or_else(|| format!("status={}", raw.status));
        return Err(AppError::AcoustIdApi(msg));
    }

    // Buscar el result con mayor score que tenga al menos un recording con
    // MBID no vacío. AcoustID puede devolver results sin recordings (su DB
    // conoce el fingerprint pero no está linkeado a MB) — esos los saltamos.
    let best = raw
        .results
        .into_iter()
        .filter_map(|r| {
            let recording = r.recordings.into_iter().find(|rc| !rc.id.is_empty())?;
            Some((r.score, r.id, recording))
        })
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    Ok(best.map(|(score, acoustid_id, rec)| {
        let artist = rec
            .artists
            .and_then(|list| list.into_iter().find_map(|a| a.name))
            .unwrap_or_default();

        AcoustIdMatch {
            score,
            acoustid_id,
            mbid: rec.id,
            title: rec.title.unwrap_or_default(),
            artist,
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_match() {
        // Response real de AcoustID para "Avicii - The Nights" (simplificada).
        let body = br#"{
            "status": "ok",
            "results": [{
                "id": "9eb4d22e-3bbf-46b1-8feb-d2fc5c7f6c44",
                "score": 0.987,
                "recordings": [{
                    "id": "3bf6f72f-ae87-4c91-bdcc-cc40d51f3c25",
                    "title": "The Nights",
                    "artists": [{"id": "x", "name": "Avicii"}]
                }]
            }]
        }"#;

        let m = parse_response(body).unwrap().expect("should match");
        assert_eq!(m.acoustid_id, "9eb4d22e-3bbf-46b1-8feb-d2fc5c7f6c44");
        assert_eq!(m.mbid, "3bf6f72f-ae87-4c91-bdcc-cc40d51f3c25");
        assert_eq!(m.title, "The Nights");
        assert_eq!(m.artist, "Avicii");
        assert!((m.score - 0.987).abs() < 1e-6);
    }

    #[test]
    fn picks_highest_score_among_multiple_results() {
        let body = br#"{
            "status": "ok",
            "results": [
                {"id": "a", "score": 0.6, "recordings": [{"id": "mbid-low", "title": "Low"}]},
                {"id": "b", "score": 0.95, "recordings": [{"id": "mbid-high", "title": "High"}]},
                {"id": "c", "score": 0.8, "recordings": [{"id": "mbid-mid", "title": "Mid"}]}
            ]
        }"#;

        let m = parse_response(body).unwrap().expect("should match");
        assert_eq!(m.mbid, "mbid-high");
        assert_eq!(m.title, "High");
    }

    #[test]
    fn returns_none_when_no_results() {
        let body = br#"{"status": "ok", "results": []}"#;
        assert_eq!(parse_response(body).unwrap(), None);
    }

    #[test]
    fn invalid_api_key_maps_to_typed_error() {
        // Respuesta real de AcoustID con una client key inválida (código 4).
        let body = br#"{"error": {"code": 4, "message": "invalid API key"}, "status": "error"}"#;
        let err = parse_response(body).expect_err("invalid key should error");
        assert!(
            matches!(err, AppError::AcoustIdInvalidKey),
            "expected AcoustIdInvalidKey, got {err:?}"
        );
    }

    #[test]
    fn skips_results_without_recordings() {
        // AcoustID conoce el fingerprint pero ningún result tiene linkeo a
        // MusicBrainz — para nosotros es no_match (no tenemos MBID que usar).
        let body = br#"{
            "status": "ok",
            "results": [
                {"id": "a", "score": 0.99, "recordings": []},
                {"id": "b", "score": 0.95}
            ]
        }"#;
        assert_eq!(parse_response(body).unwrap(), None);
    }

    #[test]
    fn skips_recordings_with_empty_mbid() {
        // Recording placeholder en MB sin MBID poblado todavía. Saltamos a
        // la siguiente del mismo result.
        let body = br#"{
            "status": "ok",
            "results": [{
                "id": "a",
                "score": 0.95,
                "recordings": [
                    {"id": "", "title": "No MBID"},
                    {"id": "real-mbid", "title": "Real"}
                ]
            }]
        }"#;
        let m = parse_response(body).unwrap().expect("should match real");
        assert_eq!(m.mbid, "real-mbid");
    }

    #[test]
    fn handles_recording_without_artists() {
        // Recording existe en MB con MBID pero sin artists registrados aún
        // (típico de releases muy nuevos). Aceptamos el match con artist
        // vacío — el caller decide qué hacer.
        let body = br#"{
            "status": "ok",
            "results": [{
                "id": "a",
                "score": 0.95,
                "recordings": [{"id": "mbid", "title": "Untitled"}]
            }]
        }"#;
        let m = parse_response(body).unwrap().expect("should match");
        assert_eq!(m.artist, "");
        assert_eq!(m.title, "Untitled");
    }

    #[test]
    fn handles_recording_without_title() {
        let body = br#"{
            "status": "ok",
            "results": [{
                "id": "a",
                "score": 0.95,
                "recordings": [{"id": "mbid", "artists": [{"name": "X"}]}]
            }]
        }"#;
        let m = parse_response(body).unwrap().expect("should match");
        assert_eq!(m.title, "");
        assert_eq!(m.artist, "X");
    }

    #[test]
    fn returns_error_when_status_error() {
        // Error de status sin código de key inválida → AcoustIdApi genérico
        // con el mensaje real.
        let body = br#"{
            "status": "error",
            "error": {"code": 3, "message": "invalid musicbrainz access token"}
        }"#;
        let err = parse_response(body).expect_err("should error");
        assert!(
            matches!(&err, AppError::AcoustIdApi(msg) if msg.contains("musicbrainz")),
            "expected AcoustIdApi, got {err:?}"
        );
    }

    #[test]
    fn returns_error_when_status_unknown() {
        let body = br#"{"status": "weird"}"#;
        let err = parse_response(body).expect_err("should error");
        assert!(matches!(err, AppError::AcoustIdApi(_)));
    }

    #[test]
    fn returns_error_when_malformed_json() {
        let body = b"not json";
        let err = parse_response(body).expect_err("should error");
        assert!(matches!(&err, AppError::AcoustIdApi(msg) if msg.contains("invalid response JSON")));
    }
}
