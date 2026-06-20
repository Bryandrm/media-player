//! Coordinador de la cascade de providers de letras.
//!
//! Estrategia:
//!   1. Embedded (USLT via lofty)
//!   2. LRCLIB (gratis)
//!   2.5 NetEase (gratis, sin key) — ADR-030
//!   3. → mark_not_found
//!
//! **Smart cascade (2.c.4):** el cascade ya NO para en el primer synced que
//! encuentra. Si un provider devuelve synced con `confidence < CONFIDENCE_THRESHOLD`
//! (0.7), lo retiene como candidato (`best_synced`) y sigue buscando en el
//! siguiente provider. Al final devuelve el candidato con mayor confidence.
//! Synced con confidence >= 0.7 retorna inmediatamente (fast path).
//!
//! Política híbrida para plain: lo retenemos como fallback y seguimos
//! buscando synced en el siguiente. Si nadie tiene synced, devolvemos el
//! mejor plain encontrado.
//!
//! Ver docs/LYRICS.md (plan por fases + §15) y
//! docs/PLAN-reproductor-brutalist.md §5.4.

pub mod embedded;
pub mod lrclib;
pub mod netease;

use std::path::Path;

use sqlx::SqlitePool;

use crate::contracts::Lyrics;
use crate::db;
use crate::errors::AppResult;

/// Datos para armar la query a LRCLIB. La capa de comandos los lee de la
/// row del track antes de invocar.
pub struct LyricsQuery<'a> {
    pub track_id: i64,
    pub artist: Option<&'a str>,
    pub title: &'a str,
    pub album: Option<&'a str>,
    pub duration_seconds: u32,
    pub file_path: &'a Path,
}

/// Confidence mínimo para aceptar un resultado synced sin seguir buscando.
/// Por debajo de este umbral, el resultado se retiene como candidato y el
/// cascade sigue al siguiente provider — puede haber un match mejor.
const CONFIDENCE_THRESHOLD: f64 = 0.7;

/// Reemplaza `best` con `candidate` si el candidato tiene mayor confidence.
fn pick_better(best: Option<Lyrics>, candidate: Lyrics) -> Option<Lyrics> {
    match &best {
        Some(current) => {
            let cur_c = current.confidence.unwrap_or(0.0);
            let new_c = candidate.confidence.unwrap_or(0.0);
            if new_c > cur_c {
                Some(candidate)
            } else {
                best
            }
        }
        None => Some(candidate),
    }
}

/// Cascade Embedded → LRCLIB → NetEase. Persiste el resultado en la tabla
/// `lyrics` (incluyendo `not_found` si nadie devolvió nada — para no
/// re-pegarle la próxima vez que el usuario abra el track).
///
/// **Smart cascade (2.c.4):** si un provider devuelve synced con confidence
/// < 0.7, no retorna — lo guarda como candidato y sigue buscando. Al final,
/// persiste y devuelve el mejor candidato encontrado (synced > plain).
pub async fn fetch_lyrics(
    pool: &SqlitePool,
    http: &reqwest::Client,
    query: LyricsQuery<'_>,
) -> AppResult<Option<Lyrics>> {
    let mut best_synced: Option<Lyrics> = None;
    let mut best_plain: Option<Lyrics> = None;

    // 1. Embedded (sólo plain en Fase 1 — USLT)
    if let Some(found) = embedded::try_embedded(query.track_id, query.file_path)? {
        if found.synced_lyrics.is_some() {
            let c = found.confidence.unwrap_or(0.0);
            if c >= CONFIDENCE_THRESHOLD {
                db::lyrics::upsert(pool, &found).await?;
                return Ok(Some(found));
            }
            best_synced = pick_better(best_synced, found);
        } else {
            best_plain = Some(found);
        }
    }

    // 2. LRCLIB — sólo si tenemos artist (sin artist el match es muy
    //    inexacto, mejor saltar).
    if let Some(artist) = query.artist {
        let lrc_query = lrclib::LrcLibQuery {
            artist,
            title: query.title,
            album: query.album,
            duration_seconds: query.duration_seconds,
        };
        if let Some(found) = lrclib::try_lrclib(http, query.track_id, &lrc_query).await? {
            if found.synced_lyrics.is_some() {
                let c = found.confidence.unwrap_or(0.0);
                if c >= CONFIDENCE_THRESHOLD {
                    db::lyrics::upsert(pool, &found).await?;
                    return Ok(Some(found));
                }
                best_synced = pick_better(best_synced, found);
            } else if best_plain.is_none() {
                best_plain = Some(found);
            }
        }
    }

    // 2.5 NetEase — siempre se intenta si hay artist y no tenemos synced
    //     de alta confidence aún. Gratis y sin key (ADR-030).
    if let Some(artist) = query.artist {
        let ne_query = netease::NeteaseQuery {
            artist,
            title: query.title,
            duration_seconds: query.duration_seconds,
        };
        if let Some(found) = netease::try_netease(http, query.track_id, &ne_query).await? {
            if found.synced_lyrics.is_some() {
                let c = found.confidence.unwrap_or(0.0);
                if c >= CONFIDENCE_THRESHOLD {
                    db::lyrics::upsert(pool, &found).await?;
                    return Ok(Some(found));
                }
                best_synced = pick_better(best_synced, found);
            } else if best_plain.is_none() {
                best_plain = Some(found);
            }
        }
    }

    // 3. Devolver el mejor candidato: synced > plain.
    if let Some(synced) = best_synced {
        db::lyrics::upsert(pool, &synced).await?;
        return Ok(Some(synced));
    }
    if let Some(plain) = best_plain {
        db::lyrics::upsert(pool, &plain).await?;
        return Ok(Some(plain));
    }

    // 4. Nada — cacheamos como not_found para no retry-ear automáticamente.
    db::lyrics::mark_not_found(pool, query.track_id).await?;
    Ok(None)
}
