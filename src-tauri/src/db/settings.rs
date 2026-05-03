//! Queries sobre la tabla `settings` (key/value plano).
//!
//! Pensada para preferencias persistentes que no encajan en otra tabla:
//! API keys (acoustid_api_key), threshold tuning, etc. Todas son strings;
//! quien la consume parsea/serializa según necesidad.

use sqlx::SqlitePool;

use crate::errors::AppResult;

/// Devuelve el valor de una key. `None` si no está seteada.
pub async fn get(pool: &SqlitePool, key: &str) -> AppResult<Option<String>> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(value)
}

/// Inserta o actualiza una key. UPSERT por `key` (PK).
pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}
