//! Cliente HTTP a NetEase Cloud Music (music.163.com). API comunitaria, sin
//! auth/key. Tercer provider del cascade de letras (después de LRCLIB).
//!
//! A diferencia de Musixmatch (que requiere licencia paga para letras
//! completas — su free tier es preview-only), NetEase devuelve la letra
//! **directamente en formato LRC** vía `/api/song/lyric`, lista para el parser
//! del frontend (que ya soporta fracciones de 3 dígitos `[mm:ss.xxx]`, que es
//! como las emite NetEase).
//!
//! Endpoints no oficiales: pueden cambiar o estar geo-restringidos. Todos los
//! fallos degradan a `Ok(None)` para no romper el cascade. Requieren header
//! `Referer: https://music.163.com` para que NetEase responda. Usamos
//! `/api/search/get/` (devuelve JSON plano; `get/web` viene eapi-encriptado).

use serde::Deserialize;

use crate::contracts::Lyrics;
use crate::errors::AppResult;

const SEARCH_URL: &str = "https://music.163.com/api/search/get/";
const LYRIC_URL: &str = "https://music.163.com/api/song/lyric";
const REFERER: &str = "https://music.163.com";

// Si la duración del result difiere más que esto del track local, es probable
// que sea otra versión (live/edit/remix) → descartar para no mostrar letras de
// otra canción. Mismo criterio conservador que LRCLIB.
const DURATION_TOLERANCE_S: i64 = 8;

// Confidence fija para un match validado por duración. Debajo del 1.0 de
// LRCLIB exact match (NetEase matchea por texto, no por MBID) pero por encima
// del umbral de warning (0.8) — un match dentro de tolerancia es confiable.
const CONFIDENCE: f64 = 0.85;

pub struct NeteaseQuery<'a> {
    pub artist: &'a str,
    pub title: &'a str,
    pub duration_seconds: u32,
}

#[derive(Deserialize)]
struct SearchEnvelope {
    result: Option<SearchResult>,
}
#[derive(Deserialize)]
struct SearchResult {
    songs: Option<Vec<SearchSong>>,
}
#[derive(Deserialize)]
struct SearchSong {
    id: i64,
    /// Duración en ms. Default 0 si NetEase no la trae para ese result.
    #[serde(default)]
    duration: i64,
}

#[derive(Deserialize)]
struct LyricEnvelope {
    lrc: Option<LyricBlob>,
}
#[derive(Deserialize)]
struct LyricBlob {
    lyric: Option<String>,
}

/// Busca el track y trae su letra. `Ok(None)` = no encontrado (no es error).
/// Errores de red propagan; cualquier otro fallo (status raro, JSON inesperado)
/// → `Ok(None)` para que el cascade siga a `mark_not_found`.
pub async fn try_netease(
    http: &reqwest::Client,
    track_id: i64,
    q: &NeteaseQuery<'_>,
) -> AppResult<Option<Lyrics>> {
    let Some(song_id) = search_best_match(http, q).await? else {
        return Ok(None);
    };
    let Some(lyric) = fetch_lyric(http, song_id).await? else {
        return Ok(None);
    };
    let lyric = lyric.trim();
    if lyric.is_empty() {
        return Ok(None);
    }

    // NetEase devuelve LRC con timestamps para tracks con synced; algunos sólo
    // tienen plain (sin `[mm:ss]`). Clasificamos para el indicador L y el panel.
    let synced = looks_synced(lyric);
    Ok(Some(Lyrics {
        track_id,
        synced_lyrics: synced.then(|| lyric.to_string()),
        plain_lyrics: (!synced).then(|| lyric.to_string()),
        source: Some("netease".to_string()),
        source_id: Some(song_id.to_string()),
        confidence: Some(CONFIDENCE),
        offset_ms: 0,
        speed_ratio: 1.0,
        aligned_at: None,
        original_synced_lyrics: None,
        alignment_score: None,
        mismatch_score: None,
        mismatch_checked_at: None,
        status: "found".to_string(),
    }))
}

/// Devuelve el id del primer result cuya duración cae dentro de la tolerancia.
/// Conservador: si ninguno calza (o no traen duración), `None` — preferimos no
/// mostrar letras a mostrar las de otra versión.
async fn search_best_match(
    http: &reqwest::Client,
    q: &NeteaseQuery<'_>,
) -> AppResult<Option<i64>> {
    let query = format!("{} {}", q.artist, q.title);
    let params = [
        ("s", query.as_str()),
        ("type", "1"),
        ("limit", "10"),
        ("offset", "0"),
    ];
    let resp = http
        .get(SEARCH_URL)
        .header("Referer", REFERER)
        .query(&params)
        .send()
        .await?;
    if !resp.status().is_success() {
        eprintln!("[netease] search HTTP {}", resp.status());
        return Ok(None);
    }

    let env: SearchEnvelope = resp.json().await?;
    let Some(songs) = env.result.and_then(|r| r.songs) else {
        return Ok(None);
    };

    let target_ms = q.duration_seconds as i64 * 1000;
    for song in &songs {
        if song.duration > 0
            && (song.duration - target_ms).abs() <= DURATION_TOLERANCE_S * 1000
        {
            return Ok(Some(song.id));
        }
    }
    Ok(None)
}

async fn fetch_lyric(http: &reqwest::Client, song_id: i64) -> AppResult<Option<String>> {
    let id_str = song_id.to_string();
    let params = [
        ("id", id_str.as_str()),
        ("lv", "1"),
        ("kv", "1"),
        ("tv", "-1"),
    ];
    let resp = http
        .get(LYRIC_URL)
        .header("Referer", REFERER)
        .query(&params)
        .send()
        .await?;
    if !resp.status().is_success() {
        eprintln!("[netease] lyric HTTP {}", resp.status());
        return Ok(None);
    }
    let env: LyricEnvelope = resp.json().await?;
    Ok(env.lrc.and_then(|l| l.lyric))
}

/// True si el LRC tiene al menos una línea que arranca con un timestamp
/// `[<dígito>…`. Distingue synced de plain sin parsear todo el blob.
fn looks_synced(lyric: &str) -> bool {
    lyric.lines().any(|line| {
        let mut chars = line.trim_start().chars();
        chars.next() == Some('[') && chars.next().is_some_and(|c| c.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_synced_detects_timestamps() {
        assert!(looks_synced("[00:06.220]Hello, it's me"));
        // Credit line sin timestamp + línea con timestamp → synced.
        assert!(looks_synced("作词 : X\n[00:01.000]Hello"));
    }

    #[test]
    fn looks_synced_false_for_plain() {
        assert!(!looks_synced("Hello it's me\nI was wondering"));
        assert!(!looks_synced(""));
    }
}
