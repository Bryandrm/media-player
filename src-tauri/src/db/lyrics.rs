//! Queries para la tabla `lyrics`. Las llama `lyrics::fetch_lyrics` (cache
//! check + persistencia) y `commands::lyrics::lyrics_set_offset`.

use sqlx::SqlitePool;

use crate::contracts::Lyrics;
use crate::errors::AppResult;

/// Devuelve la fila de lyrics si existe — sea con contenido (`status='found'`)
/// o cacheada como no encontrada (`status='not_found'`). Eso último permite
/// no re-pegarle a LRCLIB cada vez que el usuario abre un track sin letras.
pub async fn get_for_track(
    pool: &SqlitePool,
    track_id: i64,
) -> AppResult<Option<Lyrics>> {
    let row = sqlx::query_as::<_, Lyrics>(
        "SELECT track_id, synced_lyrics, plain_lyrics, source, source_id, \
                confidence, offset_ms, status \
         FROM lyrics WHERE track_id = ?",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Inserta o actualiza la fila de lyrics. UPSERT por `track_id` (PK).
/// `offset_ms` no se toca acá — preserva el ajuste manual del usuario incluso
/// si refetcheamos las letras (el offset es del track, no del provider).
pub async fn upsert(pool: &SqlitePool, lyrics: &Lyrics) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO lyrics (track_id, synced_lyrics, plain_lyrics, source, \
                             source_id, confidence, status, fetched_at, last_used_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) \
         ON CONFLICT(track_id) DO UPDATE SET \
             synced_lyrics = excluded.synced_lyrics, \
             plain_lyrics = excluded.plain_lyrics, \
             source = excluded.source, \
             source_id = excluded.source_id, \
             confidence = excluded.confidence, \
             status = excluded.status, \
             fetched_at = CURRENT_TIMESTAMP, \
             last_used_at = CURRENT_TIMESTAMP",
    )
    .bind(lyrics.track_id)
    .bind(&lyrics.synced_lyrics)
    .bind(&lyrics.plain_lyrics)
    .bind(&lyrics.source)
    .bind(&lyrics.source_id)
    .bind(lyrics.confidence)
    .bind(&lyrics.status)
    .execute(pool)
    .await?;
    Ok(())
}

/// Marca un track como "buscamos pero no encontramos" — para no re-pegarle a
/// los providers cada vez que el usuario abre el track. Se reintenta sólo
/// vía un futuro botón "Search again" (Fase 2).
pub async fn mark_not_found(pool: &SqlitePool, track_id: i64) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO lyrics (track_id, status, fetched_at) \
         VALUES (?, 'not_found', CURRENT_TIMESTAMP) \
         ON CONFLICT(track_id) DO UPDATE SET \
             status = 'not_found', \
             synced_lyrics = NULL, \
             plain_lyrics = NULL, \
             source = NULL, \
             source_id = NULL, \
             confidence = NULL, \
             fetched_at = CURRENT_TIMESTAMP",
    )
    .bind(track_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Actualiza sólo el offset. Llamado desde `lyrics_set_offset` cuando el
/// usuario ajusta los botones de offset en la UI.
pub async fn set_offset(
    pool: &SqlitePool,
    track_id: i64,
    offset_ms: i64,
) -> AppResult<()> {
    sqlx::query("UPDATE lyrics SET offset_ms = ? WHERE track_id = ?")
        .bind(offset_ms)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}
