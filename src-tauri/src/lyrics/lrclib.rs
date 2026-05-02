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
