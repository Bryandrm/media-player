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

/// Match de AcoustID. **Importante:** un cluster de AcoustID puede agrupar
/// varias grabaciones DISTINTAS (datos comunitarios: merges/mislabels). El
/// `score` mide qué tan bien matchea el FINGERPRINT contra el cluster, NO que
/// la grabación elegida sea la correcta. Por eso elegimos la grabación que
/// mejor coincide con la metadata existente del track (`MetadataHint`) y, si
/// el cluster es ambiguo y ninguna coincide, marcamos `needs_confirmation`.
#[derive(Debug, Clone, PartialEq)]
pub struct AcoustIdMatch {
    pub score: f64,
    pub acoustid_id: String,
    pub mbid: String,
    pub title: String,
    pub artist: String,
    /// true cuando el cluster trae ≥2 grabaciones distintas y la elegida no
    /// coincide en NADA con la metadata existente → el caller NO debe pisar
    /// la metadata (la marca `low_confidence` y deja la original).
    pub needs_confirmation: bool,
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

/// Pista de metadata existente del track, para desambiguar entre las varias
/// grabaciones de un cluster de AcoustID. Guarda tokens normalizados de lo que
/// ya sabíamos (título original del download / tags). Sin esta pista volvemos
/// al comportamiento histórico (mayor score, primera grabación).
pub struct MetadataHint {
    tokens: std::collections::HashSet<String>,
}

impl MetadataHint {
    /// Construye la pista a partir de varias strings (las `None` se ignoran).
    pub fn new(parts: &[Option<&str>]) -> Self {
        let mut tokens = std::collections::HashSet::new();
        for p in parts.iter().flatten() {
            for t in normalize_tokens(p) {
                tokens.insert(t);
            }
        }
        Self { tokens }
    }
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
    /// Cantidad de tokens compartidos entre la pista y `title`+`artist` de un
    /// candidato. 0 = no se parecen en nada.
    fn overlap(&self, title: &str, artist: &str) -> usize {
        let mut cand = std::collections::HashSet::new();
        for t in normalize_tokens(title) {
            cand.insert(t);
        }
        for t in normalize_tokens(artist) {
            cand.insert(t);
        }
        self.tokens.intersection(&cand).count()
    }
}

/// Tokeniza una frase: lowercase Unicode, split por cualquier no-alfanumérico
/// (mantiene hangul/kanji como tokens enteros), descarta ruido común de
/// títulos de YouTube y tokens de 1 char.
fn normalize_tokens(s: &str) -> Vec<String> {
    const NOISE: &[&str] = &[
        "the", "feat", "ft", "official", "video", "audio", "lyric", "lyrics",
        "mv", "hd", "full", "ver", "version",
    ];
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2 && !NOISE.contains(t))
        .map(|t| t.to_string())
        .collect()
}

fn rec_title(r: &RawRecording) -> &str {
    r.title.as_deref().unwrap_or("")
}
fn rec_artist(r: &RawRecording) -> &str {
    r.artists
        .as_ref()
        .and_then(|l| l.iter().find_map(|a| a.name.as_deref()))
        .unwrap_or("")
}

/// Llama a AcoustID `/v2/lookup` y devuelve el mejor match disponible. Con
/// `hint`, elige la grabación que mejor coincide con la metadata existente;
/// sin hint, la de mayor score. `Ok(None)` si no hubo match utilizable.
pub async fn lookup(
    http: &reqwest::Client,
    api_key: &str,
    fingerprint: &str,
    duration_seconds: f32,
    hint: Option<&MetadataHint>,
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
    parse_response(&body, hint)
}

/// Parser puro. Devuelve `Ok(None)` si la API respondió ok pero sin
/// matches utilizables; `Err(AcoustIdApi)` si la API reportó error o el
/// JSON está malformado.
///
/// Selección (ver Gotcha de clusters multi-recording): aplanamos TODAS las
/// grabaciones (con MBID) de TODOS los results. Con `hint`, elegimos la que
/// más coincide con la metadata existente (desempate por score); sin hint, la
/// de mayor score. Si el cluster tiene ≥2 canciones distintas y la elegida no
/// coincide en nada con la pista, marcamos `needs_confirmation`.
pub fn parse_response(
    body: &[u8],
    hint: Option<&MetadataHint>,
) -> AppResult<Option<AcoustIdMatch>> {
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

    // Aplanar todas las grabaciones (con MBID no vacío) de todos los results.
    // Cada una hereda el score de SU result. AcoustID devuelve results sin
    // recordings (fingerprint conocido pero no linkeado a MB) — se saltean.
    let candidates: Vec<(f64, String, RawRecording)> = raw
        .results
        .into_iter()
        .flat_map(|r| {
            let score = r.score;
            let id = r.id;
            r.recordings
                .into_iter()
                .filter(|rc| !rc.id.is_empty())
                .map(move |rc| (score, id.clone(), rc))
        })
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }

    let use_hint = hint.map(|h| !h.is_empty()).unwrap_or(false);

    // Elegir: con hint, maximizar (overlap, luego score); sin hint, score.
    let chosen = candidates
        .iter()
        .max_by(|a, b| {
            if use_hint {
                let h = hint.unwrap();
                let oa = h.overlap(rec_title(&a.2), rec_artist(&a.2));
                let ob = h.overlap(rec_title(&b.2), rec_artist(&b.2));
                oa.cmp(&ob)
                    .then(a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
            } else {
                a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)
            }
        })
        .expect("candidates no está vacío");

    // ¿Cluster ambiguo? Más de una canción DISTINTA entre los candidatos.
    let distinct_songs: std::collections::HashSet<String> = candidates
        .iter()
        .map(|(_, _, rc)| {
            format!(
                "{}|{}",
                rec_title(rc).to_lowercase().trim(),
                rec_artist(rc).to_lowercase().trim()
            )
        })
        .collect();

    let chosen_overlap = if use_hint {
        hint.unwrap()
            .overlap(rec_title(&chosen.2), rec_artist(&chosen.2))
    } else {
        // Sin pista no evaluamos coincidencia → nunca pedimos confirmación.
        usize::MAX
    };

    // Sólo pedimos confirmación cuando el riesgo es real: cluster con varias
    // canciones distintas Y la elegida no coincide en nada con lo conocido. Un
    // cluster de una sola canción se confía aunque la metadata vieja fuera
    // basura (el fix está justamente para destapar metadata sucia).
    let needs_confirmation = use_hint && distinct_songs.len() >= 2 && chosen_overlap == 0;

    Ok(Some(AcoustIdMatch {
        score: chosen.0,
        acoustid_id: chosen.1.clone(),
        mbid: chosen.2.id.clone(),
        title: rec_title(&chosen.2).to_string(),
        artist: rec_artist(&chosen.2).to_string(),
        needs_confirmation,
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

        let m = parse_response(body, None).unwrap().expect("should match");
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

        let m = parse_response(body, None).unwrap().expect("should match");
        assert_eq!(m.mbid, "mbid-high");
        assert_eq!(m.title, "High");
    }

    #[test]
    fn returns_none_when_no_results() {
        let body = br#"{"status": "ok", "results": []}"#;
        assert_eq!(parse_response(body, None).unwrap(), None);
    }

    #[test]
    fn invalid_api_key_maps_to_typed_error() {
        // Respuesta real de AcoustID con una client key inválida (código 4).
        let body = br#"{"error": {"code": 4, "message": "invalid API key"}, "status": "error"}"#;
        let err = parse_response(body, None).expect_err("invalid key should error");
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
        assert_eq!(parse_response(body, None).unwrap(), None);
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
        let m = parse_response(body, None).unwrap().expect("should match real");
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
        let m = parse_response(body, None).unwrap().expect("should match");
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
        let m = parse_response(body, None).unwrap().expect("should match");
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
        let err = parse_response(body, None).expect_err("should error");
        assert!(
            matches!(&err, AppError::AcoustIdApi(msg) if msg.contains("musicbrainz")),
            "expected AcoustIdApi, got {err:?}"
        );
    }

    #[test]
    fn returns_error_when_status_unknown() {
        let body = br#"{"status": "weird"}"#;
        let err = parse_response(body, None).expect_err("should error");
        assert!(matches!(err, AppError::AcoustIdApi(_)));
    }

    #[test]
    fn returns_error_when_malformed_json() {
        let body = b"not json";
        let err = parse_response(body, None).expect_err("should error");
        assert!(matches!(&err, AppError::AcoustIdApi(msg) if msg.contains("invalid response JSON")));
    }

    // --- Selección por hint + safeguard (bug Dynamite→Control) -------------

    /// Respuesta REAL del cluster de "BTS - Dynamite": un result con 3
    /// grabaciones, "Control / Metro Station" PRIMERA (mislabel del cluster).
    const DYNAMITE_CLUSTER: &[u8] = br#"{
        "status": "ok",
        "results": [{
            "id": "ed90e914-8b94-496b-a7dd-986f4bfc55a4",
            "score": 0.9708,
            "recordings": [
                {"id": "0e554a86-588e-4aa3-9287-b462fcdabfae", "title": "Control", "artists": [{"name": "Metro Station"}]},
                {"id": "2e3df1b2-7d1e-4300-8bdb-48784a9c40fc", "title": "Dynamite", "artists": [{"name": "BTS"}]},
                {"id": "db965fe4-9e56-4fc7-837b-b2a0dcdb3206", "title": "Dynamite", "artists": [{"name": "BTS"}]}
            ]
        }]
    }"#;

    #[test]
    fn without_hint_never_needs_confirmation() {
        // Sin hint no evaluamos coincidencia → nunca pedimos confirmación
        // (devolvemos algún match del cluster por score). El path sin-hint es
        // el fallback; el camino real siempre pasa una pista.
        let m = parse_response(DYNAMITE_CLUSTER, None).unwrap().unwrap();
        assert!(!m.needs_confirmation);
        assert!(matches!(m.title.as_str(), "Control" | "Dynamite"));
    }

    #[test]
    fn hint_picks_matching_recording_over_first() {
        // Con la pista del título original del download, elegimos Dynamite/BTS
        // aunque "Control" venga primera en el cluster.
        let hint = MetadataHint::new(&[Some("BTS (방탄소년단) - DYNAMITE")]);
        let m = parse_response(DYNAMITE_CLUSTER, Some(&hint)).unwrap().unwrap();
        assert_eq!(m.title, "Dynamite");
        assert_eq!(m.artist, "BTS");
        assert!(!m.needs_confirmation, "coincide con la pista → no needs_confirmation");
    }

    #[test]
    fn ambiguous_cluster_with_no_overlap_flags_needs_confirmation() {
        // Cluster ambiguo (Control vs Dynamite) y una pista que no coincide con
        // ninguna → no podemos elegir con confianza → needs_confirmation.
        let hint = MetadataHint::new(&[Some("Taylor Swift - Lover")]);
        let m = parse_response(DYNAMITE_CLUSTER, Some(&hint)).unwrap().unwrap();
        assert!(m.needs_confirmation, "cluster ambiguo + 0 overlap → confirmar");
    }

    #[test]
    fn single_song_cluster_trusts_even_without_overlap() {
        // Una sola canción en el cluster: aunque la metadata vieja fuera basura
        // (0 overlap), confiamos — el identify existe para destapar eso.
        let body = br#"{
            "status": "ok",
            "results": [{
                "id": "a", "score": 0.95,
                "recordings": [{"id": "mbid", "title": "Real Song", "artists": [{"name": "Real Artist"}]}]
            }]
        }"#;
        let hint = MetadataHint::new(&[Some("video_0001_audio")]);
        let m = parse_response(body, Some(&hint)).unwrap().unwrap();
        assert_eq!(m.title, "Real Song");
        assert!(!m.needs_confirmation, "cluster de 1 canción → confiar");
    }
}
