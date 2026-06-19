mod audio;
mod commands;
mod contracts;
mod db;
mod downloader;
mod errors;
mod identification;
mod karaoke;
mod lyrics;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app_data_dir");

            let pool = tauri::async_runtime::block_on(db::init(&data_dir))?;
            app.manage(pool);

            // HTTP client para LRCLIB (y cualquier futuro provider de letras o
            // metadata). User-Agent identificado: best practice de LRCLIB.
            let http = reqwest::Client::builder()
                .user_agent(concat!(
                    "BrutalistPlayer/", env!("CARGO_PKG_VERSION"),
                    " ( https://github.com/bryandrm/brutalist-player )"
                ))
                .build()
                .expect("failed to build reqwest client");
            app.manage(http);

            // Estado del bulk identify (running + cancel flags). Compartido
            // entre el comando que lanza el task y el que cancela.
            app.manage(commands::identification::BulkIdentifyState::default());
            app.manage(commands::library::BulkMbBackfillState::default());

            // Registro de descargas en curso para poder cancelarlas.
            app.manage(commands::downloader::DownloadCancels::default());

            // Limpiar temporales de descargas canceladas/interrumpidas (`.part`
            // huérfanos en `_pending`). Al boot no hay descargas corriendo.
            if let Ok(audio_dir) = app.path().audio_dir() {
                let library_dir = audio_dir.join("BrutalistPlayer").join("library");
                downloader::clean_pending(&library_dir);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::library_scan_directory,
            commands::library::library_get_track_details,
            commands::library::library_import_paths,
            commands::library::library_list_tracks,
            commands::library::library_backfill_covers,
            commands::library::library_backfill_metadata,
            commands::library::library_backfill_mb_metadata,
            commands::library::library_cancel_mb_backfill,
            commands::playlists::playlist_smart_distinct_values,
            commands::system::check_dependencies,
            commands::downloader::download_track,
            commands::downloader::download_list_history,
            commands::downloader::download_clear_history,
            commands::downloader::download_delete,
            commands::downloader::download_cancel,
            commands::lyrics::lyrics_fetch,
            commands::lyrics::lyrics_set_offset,
            commands::lyrics::lyrics_set_speed_ratio,
            commands::lyrics::lyrics_reset_sync,
            commands::lyrics::lyrics_save_manual_edit,
            commands::identification::identification_identify_track,
            commands::identification::identification_get_api_key,
            commands::identification::identification_set_api_key,
            commands::identification::identification_identify_all,
            commands::identification::identification_cancel_all,
            commands::karaoke::karaoke_auto_align,
            commands::playlists::playlist_create,
            commands::playlists::playlist_create_smart,
            commands::playlists::playlist_update_smart,
            commands::playlists::playlist_list,
            commands::playlists::playlist_delete,
            commands::playlists::playlist_rename,
            commands::playlists::playlist_add_track,
            commands::playlists::playlist_remove_track,
            commands::playlists::playlist_get_tracks,
            commands::playlists::playlist_reorder,
            commands::playlists::playlist_export_m3u,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
