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
                confidence, offset_ms, speed_ratio, status \
         FROM lyrics WHERE track_id = ?",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Inserta o actualiza la fila de lyrics. UPSERT por `track_id` (PK).
/// `offset_ms` y `speed_ratio` se respetan: si ya existían (usuario
/// ajustó manualmente) NO se pisan al refetchear. Excepción: si el caller
/// pasa `lyrics.speed_ratio != 1.0` Y la fila existente está en 1.0, sí
/// pisamos — eso es el caso de auto-baseline al fresh-fetch.
pub async fn upsert(pool: &SqlitePool, lyrics: &Lyrics) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO lyrics (track_id, synced_lyrics, plain_lyrics, source, \
                             source_id, confidence, speed_ratio, status, \
                             fetched_at, last_used_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) \
         ON CONFLICT(track_id) DO UPDATE SET \
             synced_lyrics = excluded.synced_lyrics, \
             plain_lyrics = excluded.plain_lyrics, \
             source = excluded.source, \
             source_id = excluded.source_id, \
             confidence = excluded.confidence, \
             status = excluded.status, \
             fetched_at = CURRENT_TIMESTAMP, \
             last_used_at = CURRENT_TIMESTAMP, \
             speed_ratio = CASE \
                 WHEN lyrics.speed_ratio != 1.0 THEN lyrics.speed_ratio \
                 ELSE excluded.speed_ratio \
             END",
    )
    .bind(lyrics.track_id)
    .bind(&lyrics.synced_lyrics)
    .bind(&lyrics.plain_lyrics)
    .bind(&lyrics.source)
    .bind(&lyrics.source_id)
    .bind(lyrics.confidence)
    .bind(lyrics.speed_ratio)
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

/// Actualiza sólo el speed_ratio. Llamado cuando el usuario clickea
/// SLOWER/FASTER. Usamos clamps amplios (0.5..2.0) — más allá significa
/// que el "match" entre LRC y audio está completamente equivocado, mejor
/// que el usuario re-busque la letra que insistir con drift extremo.
pub async fn set_speed_ratio(
    pool: &SqlitePool,
    track_id: i64,
    speed_ratio: f64,
) -> AppResult<()> {
    let clamped = speed_ratio.clamp(0.5, 2.0);
    sqlx::query("UPDATE lyrics SET speed_ratio = ? WHERE track_id = ?")
        .bind(clamped)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Reset de offset + speed_ratio a sus valores neutros. Usado por el
/// botón RESET de la UI, que hace "vuelvo a los timestamps originales
/// del LRC sin ningún ajuste".
pub async fn reset_sync(pool: &SqlitePool, track_id: i64) -> AppResult<()> {
    sqlx::query(
        "UPDATE lyrics SET offset_ms = 0, speed_ratio = 1.0 WHERE track_id = ?",
    )
    .bind(track_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Borra la fila de lyrics de un track. Usado por `library_backfill_metadata`
/// cuando la metadata del track cambia (artist/title nuevos invalidan el
/// match contra LRCLIB que cacheamos antes — el resultado anterior, sea
/// `found` o `not_found`, ya no aplica).
pub async fn delete_for_track(pool: &SqlitePool, track_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM lyrics WHERE track_id = ?")
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}
