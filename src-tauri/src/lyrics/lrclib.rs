//! Cliente HTTP a LRCLIB (https://lrclib.net). API gratuita, sin auth,
//! sin rate limit publicado.
//!
//! Field fallback: si el match exacto con todos los campos falla, intentamos
//! variantes — el match preciso a veces falla por una diferencia menor en
//! el nombre del álbum o en duración. Cada variante = 1 request.
//!
//! Confidence: calculado en base al delta de duración entre lo que reporta
//! LRCLIB y lo que tiene el track local. >5s de diferencia → posiblemente
//! sea otra versión (live vs studio, edit vs original).

use serde::Deserialize;

use crate::contracts::Lyrics;
use crate::errors::AppResult;

const LRCLIB_GET: &str = "https://lrclib.net/api/get";
const LRCLIB_SEARCH: &str = "https://lrclib.net/api/search";

// Tolerancia en segundos para considerar válido un match por search. Si la
// duración del track local difiere más que esto del result de LRCLIB, es
// probable que sea otra versión (live, edit, remix) — descartar.
const SEARCH_DURATION_TOLERANCE_S: i32 = 10;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrcLibResponse {
    id: i64,
    duration: f32,
    instrumental: bool,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

pub struct LrcLibQuery<'a> {
    pub artist: &'a str,
    pub title: &'a str,
    pub album: Option<&'a str>,
    pub duration_seconds: u32,
}

/// Intenta varios queries con field fallback. Devuelve `Ok(None)` si nada
/// matcheó — eso NO es error, sólo "no encontrado". Errores de red sí
/// propagan via `AppResult`.
///
/// Cascade interna:
///   1. /api/get con todos los campos (artist, title, album, duration).
///   2. /api/get sin album (caso típico: album diferente entre release).
///   3. /api/search por keyword (más fuzzy, captura tracks donde la
///      metadata difiere lo suficiente como para que match exacto falle —
///      ej: "Avicii - Topic" vs "Avicii", typos, casing). Validamos
///      duration contra tolerancia para no aceptar versiones equivocadas.
pub async fn try_lrclib(
    http: &reqwest::Client,
    track_id: i64,
    q: &LrcLibQuery<'_>,
) -> AppResult<Option<Lyrics>> {
    // Variante 1: match exacto con todos los campos.
    if let Some(found) = fetch_one(http, track_id, q, /* with_album */ true).await? {
        return Ok(Some(found));
    }
    // Variante 2: sin album. El match exacto suele fallar por diffs en album
    // (ej: "Nevermind" vs "Nevermind (Remastered)").
    if q.album.is_some() {
        if let Some(found) = fetch_one(http, track_id, q, /* with_album */ false).await? {
            return Ok(Some(found));
        }
    }
    // Variante 3: search fuzzy. Si llegamos acá ya fallamos en match exacto
    // — la duration tolerance evita aceptar resultados equivocados.
    if let Some(found) = search_fuzzy(http, track_id, q).await? {
        return Ok(Some(found));
    }
    Ok(None)
}

async fn fetch_one(
    http: &reqwest::Client,
    track_id: i64,
    q: &LrcLibQuery<'_>,
    with_album: bool,
) -> AppResult<Option<Lyrics>> {
    let duration_str = q.duration_seconds.to_string();
    let mut params: Vec<(&str, &str)> = vec![
        ("artist_name", q.artist),
        ("track_name", q.title),
        ("duration", &duration_str),
    ];
    if with_album {
        if let Some(album) = q.album {
            params.push(("album_name", album));
        }
    }

    let resp = http.get(LRCLIB_GET).query(&params).send().await?;

    // 404 = no match (esperado). Cualquier otro non-success lo logueamos
    // pero devolvemos None (no rompemos el flujo si LRCLIB tiene un
    // hipo — el frontend mostrará "not found" igual).
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        eprintln!("[lrclib] non-success status: {}", resp.status());
        return Ok(None);
    }

    let body: LrcLibResponse = resp.json().await?;

    // Tracks instrumentales: LRCLIB los marca explícitamente. Devolvemos un
    // Lyrics con ambos blobs en None y status='found' — el frontend lo
    // detecta vía source/synced/plain todos null y muestra "♪ INSTRUMENTAL ♪".
    // Mejor que mark_not_found: este IS encontrado, sólo que confirmado
    // sin letras (no re-buscar nunca).
    if body.instrumental {
        return Ok(Some(Lyrics {
            track_id,
            synced_lyrics: None,
            plain_lyrics: None,
            source: Some("lrclib".to_string()),
            source_id: Some(body.id.to_string()),
            confidence: Some(1.0),
            offset_ms: 0,
            status: "found".to_string(),
        }));
    }

    // Si volvió 200 pero sin synced ni plain, lo tratamos como no-match
    // (LRCLIB a veces tiene filas vacías).
    if body.synced_lyrics.is_none() && body.plain_lyrics.is_none() {
        return Ok(None);
    }

    let confidence = confidence_from_duration(body.duration, q.duration_seconds);

    Ok(Some(Lyrics {
        track_id,
        synced_lyrics: body.synced_lyrics,
        plain_lyrics: body.plain_lyrics,
        source: Some("lrclib".to_string()),
        source_id: Some(body.id.to_string()),
        confidence: Some(confidence),
        offset_ms: 0,
        status: "found".to_string(),
    }))
}

/// 0.0..1.0. Diferencia >5s entre track local y lo que reporta LRCLIB
/// sugiere otra versión de la canción (live, edit, remix). El frontend
/// muestra warning si <0.8.
fn confidence_from_duration(returned: f32, expected_seconds: u32) -> f64 {
    let diff = (returned as i32 - expected_seconds as i32).abs();
    match diff {
        0..=2 => 1.0,
        3..=5 => 0.8,
        6..=10 => 0.5,
        _ => 0.3,
    }
}

/// Búsqueda fuzzy via /api/search cuando los matches exactos fallaron.
/// Endpoint: GET /api/search?q={artist}+{title}&artist_name=&track_name=
///
/// Devuelve un array de matches ordenados por relevancia. Tomamos el primero
/// que pase los filtros: duration dentro de tolerance + tiene contenido
/// (synced o plain).
///
/// Confidence se penaliza un 15% respecto al match exacto — es fuzzier por
/// definición y queremos que el usuario sepa que es match aproximado (low
/// confidence dispara el warning visual en el panel de letras).
async fn search_fuzzy(
    http: &reqwest::Client,
    track_id: i64,
    q: &LrcLibQuery<'_>,
) -> AppResult<Option<Lyrics>> {
    let q_string = format!("{} {}", q.artist, q.title);
    let params: [(&str, &str); 3] = [
        ("q", q_string.as_str()),
        ("artist_name", q.artist),
        ("track_name", q.title),
    ];

    let resp = http.get(LRCLIB_SEARCH).query(&params).send().await?;
    if !resp.status().is_success() {
        eprintln!("[lrclib search] non-success: {}", resp.status());
        return Ok(None);
    }

    let results: Vec<LrcLibResponse> = resp.json().await?;
    if results.is_empty() {
        return Ok(None);
    }

    // Pickear el primer result válido. LRCLIB ordena por relevancia, pero
    // verificamos duration para evitar aceptar versiones equivocadas
    // (live/edit/remix) que pueden ser primer resultado pero no calzan con
    // el archivo local del usuario.
    for result in results.into_iter() {
        let diff = (result.duration as i32 - q.duration_seconds as i32).abs();
        if diff > SEARCH_DURATION_TOLERANCE_S {
            continue;
        }
        // Skip results sin contenido — instrumentales en search casi siempre
        // son duplicados del track real con letras (LRCLIB indexa ambos).
        // Mejor seguir buscando que cachear un instrumental falso.
        if result.synced_lyrics.is_none() && result.plain_lyrics.is_none() {
            continue;
        }
        let base_confidence = confidence_from_duration(result.duration, q.duration_seconds);
        // Penalizar por ser match fuzzy. clamp inferior 0.3 para no dar
        // confidence ridículamente bajo (que equivaldría a un error).
        let confidence = (base_confidence * 0.85).max(0.3);
        return Ok(Some(Lyrics {
            track_id,
            synced_lyrics: result.synced_lyrics,
            plain_lyrics: result.plain_lyrics,
            source: Some("lrclib".to_string()),
            source_id: Some(result.id.to_string()),
            confidence: Some(confidence),
            offset_ms: 0,
            status: "found".to_string(),
        }));
    }
    Ok(None)
}
