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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::library_scan_directory,
            commands::library::library_list_tracks,
            commands::library::library_backfill_covers,
            commands::library::library_backfill_metadata,
            commands::system::check_dependencies,
            commands::downloader::download_track,
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
            commands::playlists::playlist_list,
            commands::playlists::playlist_delete,
            commands::playlists::playlist_rename,
            commands::playlists::playlist_add_track,
            commands::playlists::playlist_remove_track,
            commands::playlists::playlist_get_tracks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
