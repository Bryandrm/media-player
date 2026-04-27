//! Queries sobre la tabla `tracks`.

use sqlx::SqlitePool;
use std::path::Path;

use crate::audio::TrackMetadata;
use crate::contracts::Track;
use crate::errors::AppResult;

/// Inserta un track. Si el `file_path` ya existe, no hace nada (UNIQUE constraint
/// + ON CONFLICT DO NOTHING → idempotente). Devuelve `true` si se insertó.
pub async fn insert_from_metadata(
    pool: &SqlitePool,
    file_path: &Path,
    meta: TrackMetadata,
    source_type: &str,
    source_url: Option<&str>,
) -> AppResult<bool> {
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

    Ok(result.rows_affected() > 0)
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

/// Lista todos los tracks ordenados por artista + álbum + número de pista.
pub async fn list_all(pool: &SqlitePool) -> AppResult<Vec<Track>> {
    let rows = sqlx::query_as::<_, Track>(
        "SELECT id, file_path, title, artist, album, duration_ms,
                track_number, year, genre, format
         FROM tracks
         ORDER BY
           COALESCE(artist, 'ZZZ'),
           COALESCE(album, 'ZZZ'),
           COALESCE(track_number, 0),
           title",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}
