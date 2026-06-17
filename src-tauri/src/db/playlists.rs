//! Queries para `playlists` + `playlist_tracks`. CRUD básico — sin reorder,
//! rename ni descripción editable por ahora. Esos quedan para sub-fase polish.

use sqlx::SqlitePool;

use crate::contracts::{Playlist, Track};
use crate::errors::AppResult;

/// Crea una playlist nueva. Devuelve la fila creada (con `id` autogenerado
/// y `track_count=0`).
pub async fn create(pool: &SqlitePool, name: &str) -> AppResult<Playlist> {
    let result = sqlx::query("INSERT INTO playlists (name) VALUES (?)")
        .bind(name)
        .execute(pool)
        .await?;
    let id = result.last_insert_rowid();
    Ok(Playlist {
        id,
        name: name.to_string(),
        description: None,
        track_count: 0,
    })
}

/// Lista todas las playlists con el count de tracks calculado en SQL.
/// LEFT JOIN para incluir playlists vacías con `track_count=0`. Orden por
/// nombre A-Z; reordenar manualmente queda para una sub-fase posterior.
pub async fn list_all(pool: &SqlitePool) -> AppResult<Vec<Playlist>> {
    let rows = sqlx::query_as::<_, Playlist>(
        "SELECT p.id, p.name, p.description, \
                COUNT(pt.track_id) AS track_count \
         FROM playlists p \
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id \
         GROUP BY p.id \
         ORDER BY p.name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Borra una playlist. `ON DELETE CASCADE` del schema se encarga de
/// `playlist_tracks` automáticamente — no hay que tocarla explícitamente.
pub async fn delete(pool: &SqlitePool, playlist_id: i64) -> AppResult<()> {
    sqlx::query("DELETE FROM playlists WHERE id = ?")
        .bind(playlist_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Renombra una playlist.
pub async fn rename(pool: &SqlitePool, playlist_id: i64, name: &str) -> AppResult<()> {
    sqlx::query("UPDATE playlists SET name = ? WHERE id = ?")
        .bind(name)
        .bind(playlist_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Agrega un track al final de la playlist. La PK compuesta (playlist_id,
/// track_id) garantiza que un mismo track no se duplique — `ON CONFLICT
/// DO NOTHING` hace la operación idempotente: agregar dos veces el mismo
/// track no es error, simplemente no hace nada la segunda vez.
///
/// `position` = max(position) + 1 para insertar al final. Si la playlist
/// estaba vacía, COALESCE lo lleva a 0.
pub async fn add_track(
    pool: &SqlitePool,
    playlist_id: i64,
    track_id: i64,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position) \
         VALUES (?, ?, \
            COALESCE((SELECT MAX(position) + 1 FROM playlist_tracks \
                      WHERE playlist_id = ?), 0) \
         ) \
         ON CONFLICT(playlist_id, track_id) DO NOTHING",
    )
    .bind(playlist_id)
    .bind(track_id)
    .bind(playlist_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Saca un track de una playlist. No reindexamos posiciones — los gaps en
/// `position` son intencionales (no afectan ORDER BY) y reindexar después
/// de cada remove agrega complejidad sin valor visible.
pub async fn remove_track(
    pool: &SqlitePool,
    playlist_id: i64,
    track_id: i64,
) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?",
    )
    .bind(playlist_id)
    .bind(track_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Reordena los tracks de una playlist. `ordered_track_ids` es la lista
/// completa de track_ids en el orden deseado — asignamos `position = índice`.
/// Transacción para que un fallo a media reescritura no deje posiciones
/// inconsistentes. Sólo afecta tracks que ya están en la playlist (UPDATE no
/// inserta); ids ausentes se ignoran silenciosamente.
pub async fn reorder(
    pool: &SqlitePool,
    playlist_id: i64,
    ordered_track_ids: &[i64],
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for (idx, track_id) in ordered_track_ids.iter().enumerate() {
        sqlx::query(
            "UPDATE playlist_tracks SET position = ? \
             WHERE playlist_id = ? AND track_id = ?",
        )
        .bind(idx as i64)
        .bind(playlist_id)
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Devuelve el id de la playlist con ese nombre (case-insensitive), creándola
/// si no existe. Usado por el downloader cuando baja una lista: re-bajar la
/// misma lista reusa la playlist en vez de duplicarla (y `add_track` es
/// idempotente, así que no duplica tracks tampoco).
pub async fn get_or_create_id(pool: &SqlitePool, name: &str) -> AppResult<i64> {
    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM playlists WHERE name = ? COLLATE NOCASE LIMIT 1",
    )
    .bind(name)
    .fetch_optional(pool)
    .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    Ok(create(pool, name).await?.id)
}

/// Lista los tracks de una playlist en orden de inserción (`position`).
/// JOIN contra `tracks` para devolver el mismo shape que `tracks::list_all`
/// — el frontend reusa la `LibraryTable` con la misma data. El `lyrics_status`
/// derivado y los campos de identification van con la misma lógica que
/// `tracks::list_all` para mantener la UI consistente.
pub async fn list_tracks(
    pool: &SqlitePool,
    playlist_id: i64,
) -> AppResult<Vec<Track>> {
    let rows = sqlx::query_as::<_, Track>(
        "SELECT t.id, t.file_path, t.title, t.artist, t.album, t.duration_ms, \
                t.track_number, t.year, t.genre, t.format, t.cover_art_path, \
                CASE \
                    WHEN l.track_id IS NULL THEN NULL \
                    WHEN l.status = 'not_found' THEN 'not_found' \
                    WHEN l.synced_lyrics IS NOT NULL THEN 'synced' \
                    WHEN l.plain_lyrics IS NOT NULL THEN 'plain' \
                    ELSE 'instrumental' \
                END AS lyrics_status, \
                t.acoustid_id, t.mbid_recording, t.identification_status, \
                t.acoustid_score \
         FROM playlist_tracks pt \
         JOIN tracks t ON t.id = pt.track_id \
         LEFT JOIN lyrics l ON l.track_id = t.id \
         WHERE pt.playlist_id = ? \
         ORDER BY pt.position",
    )
    .bind(playlist_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
