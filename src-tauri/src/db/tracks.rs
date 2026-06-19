//! Queries sobre la tabla `tracks`.

use sqlx::SqlitePool;
use std::path::Path;

use crate::audio::TrackMetadata;
use crate::contracts::Track;
use crate::errors::AppResult;

/// Inserta un track. Si el `file_path` ya existe, no hace nada (UNIQUE constraint
/// + ON CONFLICT DO NOTHING → idempotente). Devuelve `Some(id)` si se insertó
/// una fila nueva, `None` si era duplicado y se saltó.
pub async fn insert_from_metadata(
    pool: &SqlitePool,
    file_path: &Path,
    meta: TrackMetadata,
    source_type: &str,
    source_url: Option<&str>,
) -> AppResult<Option<i64>> {
    let file_path_str = file_path.to_string_lossy().into_owned();

    let result = sqlx::query(
        "INSERT INTO tracks (
            file_path, title, artist, album, duration_ms,
            track_number, year, genre,
            source_type, source_url, bitrate, sample_rate, format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_path) DO NOTHING",
    )
    .bind(&file_path_str)
    .bind(&meta.title)
    .bind(&meta.artist)
    .bind(&meta.album)
    .bind(meta.duration_ms)
    .bind(meta.track_number)
    .bind(meta.year)
    .bind(&meta.genre)
    .bind(source_type)
    .bind(source_url)
    .bind(meta.bitrate)
    .bind(meta.sample_rate)
    .bind(&meta.format)
    .execute(pool)
    .await?;

    if result.rows_affected() > 0 {
        Ok(Some(result.last_insert_rowid()))
    } else {
        Ok(None)
    }
}

/// Devuelve el id de un track por file_path, si existe.
pub async fn find_id_by_path(pool: &SqlitePool, file_path: &Path) -> AppResult<Option<i64>> {
    let file_path_str = file_path.to_string_lossy().into_owned();
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM tracks WHERE file_path = ?")
        .bind(&file_path_str)
        .fetch_optional(pool)
        .await?;
    Ok(id)
}

/// Devuelve el id de un track cuyo fingerprint Chromaprint coincide EXACTO con
/// `fingerprint`, si existe. Usado por el downloader para dedup por contenido:
/// dos archivos con el mismo fingerprint son la misma grabación (mismo master),
/// aunque vengan de uploads distintos con distinto file_path. Match exacto =
/// alta precisión, cero falsos positivos — preferimos dejar un duplicado antes
/// que borrar un track legítimamente distinto (mismo principio que el cleanup,
/// ver Gotcha #11). Un re-encode con master distinto produce otro fingerprint
/// y NO matchea, intencionalmente. Sólo matchea tracks que ya tienen
/// fingerprint cacheado (download nuevo o identify previo); los pre-feature
/// con `acoustid_fingerprint = NULL` no participan.
pub async fn find_id_by_fingerprint(
    pool: &SqlitePool,
    fingerprint: &str,
) -> AppResult<Option<i64>> {
    let id: Option<i64> =
        sqlx::query_scalar("SELECT id FROM tracks WHERE acoustid_fingerprint = ? LIMIT 1")
            .bind(fingerprint)
            .fetch_optional(pool)
            .await?;
    Ok(id)
}

/// Setea (o limpia) la ruta de cover art para un track existente.
pub async fn set_cover_art(
    pool: &SqlitePool,
    track_id: i64,
    cover_path: Option<&Path>,
) -> AppResult<()> {
    let cover_str = cover_path.map(|p| p.to_string_lossy().into_owned());
    sqlx::query("UPDATE tracks SET cover_art_path = ? WHERE id = ?")
        .bind(cover_str)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Para el backfill de metadata: lista (id, title, artist, source_type) de
/// **todos** los tracks. Originalmente filtrábamos a `source_type='downloaded'`
/// para no tocar locales con metadata curada, pero el filtro era incompleto:
/// tracks descargados manualmente con `yt-dlp` desde CLI y luego scaneados
/// quedan como `'local'` y la metadata noisy escapaba al cleanup. La cleanup
/// es idempotente y conservadora — tracks con metadata limpia pasan sin
/// cambios. Usuarios con metadata local intencionalmente non-standard pueden
/// optar por no clickear el botón.
pub async fn list_for_metadata_backfill(
    pool: &SqlitePool,
) -> AppResult<Vec<(i64, String, Option<String>, String)>> {
    let rows: Vec<(i64, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, title, artist, source_type FROM tracks",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Actualiza title + artist de un track. Usado por el backfill de cleanup
/// metadata. Sólo updateamos los campos que la cleanup puede modificar —
/// album/year/genre/etc. los preservamos como están.
pub async fn update_title_and_artist(
    pool: &SqlitePool,
    track_id: i64,
    title: &str,
    artist: Option<&str>,
) -> AppResult<()> {
    sqlx::query("UPDATE tracks SET title = ?, artist = ? WHERE id = ?")
        .bind(title)
        .bind(artist)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Lista todos los tracks ordenados por artista + álbum + número de pista.
/// Incluye `lyrics_status` derivado de la tabla `lyrics` via LEFT JOIN —
/// computado en SQL para no necesitar una segunda query del frontend.
pub async fn list_all(pool: &SqlitePool) -> AppResult<Vec<Track>> {
    // CASE expression resuelve los 5 estados posibles (ver Track.lyrics_status
    // en contracts.rs). Orden de WHEN importa: 'not_found' antes que el check
    // de synced/plain (porque una row con status='not_found' tiene synced y
    // plain en NULL, pero queremos el estado explícito 'not_found').
    let rows = sqlx::query_as::<_, Track>(
        "SELECT t.id, t.file_path, t.title, t.artist, t.album, t.duration_ms,
                t.track_number, t.year, t.genre, t.format, t.cover_art_path,
                CASE
                    WHEN l.track_id IS NULL THEN NULL
                    WHEN l.status = 'not_found' THEN 'not_found'
                    WHEN l.synced_lyrics IS NOT NULL THEN 'synced'
                    WHEN l.plain_lyrics IS NOT NULL THEN 'plain'
                    ELSE 'instrumental'
                END AS lyrics_status,
                t.acoustid_id, t.mbid_recording, t.identification_status,
                t.acoustid_score
         FROM tracks t
         LEFT JOIN lyrics l ON l.track_id = t.id
         ORDER BY
           COALESCE(t.artist, 'ZZZ'),
           COALESCE(t.album, 'ZZZ'),
           COALESCE(t.track_number, 0),
           t.title",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Snapshot mínimo del track para el cascade de identification: lo que
/// necesitamos leer antes de fingerprintear. La duración la usamos sólo si
/// el fingerprint ya está cacheado (skipping fpcalc); cuando recalculamos,
/// fpcalc devuelve la suya propia.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TrackForIdentification {
    pub file_path: String,
    pub duration_ms: i64,
    pub acoustid_fingerprint: Option<String>,
}

pub async fn get_for_identification(
    pool: &SqlitePool,
    track_id: i64,
) -> AppResult<Option<TrackForIdentification>> {
    let row = sqlx::query_as::<_, TrackForIdentification>(
        "SELECT file_path, duration_ms, acoustid_fingerprint \
         FROM tracks WHERE id = ?",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Guarda el fingerprint computado por fpcalc — separado del save_identification
/// porque queremos cachearlo aunque la llamada a AcoustID falle (un retry de
/// `api_error` no debe re-correr fpcalc, que es la parte CPU-intensiva).
pub async fn save_fingerprint(
    pool: &SqlitePool,
    track_id: i64,
    fingerprint: &str,
) -> AppResult<()> {
    sqlx::query("UPDATE tracks SET acoustid_fingerprint = ? WHERE id = ?")
        .bind(fingerprint)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Persiste un match aceptado de AcoustID. Pisa title/artist con los valores
/// canónicos de MusicBrainz y guarda los originales en original_title/
/// original_artist (sólo la primera vez — si ya estaban poblados de un
/// identify previo, no los sobreescribimos para preservar el verdadero
/// "antes" en caso de re-identifies sucesivos).
///
/// Si `canonical_title` o `canonical_artist` vienen vacíos (recording de MB
/// con metadata incompleta), no pisamos ese campo — preferimos retener lo
/// que ya teníamos.
///
/// `score` es el confidence numérico devuelto por AcoustID (0..1). Lo
/// persistimos para el tooltip en la UI + análisis empírico del threshold.
pub async fn save_identification(
    pool: &SqlitePool,
    track_id: i64,
    acoustid_id: &str,
    mbid: &str,
    canonical_title: &str,
    canonical_artist: &str,
    score: f64,
    genre: Option<&str>,
    year: Option<i64>,
    album: Option<&str>,
) -> AppResult<()> {
    // Pisamos title/artist/genre/album si vienen con valor no vacío. `year`
    // sólo se pisa si vino Some — usamos sentinel -1 en la query: el bind
    // numérico nullable es awkward con sqlx + CASE, así que -1=mantener.
    // original_*: poblamos sólo si todavía es NULL (primer identify).
    let genre_for_bind = genre.unwrap_or("").to_string();
    let album_for_bind = album.unwrap_or("").to_string();
    let year_for_bind = year.unwrap_or(-1);

    sqlx::query(
        "UPDATE tracks SET \
            acoustid_id = ?, \
            mbid_recording = ?, \
            acoustid_score = ?, \
            identification_status = 'identified', \
            identification_attempted_at = CURRENT_TIMESTAMP, \
            original_title = CASE WHEN original_title IS NULL THEN title ELSE original_title END, \
            original_artist = CASE WHEN original_artist IS NULL THEN artist ELSE original_artist END, \
            title = CASE WHEN ? != '' THEN ? ELSE title END, \
            artist = CASE WHEN ? != '' THEN ? ELSE artist END, \
            genre = CASE WHEN ? != '' THEN ? ELSE genre END, \
            album = CASE WHEN ? != '' THEN ? ELSE album END, \
            year = CASE WHEN ? >= 0 THEN ? ELSE year END \
         WHERE id = ?",
    )
    .bind(acoustid_id)
    .bind(mbid)
    .bind(score)
    .bind(canonical_title)
    .bind(canonical_title)
    .bind(canonical_artist)
    .bind(canonical_artist)
    .bind(&genre_for_bind)
    .bind(&genre_for_bind)
    .bind(&album_for_bind)
    .bind(&album_for_bind)
    .bind(year_for_bind)
    .bind(year_for_bind)
    .bind(track_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Helper para el backfill de MB metadata. Pisa cada campo SOLO si el caller
/// pasó Some con valor no vacío. Mismo principio que save_identification:
/// nunca descartamos lo que el usuario tenía si MB no devuelve nada para ese
/// campo.
pub async fn set_mb_metadata(
    pool: &SqlitePool,
    track_id: i64,
    genre: Option<&str>,
    year: Option<i64>,
    album: Option<&str>,
) -> AppResult<()> {
    let genre_for_bind = genre.unwrap_or("").to_string();
    let album_for_bind = album.unwrap_or("").to_string();
    let year_for_bind = year.unwrap_or(-1);

    sqlx::query(
        "UPDATE tracks SET \
            genre = CASE WHEN ? != '' THEN ? ELSE genre END, \
            album = CASE WHEN ? != '' THEN ? ELSE album END, \
            year = CASE WHEN ? >= 0 THEN ? ELSE year END \
         WHERE id = ?",
    )
    .bind(&genre_for_bind)
    .bind(&genre_for_bind)
    .bind(&album_for_bind)
    .bind(&album_for_bind)
    .bind(year_for_bind)
    .bind(year_for_bind)
    .bind(track_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Lista los tracks candidatos al backfill de MB metadata: identificados
/// (con `mbid_recording` populado) Y con AL MENOS UNO de los campos MB
/// faltante o sospechoso:
///   - genre NULL/empty/"Music" (categoría YT default)
///   - year NULL
///   - album NULL/empty
///   - cover_art_path NULL
///
/// Tracks con TODOS los campos OK se omiten — evitan re-hit MB innecesario.
/// Devuelve `(id, mbid, cover_art_path)` — el cover indica si hace falta CAA.
pub async fn list_for_mb_backfill(
    pool: &SqlitePool,
) -> AppResult<Vec<(i64, String, Option<String>)>> {
    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id, mbid_recording, cover_art_path FROM tracks \
         WHERE mbid_recording IS NOT NULL AND mbid_recording != '' \
         AND ( \
            genre IS NULL OR genre = '' OR genre = 'Music' \
            OR year IS NULL \
            OR album IS NULL OR album = '' \
            OR cover_art_path IS NULL \
         ) \
         ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Lista los track IDs candidatos para el bulk identify: nunca intentados
/// (`identification_status IS NULL`) o que fallaron por red/quota
/// (`'api_error'`, retriable). Excluye `'identified'` (ya está), `'no_match'`
/// (no va a aparecer), `'low_confidence'` (mismo audio = mismo score) y
/// `'fingerprint_failed'` (problema del archivo).
///
/// Orden por id ASC = orden de inserción ≈ orden estable. No nos importa
/// el orden de proceso, sólo que sea determinístico para que un cancel +
/// retomar siga la misma secuencia.
pub async fn list_identifiable(pool: &SqlitePool) -> AppResult<Vec<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM tracks \
         WHERE identification_status IS NULL \
            OR identification_status = 'api_error' \
         ORDER BY id ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(ids)
}

/// Marca el resultado de un identify que NO fue aceptado (low_confidence,
/// no_match, fingerprint_failed, api_error). No toca title/artist.
/// `identification_attempted_at` se actualiza siempre — útil para Fase 2/3
/// si decidimos política "no retriar antes de N días".
pub async fn update_identification_status(
    pool: &SqlitePool,
    track_id: i64,
    status: &str,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE tracks SET \
            identification_status = ?, \
            identification_attempted_at = CURRENT_TIMESTAMP \
         WHERE id = ?",
    )
    .bind(status)
    .bind(track_id)
    .execute(pool)
    .await?;
    Ok(())
}
