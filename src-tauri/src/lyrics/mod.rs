//! Coordinador de la cascade de providers de letras.
//!
//! Estrategia:
//!   1. Embedded (USLT via lofty)
//!   2. LRCLIB (gratis)
//!   2.5 NetEase (gratis, sin key — sólo si no hubo synced aún) — ADR-030
//!   3. → mark_not_found
//!
//! Política híbrida cuando un provider tiene plain pero no synced: lo
//! retenemos como fallback y seguimos buscando synced en el siguiente. Si
//! nadie tiene synced, devolvemos el mejor plain encontrado.
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

/// Cascade Embedded → LRCLIB. Persiste el resultado en la tabla `lyrics`
/// (incluyendo `not_found` si nadie devolvió nada — para no re-pegarle la
/// próxima vez que el usuario abra el track).
pub async fn fetch_lyrics(
    pool: &SqlitePool,
    http: &reqwest::Client,
    query: LyricsQuery<'_>,
) -> AppResult<Option<Lyrics>> {
    let mut best_plain: Option<Lyrics> = None;

    // 1. Embedded (sólo plain en Fase 1 — USLT)
    if let Some(found) = embedded::try_embedded(query.track_id, query.file_path)? {
        if found.synced_lyrics.is_some() {
            // (No pasa en Fase 1 porque embedded.rs no lee SYLT, pero la
            // estructura queda lista para cuando soportemos SYLT en Fase 2.)
            db::lyrics::upsert(pool, &found).await?;
            return Ok(Some(found));
        }
        // Plain only — fallback. Seguimos buscando synced en LRCLIB.
        best_plain = Some(found);
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
            // Synced de LRCLIB gana sobre cualquier plain previo → return.
            if found.synced_lyrics.is_some() {
                db::lyrics::upsert(pool, &found).await?;
                return Ok(Some(found));
            }
            // Plain-only: lo retenemos como fallback (si no teníamos uno de
            // embedded, que tiene confidence 1.0) pero NO retornamos —
            // todavía le damos a NetEase la chance de proveer synced.
            if best_plain.is_none() {
                best_plain = Some(found);
            }
        }
    }

    // 2.5 NetEase — sólo si no encontramos synced aún y hay artist. Gratis y
    //     sin key (ADR-030); siempre se intenta. NetEase devuelve LRC directo.
    if let Some(artist) = query.artist {
        let ne_query = netease::NeteaseQuery {
            artist,
            title: query.title,
            duration_seconds: query.duration_seconds,
        };
        if let Some(found) = netease::try_netease(http, query.track_id, &ne_query).await? {
            // Synced de NetEase gana; plain sólo si no teníamos fallback.
            if found.synced_lyrics.is_some() || best_plain.is_none() {
                db::lyrics::upsert(pool, &found).await?;
                return Ok(Some(found));
            }
        }
    }

    // 3. Si tenemos plain de fallback (embedded o LRCLIB), persistimos ese.
    if let Some(plain) = best_plain {
        db::lyrics::upsert(pool, &plain).await?;
        return Ok(Some(plain));
    }

    // 4. Nada — cacheamos como not_found para no retry-ear automáticamente.
    db::lyrics::mark_not_found(pool, query.track_id).await?;
    Ok(None)
}
