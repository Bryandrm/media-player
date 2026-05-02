//! Comandos Tauri de la biblioteca: scan de directorios + listado.

use sqlx::SqlitePool;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;

use crate::audio;
use crate::contracts::{ScanReport, Track};
use crate::db;
use crate::errors::{AppError, AppResult};

/// Escanea recursivamente un directorio e inserta todos los archivos de audio
/// legibles en `tracks`. Devuelve un `ScanReport` con contadores.
///
/// Tracks ya existentes (por `file_path`) se saltean silenciosamente — esto
/// hace el scan idempotente: re-escanear el mismo directorio no duplica.
/// Para tracks recién insertados, también extrae el cover art (embebido o
/// sibling cover.jpg) y lo guarda en `<app_cache>/thumbnails/<id>.<ext>`.
#[tauri::command]
pub async fn library_scan_directory(
    path: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<ScanReport> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "not a directory: {}",
            root.display()
        )));
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("cache dir unavailable: {}", e)))?;

    // Recorrido + lectura de metadata en un pool de blocking threads —
    // lofty es sync y no queremos bloquear el runtime async principal.
    let pool_for_blocking = pool.inner().clone();
    let root_for_blocking = root.clone();

    let report = tauri::async_runtime::spawn_blocking(move || -> ScanReport {
        let mut report = ScanReport {
            scanned: 0,
            inserted: 0,
            skipped: 0,
            errors: 0,
        };

        for entry in WalkDir::new(&root_for_blocking).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let file_path = entry.path();
            if !audio::is_audio_file(file_path) {
                continue;
            }
            report.scanned += 1;

            let meta = match audio::extract_metadata(file_path) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[scan] skip {}: {}", file_path.display(), e);
                    report.errors += 1;
                    continue;
                }
            };

            // Ejecutar el insert async desde un contexto blocking: usamos
            // tauri::async_runtime::block_on. Cada insert es <1ms normalmente.
            let insert_result = tauri::async_runtime::block_on(
                db::tracks::insert_from_metadata(&pool_for_blocking, file_path, meta, "local", None),
            );

            match insert_result {
                Ok(Some(track_id)) => {
                    report.inserted += 1;
                    // Cover art: best-effort, no marcamos error si falla — el
                    // track sigue siendo válido sin imagen.
                    if let Ok(Some(cover_path)) =
                        audio::extract_cover_art(file_path, track_id, &cache_dir)
                    {
                        let _ = tauri::async_runtime::block_on(db::tracks::set_cover_art(
                            &pool_for_blocking,
                            track_id,
                            Some(&cover_path),
                        ));
                    }
                }
                Ok(None) => report.skipped += 1,
                Err(e) => {
                    eprintln!("[scan] insert failed {}: {}", file_path.display(), e);
                    report.errors += 1;
                }
            }
        }

        report
    })
    .await
    .map_err(|e| AppError::Other(format!("scan task joined with error: {}", e)))?;

    eprintln!(
        "[scan] {} → scanned={} inserted={} skipped={} errors={}",
        root.display(),
        report.scanned,
        report.inserted,
        report.skipped,
        report.errors
    );

    Ok(report)
}

/// Devuelve todos los tracks de la biblioteca.
#[tauri::command]
pub async fn library_list_tracks(pool: State<'_, SqlitePool>) -> AppResult<Vec<Track>> {
    db::tracks::list_all(&pool).await
}

/// Para tracks ya en DB que no tienen `cover_art_path` (típicamente tracks
/// agregados antes de que existiera el feature de cover art), intenta extraer
/// cover ahora. Devuelve la cantidad de tracks que se actualizaron.
///
/// Se llama una vez al boot desde el frontend. Idempotente: re-llamarlo
/// es seguro pero hace cero trabajo si todos los tracks ya tienen cover.
#[tauri::command]
pub async fn library_backfill_covers(
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<usize> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Other(format!("cache dir unavailable: {}", e)))?;
    let pool_for_blocking = pool.inner().clone();

    let count = tauri::async_runtime::spawn_blocking(move || -> usize {
        let pending: Vec<(i64, String)> = match tauri::async_runtime::block_on(
            sqlx::query_as::<_, (i64, String)>(
                "SELECT id, file_path FROM tracks WHERE cover_art_path IS NULL",
            )
            .fetch_all(&pool_for_blocking),
        ) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("[backfill] query failed: {}", e);
                return 0;
            }
        };

        let mut updated = 0;
        for (id, path_str) in pending {
            let path = PathBuf::from(&path_str);
            if !path.is_file() {
                continue;
            }
            if let Ok(Some(cover_path)) = audio::extract_cover_art(&path, id, &cache_dir) {
                if tauri::async_runtime::block_on(db::tracks::set_cover_art(
                    &pool_for_blocking,
                    id,
                    Some(&cover_path),
                ))
                .is_ok()
                {
                    updated += 1;
                }
            }
        }
        updated
    })
    .await
    .map_err(|e| AppError::Other(format!("backfill task joined with error: {}", e)))?;

    if count > 0 {
        eprintln!("[backfill] cover_art populated for {} tracks", count);
    }

    Ok(count)
}

/// Aplica `cleanup_metadata` a tracks ya en DB (filtrado a `source_type =
/// 'downloaded'` — los tracks locales suelen tener metadata curada y no
/// queremos modificarla). Actualiza sólo cuando la cleanup produce un cambio
/// real respecto al valor actual — para no hacer write-amplification ni
/// mutar tracks que ya estaban limpios.
///
/// Usado para "limpiar la library" después de bumpear las heurísticas de
/// cleanup, o post-migración si el usuario tenía tracks descargados antes
/// de que existiera el cleanup.
///
/// Devuelve la cantidad de tracks que cambiaron.
#[tauri::command]
pub async fn library_backfill_metadata(pool: State<'_, SqlitePool>) -> AppResult<usize> {
    let rows = db::tracks::list_for_metadata_backfill(&pool).await?;
    let total_candidates = rows.len();

    let mut updated = 0usize;
    for (id, title, artist, source_type) in rows {
        // Construir un TrackMetadata "minimal" sólo con los campos que la
        // cleanup mira. Los otros valores (duration, bitrate, etc.) no se
        // usan por la cleanup, así que default-eados.
        let proposed = audio::cleanup::cleanup_metadata(crate::audio::TrackMetadata {
            title: title.clone(),
            artist: artist.clone(),
            album: None,
            duration_ms: 0,
            track_number: None,
            year: None,
            genre: None,
            bitrate: None,
            sample_rate: None,
            format: None,
        });

        // Skip si la cleanup no cambió nada — evita UPDATE innecesario y
        // mantiene el `last_played_at` y otros campos no tocados.
        if proposed.title == title && proposed.artist == artist {
            // Log para diagnóstico — el usuario puede ver qué tracks no
            // matchearon ninguna heurística. Sólo prefijo y comilla simple
            // para que sea legible en los logs.
            eprintln!(
                "[backfill metadata]  skip id={} src={} artist={:?} title={:?}",
                id, source_type, artist, title
            );
            continue;
        }
        eprintln!(
            "[backfill metadata]    UP id={} src={} artist {:?} → {:?}, title {:?} → {:?}",
            id, source_type, artist, proposed.artist, title, proposed.title
        );

        if let Err(e) = db::tracks::update_title_and_artist(
            &pool,
            id,
            &proposed.title,
            proposed.artist.as_deref(),
        )
        .await
        {
            eprintln!("[backfill metadata] update failed for track {}: {}", id, e);
            continue;
        }
        // Invalidar cache de lyrics: el resultado guardado fue contra la
        // metadata vieja (sucia). Sea found o not_found, ya no es válido —
        // el próximo lyrics_fetch debe re-querear con artist/title limpios.
        // Best-effort: no fail-eamos el backfill si el delete falla.
        if let Err(e) = db::lyrics::delete_for_track(&pool, id).await {
            eprintln!(
                "[backfill metadata] lyrics cache invalidation failed for {}: {}",
                id, e
            );
        }
        updated += 1;
    }

    eprintln!(
        "[backfill metadata] candidates={} updated={}",
        total_candidates, updated
    );
    Ok(updated)
}
