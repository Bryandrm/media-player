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

/// Crea una smart playlist. `rules` es el JSON de las condiciones; lo validamos
/// parseándolo (un JSON inválido es error de input, no se guarda).
#[tauri::command]
pub async fn playlist_create_smart(
    name: String,
    rules: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<Playlist> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "playlist name cannot be empty".to_string(),
        ));
    }
    validate_rules(&rules)?;
    db::playlists::create_smart(&pool, trimmed, &rules).await
}

/// Reescribe las reglas de una smart playlist (desde el editor).
#[tauri::command]
pub async fn playlist_update_smart(
    playlist_id: i64,
    rules: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    validate_rules(&rules)?;
    db::playlists::update_smart_rules(&pool, playlist_id, &rules).await
}

/// Valida que `rules` sea un JSON que el motor de smart playlists sepa parsear.
fn validate_rules(rules: &str) -> AppResult<()> {
    serde_json::from_str::<db::smart::SmartRules>(rules)
        .map(|_| ())
        .map_err(|e| AppError::InvalidInput(format!("invalid smart rules: {e}")))
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

/// Exporta una playlist a un archivo `.m3u` (extended M3U). `dest_path` lo
/// elige el usuario en el frontend vía el save dialog del plugin. Escribimos
/// rutas **absolutas** — es un player local, no movemos los archivos, así que
/// las rutas absolutas son las más robustas (un M3U relativo se rompe si el
/// `.m3u` se mueve a otra carpeta). El filesystem lo toca Rust, no el frontend.
#[tauri::command]
pub async fn playlist_export_m3u(
    playlist_id: i64,
    dest_path: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    let tracks = db::playlists::list_tracks(&pool, playlist_id).await?;
    std::fs::write(&dest_path, build_m3u(&tracks))?;
    Ok(())
}

/// Construye el contenido de un extended M3U a partir de los tracks en orden.
/// Cada track: una línea `#EXTINF:<segundos>,<artista> - <título>` seguida de
/// la ruta absoluta. `duration_ms` se redondea a segundos (-1 si es 0/desconocida,
/// como manda la spec de EXTINF). Sin artista, sólo el título.
fn build_m3u(tracks: &[Track]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for t in tracks {
        let secs = if t.duration_ms > 0 {
            (t.duration_ms as f64 / 1000.0).round() as i64
        } else {
            -1
        };
        let label = match &t.artist {
            Some(a) if !a.trim().is_empty() => format!("{} - {}", a, t.title),
            _ => t.title.clone(),
        };
        out.push_str(&format!("#EXTINF:{secs},{label}\n"));
        out.push_str(&t.file_path);
        out.push('\n');
    }
    out
}

// ============================================================================
// Distinct values picker (smart playlist UX)
// ============================================================================

/// Devuelve los valores distintos de un campo de `tracks`, optimente filtrados
/// por las reglas que el usuario ya configuró en otras condiciones (cascading
/// prefilter). El frontend lo usa para poblar el MultiSelectPicker en el modal
/// de smart playlists.
///
/// `prefilter_rules_json`: string JSON con la misma shape que `playlists.rules`.
/// Si viene `None` o JSON inválido, se trata como "sin prefilter" → devuelve
/// todos los valores únicos del campo.
///
/// Excluye condiciones del prefilter que apuntan al mismo `field` solicitado
/// (el usuario está editando ESE campo).
#[tauri::command]
pub async fn playlist_smart_distinct_values(
    field: String,
    prefilter_rules_json: Option<String>,
    pool: State<'_, SqlitePool>,
) -> AppResult<Vec<String>> {
    let prefilter: crate::db::smart::SmartRules = prefilter_rules_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| crate::db::smart::SmartRules {
            match_mode: "all".to_string(),
            conditions: Vec::new(),
        });

    let mut qb = crate::db::smart::build_distinct_values_query(&field, &prefilter);
    let rows: Vec<(String,)> = qb.build_query_as().fetch_all(pool.inner()).await?;
    Ok(rows.into_iter().map(|(v,)| v).filter(|s| !s.is_empty()).collect())
}
