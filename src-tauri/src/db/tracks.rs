//! Queries sobre la tabla `tracks`.

use sqlx::SqlitePool;
use std::path::Path;

use crate::audio::TrackMetadata;
use crate::contracts::Track;
use crate::errors::AppResult;

/// Inserta un track. Si el `file_path` ya existe, no hace nada (UNIQUE constraint
/// + ON CONFLICT DO NOTHING → idempotente). Devuelve `Some(id)` si se insertó
/// una fila nueva, `None` si era duplicado y se saltó.
pub async fn insert_from_metadata(
    pool: &SqlitePool,
    file_path: &Path,
    meta: TrackMetadata,
    source_type: &str,
    source_url: Option<&str>,
) -> AppResult<Option<i64>> {
    let file_path_str = file_path.to_string_lossy().into_owned();

    let result = sqlx::query(
        "INSERT INTO tracks (
            file_path, title, artist, album, duration_ms,
            track_number, year, genre,
            source_type, source_url, bitrate, sample_rate, format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO NOTHING",
    )
    .bind(&file_path_str)
    .bind(&meta.title)
    .bind(&meta.artist)
    .bind(&meta.album)
    .bind(meta.duration_ms)
    .bind(meta.track_number)
    .bind(meta.year)
    .bind(&meta.genre)
    .bind(source_type)
    .bind(source_url)
    .bind(meta.bitrate)
    .bind(meta.sample_rate)
    .bind(&meta.format)
    .execute(pool)
    .await?;

    if result.rows_affected() > 0 {
        Ok(Some(result.last_insert_rowid()))
    } else {
        Ok(None)
    }
}

/// Devuelve el id de un track por file_path, si existe.
pub async fn find_id_by_path(pool: &SqlitePool, file_path: &Path) -> AppResult<Option<i64>> {
    let file_path_str = file_path.to_string_lossy().into_owned();
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM tracks WHERE file_path = ?")
        .bind(&file_path_str)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

/// Setea (o limpia) la ruta de cover art para un track existente.
pub async fn set_cover_art(
    pool: &SqlitePool,
    track_id: i64,
    cover_path: Option<&Path>,
) -> AppResult<()> {
    let cover_str = cover_path.map(|p| p.to_string_lossy().into_owned());
    sqlx::query("UPDATE tracks SET cover_art_path = ? WHERE id = ?")
        .bind(cover_str)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Para el backfill de metadata: lista (id, title, artist, source_type) de
/// **todos** los tracks. Originalmente filtrábamos a `source_type='downloaded'`
/// para no tocar locales con metadata curada, pero el filtro era incompleto:
/// tracks descargados manualmente con `yt-dlp` desde CLI y luego scaneados
/// quedan como `'local'` y la metadata noisy escapaba al cleanup. La cleanup
/// es idempotente y conservadora — tracks con metadata limpia pasan sin
/// cambios. Usuarios con metadata local intencionalmente non-standard pueden
/// optar por no clickear el botón.
pub async fn list_for_metadata_backfill(
    pool: &SqlitePool,
) -> AppResult<Vec<(i64, String, Option<String>, String)>> {
    let rows: Vec<(i64, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, title, artist, source_type FROM tracks",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Actualiza title + artist de un track. Usado por el backfill de cleanup
/// metadata. Sólo updateamos los campos que la cleanup puede modificar —
/// album/year/genre/etc. los preservamos como están.
pub async fn update_title_and_artist(
    pool: &SqlitePool,
    track_id: i64,
    title: &str,
    artist: Option<&str>,
) -> AppResult<()> {
    sqlx::query("UPDATE tracks SET title = ?, artist = ? WHERE id = ?")
        .bind(title)
        .bind(artist)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Lista todos los tracks ordenados por artista + álbum + número de pista.
/// Incluye `lyrics_status` derivado de la tabla `lyrics` via LEFT JOIN —
/// computado en SQL para no necesitar una segunda query del frontend.
pub async fn list_all(pool: &SqlitePool) -> AppResult<Vec<Track>> {
    // CASE expression resuelve los 5 estados posibles (ver Track.lyrics_status
    // en contracts.rs). Orden de WHEN importa: 'not_found' antes que el check
    // de synced/plain (porque una row con status='not_found' tiene synced y
    // plain en NULL, pero queremos el estado explícito 'not_found').
    let rows = sqlx::query_as::<_, Track>(
        "SELECT t.id, t.file_path, t.title, t.artist, t.album, t.duration_ms,
                t.track_number, t.year, t.genre, t.format, t.cover_art_path,
                CASE
                    WHEN l.track_id IS NULL THEN NULL
                    WHEN l.status = 'not_found' THEN 'not_found'
                    WHEN l.synced_lyrics IS NOT NULL THEN 'synced'
                    WHEN l.plain_lyrics IS NOT NULL THEN 'plain'
                    ELSE 'instrumental'
                END AS lyrics_status
         FROM tracks t
         LEFT JOIN lyrics l ON l.track_id = t.id
         ORDER BY
           COALESCE(t.artist, 'ZZZ'),
           COALESCE(t.album, 'ZZZ'),
           COALESCE(t.track_number, 0),
           t.title",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}
