mod audio;
mod commands;
mod contracts;
mod db;
mod downloader;
mod errors;
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library::library_scan_directory,
            commands::library::library_list_tracks,
            commands::system::check_dependencies,
            commands::downloader::download_track,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
