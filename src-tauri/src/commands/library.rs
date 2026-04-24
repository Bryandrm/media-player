//! Comandos Tauri de la biblioteca: scan de directorios + listado.

use sqlx::SqlitePool;
use std::path::PathBuf;
use tauri::State;
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
#[tauri::command]
pub async fn library_scan_directory(
    path: String,
    pool: State<'_, SqlitePool>,
) -> AppResult<ScanReport> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "not a directory: {}",
            root.display()
        )));
    }

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
                db::tracks::insert_from_metadata(&pool_for_blocking, file_path, meta, "local"),
            );

            match insert_result {
                Ok(true) => report.inserted += 1,
                Ok(false) => report.skipped += 1,
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
