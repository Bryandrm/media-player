//! Comandos Tauri de playlists: CRUD + add/remove tracks.

use sqlx::SqlitePool;
use tauri::State;

use crate::contracts::{Playlist, Track};
use crate::db;
use crate::errors::{AppError, AppResult};

/// Crea una playlist. Valida que `name` no esté vacío después de trim —
/// playlists sin nombre no son útiles y el sidebar las renderea como hueco.
#[tauri::command]
pub async fn playlist_create(
    name: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<Playlist> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "playlist name cannot be empty".to_string(),
        ));
    }
    db::playlists::create(&pool, trimmed).await
}

#[tauri::command]
pub async fn playlist_list(pool: State<'_, SqlitePool>) -> AppResult<Vec<Playlist>> {
    db::playlists::list_all(&pool).await
}

#[tauri::command]
pub async fn playlist_delete(
    playlist_id: i64,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    db::playlists::delete(&pool, playlist_id).await
}

#[tauri::command]
pub async fn playlist_rename(
    playlist_id: i64,
    name: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "playlist name cannot be empty".to_string(),
        ));
    }
    db::playlists::rename(&pool, playlist_id, trimmed).await
}

#[tauri::command]
pub async fn playlist_add_track(
    playlist_id: i64,
    track_id: i64,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    db::playlists::add_track(&pool, playlist_id, track_id).await
}

#[tauri::command]
pub async fn playlist_remove_track(
    playlist_id: i64,
    track_id: i64,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    db::playlists::remove_track(&pool, playlist_id, track_id).await
}

#[tauri::command]
pub async fn playlist_get_tracks(
    playlist_id: i64,
    pool: State<'_, SqlitePool>,
) -> AppResult<Vec<Track>> {
    db::playlists::list_tracks(&pool, playlist_id).await
}

/// Reordena los tracks de una playlist. `track_ids` es la lista completa en el
/// nuevo orden — el frontend la arma tras el drag & drop.
#[tauri::command]
pub async fn playlist_reorder(
    playlist_id: i64,
    track_ids: Vec<i64>,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    db::playlists::reorder(&pool, playlist_id, &track_ids).await
}
