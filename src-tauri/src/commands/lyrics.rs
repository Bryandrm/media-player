//! Comandos Tauri de letras: fetch (cache-first + cascade) y set_offset.
//!
//! Ver docs/LYRICS.md §9.1 para el contrato.

use std::path::PathBuf;

use sqlx::SqlitePool;
use tauri::State;

use crate::contracts::Lyrics;
use crate::db;
use crate::errors::{AppError, AppResult};
use crate::lyrics::{self, LyricsQuery};

/// Devuelve las letras de un track. Cache-first: si ya las buscamos antes
/// (incluyendo cache de "not_found"), devolvemos la fila de DB sin pegar a
/// la red. Si no hay cache, corre la cascade de providers, persiste y
/// devuelve.
#[tauri::command]
pub async fn lyrics_fetch(
    track_id: i64,
    force: Option<bool>,
    pool: State<'_, SqlitePool>,
    http: State<'_, reqwest::Client>,
) -> AppResult<Option<Lyrics>> {
    // Cache check: si tenemos algo cacheado (sea found o not_found), respetarlo.
    // `force=true` lo saltea — lo usa el botón REFETCH para re-correr el cascade
    // sobre un track antes marcado not_found (ej: cacheado antes de NetEase).
    if !force.unwrap_or(false) {
        if let Some(cached) = db::lyrics::get_for_track(&pool, track_id).await? {
            if cached.status == "not_found" {
                return Ok(None);
            }
            return Ok(Some(cached));
        }
    }

    // Cache miss: leer la metadata del track para armar la query a LRCLIB.
    let track_row: Option<(String, Option<String>, Option<String>, i64)> =
        sqlx::query_as("SELECT title, artist, album, duration_ms FROM tracks WHERE id = ?")
            .bind(track_id)
            .fetch_optional(pool.inner())
            .await?;

    let Some((title, artist, album, duration_ms)) = track_row else {
        return Err(AppError::NotFound(format!("track {} not found", track_id)));
    };

    // Necesitamos el file_path para el provider embedded.
    let file_path: Option<String> =
        sqlx::query_scalar("SELECT file_path FROM tracks WHERE id = ?")
            .bind(track_id)
            .fetch_optional(pool.inner())
            .await?;
    let Some(file_path) = file_path else {
        return Err(AppError::NotFound(format!("track {} path", track_id)));
    };
    let file_path = PathBuf::from(file_path);

    let duration_seconds = ((duration_ms as f64) / 1000.0).round().max(0.0) as u32;

    let query = LyricsQuery {
        track_id,
        artist: artist.as_deref(),
        title: &title,
        album: album.as_deref(),
        duration_seconds,
        file_path: &file_path,
    };

    lyrics::fetch_lyrics(pool.inner(), http.inner(), query).await
}

/// Actualiza el offset global de las letras de un track. El frontend lo llama
/// con debounce mientras el usuario hace click en los botones de offset.
#[tauri::command]
pub async fn lyrics_set_offset(
    track_id: i64,
    offset_ms: i64,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    db::lyrics::set_offset(&pool, track_id, offset_ms).await
}

/// Actualiza el `speed_ratio` (drift correction) de un track. Usado por
/// los botones SLOWER/FASTER de la UI.
#[tauri::command]
pub async fn lyrics_set_speed_ratio(
    track_id: i64,
    speed_ratio: f64,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    db::lyrics::set_speed_ratio(&pool, track_id, speed_ratio).await
}

/// Resetea offset + speed_ratio a sus valores neutros (0 y 1.0). Usado por
/// el botón RESET — el usuario quiere "vuelvo a los timestamps originales
/// del LRC sin ningún ajuste".
#[tauri::command]
pub async fn lyrics_reset_sync(
    track_id: i64,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    db::lyrics::reset_sync(&pool, track_id).await
}

/// Persiste una edición manual de las letras (Lyrics Fase 2.c). El usuario
/// abre el modal EDIT LYRICS, modifica el LRC y/o el plain, y al guardar el
/// frontend invoca esto. Devolvemos la fila fresca para que el store la
/// reemplace sin necesidad de un round-trip extra.
#[tauri::command]
pub async fn lyrics_save_manual_edit(
    track_id: i64,
    synced_lyrics: Option<String>,
    plain_lyrics: Option<String>,
    pool: State<'_, SqlitePool>,
) -> AppResult<Lyrics> {
    db::lyrics::save_manual_edit(
        &pool,
        track_id,
        synced_lyrics.as_deref(),
        plain_lyrics.as_deref(),
    )
    .await?;

    db::lyrics::get_for_track(&pool, track_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("lyrics row missing for track {}", track_id)))
}

/// Guarda una edición de timing del editor de waveform (T6): el A2 re-editado.
/// No toca texto ni resetea sync/quality (ver `db::lyrics::save_word_timing`).
#[tauri::command]
pub async fn lyrics_save_word_timing(
    track_id: i64,
    synced_lyrics: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<Lyrics> {
    db::lyrics::save_word_timing(&pool, track_id, &synced_lyrics).await?;

    db::lyrics::get_for_track(&pool, track_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("lyrics row missing for track {}", track_id)))
}
