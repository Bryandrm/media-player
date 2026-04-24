pub mod tracks;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;

pub type DbError = Box<dyn std::error::Error>;

pub async fn init(data_dir: &Path) -> Result<SqlitePool, DbError> {
    std::fs::create_dir_all(data_dir)?;

    let db_path = data_dir.join("player.db");
    eprintln!("[db] opening {}", db_path.display());

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true);

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

    Ok(pool)
}
