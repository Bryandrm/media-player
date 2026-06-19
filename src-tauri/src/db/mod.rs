pub mod downloads;
pub mod lyrics;
pub mod settings;
pub mod playlists;
pub mod smart;
pub mod tracks;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

pub type DbError = Box<dyn std::error::Error>;

/// Pool SQLite en un directorio temporal con migraciones aplicadas. Para tests.
#[cfg(test)]
pub async fn test_pool() -> SqlitePool {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("test.db");
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("test pool");
    sqlx::migrate!("./migrations").run(&pool).await.expect("migrations");
    // Leak the tempdir so it lives as long as the pool.
    std::mem::forget(dir);
    pool
}

pub async fn init(data_dir: &Path) -> Result<SqlitePool, DbError> {
    std::fs::create_dir_all(data_dir)?;

    let db_path = data_dir.join("player.db");
    eprintln!("[db] opening {}", db_path.display());

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        // WAL permite lecturas concurrentes con UNA escritura sin que se
        // bloqueen entre sí. Con el journal default (rollback/DELETE), una
        // escritura larga como el persist de una playlist de 16 tracks
        // (fpcalc + insert por archivo) contiende con las lecturas/escrituras
        // que dispara el frontend mientras tanto (ej: persistencia de la
        // posición de playback del track que suena) → SQLITE_BUSY o cuelgues
        // silenciosos. `busy_timeout` reintenta locks transitorios en vez de
        // fallar al toque. `synchronous=NORMAL` es seguro y recomendado con
        // WAL. Ver Gotcha #21.
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(10));

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    let user_tables: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master \
         WHERE type='table' \
         AND name NOT LIKE 'sqlite_%' \
         AND name NOT LIKE '_sqlx_%'",
    )
    .fetch_one(&pool)
    .await?;
    eprintln!("[db] migrations complete, {} user tables", user_tables);

    // Reconciliar descargas huérfanas: filas que quedaron en un estado
    // no-terminal ('downloading'/'postprocessing'/'queued') de una sesión
    // anterior (la app se cerró a mitad de la descarga, así que `finish` nunca
    // corrió). El proceso yt-dlp ya no existe → las marcamos como interrumpidas
    // para que no aparezcan "pegadas" en el historial al reabrir.
    sqlx::query(
        "UPDATE downloads SET status = 'failed', \
         error_message = COALESCE(error_message, 'interrumpido (app cerrada)'), \
         completed_at = CURRENT_TIMESTAMP \
         WHERE status IN ('downloading', 'postprocessing', 'queued')",
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}
