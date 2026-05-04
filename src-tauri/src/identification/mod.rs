//! Identificación canónica de audio vía AcoustID + Chromaprint.
//!
//! Pipeline (Fase 1):
//!   1. fpcalc → fingerprint base64 + duration decodificada
//!   2. AcoustID API → AcoustID id + MBID de MusicBrainz (si score >= 0.85)
//!   3. Persistir en tracks (acoustid_id, mbid_recording, identification_status,
//!      pisa title/artist con la metadata canónica, guarda originales)
//!   4. (caller) re-fetch lyrics priorizando lookup por MBID
//!
//! Patrón mirror de `lyrics/`: dos `async fn` libres en submódulos + un
//! entrypoint cascade. Sin trait — refactor a `IdentificationProvider` recién
//! cuando aparezca un segundo proveedor (Shazam, etc., si llega Fase 3).
//!
//! Ver docs/IDENTIFICATION.md para el plan completo.

pub mod acoustid;
pub mod fpcalc;

use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::db;
use crate::errors::{AppError, AppResult};

/// Threshold conservador. Por debajo, el match no se acepta (status pasa a
/// `low_confidence`). En la práctica AcoustID devuelve >= 0.95 cuando hay
/// match real; valores entre 0.5 y 0.85 suelen ser ruido pero el rango
/// 0.80-0.85 captura matches legítimos limítrofes (typical edge: tracks
/// con encoding distinto al canónico). 0.80 es el valor activo después
/// de validación con la library del autor — track 29 a 0.824 era match
/// correcto. Si vemos falsos positivos, subir a 0.85+.
const SCORE_THRESHOLD: f64 = 0.80;

/// Resultado del cascade tal como se devuelve al frontend. Los campos opcionales
/// están poblados sólo cuando `status == "identified"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentificationResult {
    pub track_id: i64,
    /// Mismo set de strings que `tracks.identification_status`. Ver
    /// `contracts.rs::Track::identification_status`.
    pub status: String,
    pub score: Option<f64>,
    pub mbid: Option<String>,
    pub acoustid_id: Option<String>,
    pub canonical_title: Option<String>,
    pub canonical_artist: Option<String>,
}

impl IdentificationResult {
    fn with_status(track_id: i64, status: &str) -> Self {
        Self {
            track_id,
            status: status.to_string(),
            score: None,
            mbid: None,
            acoustid_id: None,
            canonical_title: None,
            canonical_artist: None,
        }
    }
}

/// Cascade fpcalc → AcoustID → persist. Devuelve siempre un
/// `IdentificationResult` (con `status` que indica qué pasó); sólo propaga
/// `Err` cuando algo "infraestructural" falló de manera retriable
/// (fpcalc no encontrado, AcoustID 5xx, DB caída) — esos casos también dejan
/// el track con `identification_status='api_error'` o `'fingerprint_failed'`
/// para que el usuario vea el estado y pueda re-intentar.
pub async fn identify_track(
    pool: &SqlitePool,
    http: &reqwest::Client,
    track_id: i64,
    api_key: &str,
) -> AppResult<IdentificationResult> {
    // 1. Leer track de DB. Si no existe, error claro (no debería pasar
    //    desde la UI — pero defensivo).
    let track = db::tracks::get_for_identification(pool, track_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("track id {track_id}")))?;

    // 2. Fingerprint: reusar el cacheado si existe (retry de api_error sin
    //    re-correr fpcalc). Si no, computarlo y persistirlo.
    let (fingerprint, duration_seconds) = match track.acoustid_fingerprint {
        Some(fp) => {
            // Duración del track en DB (ms) → segundos. Para retry, fpcalc
            // ya validó esta duración antes — la usamos como aproximación.
            let dur = (track.duration_ms as f32) / 1000.0;
            (fp, dur)
        }
        None => match fpcalc::compute(Path::new(&track.file_path)).await {
            Ok(fp) => {
                db::tracks::save_fingerprint(pool, track_id, &fp.fingerprint).await?;
                (fp.fingerprint, fp.duration_seconds)
            }
            Err(e) => {
                eprintln!("[identify] fpcalc failed for track {track_id}: {e}");
                db::tracks::update_identification_status(
                    pool,
                    track_id,
                    "fingerprint_failed",
                )
                .await?;
                return Ok(IdentificationResult::with_status(
                    track_id,
                    "fingerprint_failed",
                ));
            }
        },
    };

    // 3. AcoustID lookup.
    let lookup_result = acoustid::lookup(http, api_key, &fingerprint, duration_seconds).await;

    let best = match lookup_result {
        Ok(opt) => opt,
        Err(e) => {
            eprintln!("[identify] acoustid lookup failed for track {track_id}: {e}");
            db::tracks::update_identification_status(pool, track_id, "api_error").await?;
            return Ok(IdentificationResult::with_status(track_id, "api_error"));
        }
    };

    // 4. Aplicar threshold + persistir.
    match best {
        None => {
            eprintln!("[identify] no_match for track {track_id}");
            db::tracks::update_identification_status(pool, track_id, "no_match").await?;
            Ok(IdentificationResult::with_status(track_id, "no_match"))
        }
        Some(m) if m.score < SCORE_THRESHOLD => {
            eprintln!(
                "[identify] low_confidence for track {} (score={:.3})",
                track_id, m.score
            );
            db::tracks::update_identification_status(pool, track_id, "low_confidence")
                .await?;
            let mut result = IdentificationResult::with_status(track_id, "low_confidence");
            result.score = Some(m.score);
            Ok(result)
        }
        Some(m) => {
            eprintln!(
                "[identify] identified track {} as '{}' / '{}' (mbid={}, score={:.3})",
                track_id, m.title, m.artist, m.mbid, m.score
            );
            db::tracks::save_identification(
                pool,
                track_id,
                &m.acoustid_id,
                &m.mbid,
                &m.title,
                &m.artist,
                m.score,
            )
            .await?;
            Ok(IdentificationResult {
                track_id,
                status: "identified".into(),
                score: Some(m.score),
                mbid: Some(m.mbid),
                acoustid_id: Some(m.acoustid_id),
                canonical_title: Some(m.title),
                canonical_artist: Some(m.artist),
            })
        }
    }
}
