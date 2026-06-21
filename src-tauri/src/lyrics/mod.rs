//! Coordinador de la cascade de providers de letras.
//!
//! Estrategia:
//!   1. Embedded (USLT via lofty)
//!   2. LRCLIB (gratis)
//!   2.5 NetEase (gratis, sin key) — ADR-030
//!   3. → mark_not_found
//!
//! **Smart cascade (2.c.4):** el cascade ya NO para en el primer synced que
//! encuentra. Si un provider devuelve synced con `confidence < CONFIDENCE_THRESHOLD`
//! (0.7), lo retiene como candidato (`best_synced`) y sigue buscando en el
//! siguiente provider. Al final devuelve el candidato con mayor confidence.
//! Synced con confidence >= 0.7 retorna inmediatamente (fast path).
//!
//! Política híbrida para plain: lo retenemos como fallback y seguimos
//! buscando synced en el siguiente. Si nadie tiene synced, devolvemos el
//! mejor plain encontrado.
//!
//! Ver docs/LYRICS.md (plan por fases + §15) y
//! docs/PLAN-reproductor-brutalist.md §5.4.

pub mod embedded;
pub mod lrclib;
pub mod netease;

use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::contracts::Lyrics;
use crate::db;
use crate::errors::AppResult;

/// Intervalo mínimo entre requests salientes a providers de letras. Los fetches
/// de letras se gatillan por cambio de track (auto-fetch) y pueden dispararse
/// en ráfaga al recorrer una library grande → LRCLIB/NetEase responden 429.
/// ~3 req/seg es holgado para uso normal (un fetch cada varios minutos nunca
/// toca el gate) y evita el storm en bulk. Ver Gotcha #31.
const MIN_LYRICS_REQUEST_INTERVAL: Duration = Duration::from_millis(300);

/// Gate global del último request a un provider de letras. Serializa + espacia
/// las llamadas salientes entre todos los fetches concurrentes.
fn lyrics_request_gate() -> &'static Mutex<Option<Instant>> {
    static GATE: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(None))
}

/// Espacia los requests: si pasó menos de `MIN_LYRICS_REQUEST_INTERVAL` desde
/// el último, duerme lo que falte. Mantiene el lock mientras duerme para
/// serializar (dos fetches concurrentes no salen juntos).
async fn throttle() {
    let gate = lyrics_request_gate();
    let mut last = gate.lock().await;
    if let Some(prev) = *last {
        let elapsed = prev.elapsed();
        if elapsed < MIN_LYRICS_REQUEST_INTERVAL {
            tokio::time::sleep(MIN_LYRICS_REQUEST_INTERVAL - elapsed).await;
        }
    }
    *last = Some(Instant::now());
}

/// GET a un provider de letras respetando el throttle global + reintento con
/// backoff ante 429 (Too Many Requests). El `req` debe ser cloneable (GET sin
/// body de stream — siempre lo es acá). Tras agotar reintentos, devuelve la
/// última respuesta (el caller decide qué hacer con un 429 final: lo trata
/// como transitorio → no cachea not_found).
pub(crate) async fn send_throttled(
    req: reqwest::RequestBuilder,
) -> AppResult<reqwest::Response> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut backoff = Duration::from_millis(700);
    let mut last_resp: Option<reqwest::Response> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        throttle().await;
        let this = req
            .try_clone()
            .ok_or_else(|| crate::errors::AppError::Other("lyrics request not cloneable".into()))?;
        let resp = this.send().await?;
        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < MAX_ATTEMPTS {
            eprintln!(
                "[lyrics] 429 — backoff {}ms (intento {}/{})",
                backoff.as_millis(),
                attempt,
                MAX_ATTEMPTS
            );
            tokio::time::sleep(backoff).await;
            backoff *= 2;
            last_resp = Some(resp);
            continue;
        }
        return Ok(resp);
    }
    // Agotamos reintentos (siempre 429): devolvemos la última respuesta.
    Ok(last_resp.expect("MAX_ATTEMPTS >= 1"))
}

/// Datos para armar la query a LRCLIB. La capa de comandos los lee de la
/// row del track antes de invocar.
pub struct LyricsQuery<'a> {
    pub track_id: i64,
    pub artist: Option<&'a str>,
    pub title: &'a str,
    pub album: Option<&'a str>,
    pub duration_seconds: u32,
    pub file_path: &'a Path,
}

/// Confidence mínimo para aceptar un resultado synced sin seguir buscando.
/// Por debajo de este umbral, el resultado se retiene como candidato y el
/// cascade sigue al siguiente provider — puede haber un match mejor.
const CONFIDENCE_THRESHOLD: f64 = 0.7;

/// Reemplaza `best` con `candidate` si el candidato tiene mayor confidence.
fn pick_better(best: Option<Lyrics>, candidate: Lyrics) -> Option<Lyrics> {
    match &best {
        Some(current) => {
            let cur_c = current.confidence.unwrap_or(0.0);
            let new_c = candidate.confidence.unwrap_or(0.0);
            if new_c > cur_c {
                Some(candidate)
            } else {
                best
            }
        }
        None => Some(candidate),
    }
}

/// Cascade Embedded → LRCLIB → NetEase. Persiste el resultado en la tabla
/// `lyrics` (incluyendo `not_found` si nadie devolvió nada — para no
/// re-pegarle la próxima vez que el usuario abra el track).
///
/// **Smart cascade (2.c.4):** si un provider devuelve synced con confidence
/// < 0.7, no retorna — lo guarda como candidato y sigue buscando. Al final,
/// persiste y devuelve el mejor candidato encontrado (synced > plain).
pub async fn fetch_lyrics(
    pool: &SqlitePool,
    http: &reqwest::Client,
    query: LyricsQuery<'_>,
) -> AppResult<Option<Lyrics>> {
    let mut best_synced: Option<Lyrics> = None;
    let mut best_plain: Option<Lyrics> = None;
    // Una falla transitoria (429/5xx/red) en algún provider NO debe terminar
    // cacheando el track como not_found — sino un rate limit (típico al bajar
    // letras en masa) marca el track "sin letras" permanente. Si hubo
    // transitorio y no encontramos nada, dejamos el track sin cachear (status
    // null) para reintentar después.
    let mut transient_failure = false;

    // 1. Embedded (sólo plain en Fase 1 — USLT)
    if let Some(found) = embedded::try_embedded(query.track_id, query.file_path)? {
        if found.synced_lyrics.is_some() {
            let c = found.confidence.unwrap_or(0.0);
            if c >= CONFIDENCE_THRESHOLD {
                db::lyrics::upsert(pool, &found).await?;
                return Ok(Some(found));
            }
            best_synced = pick_better(best_synced, found);
        } else {
            best_plain = Some(found);
        }
    }

    // 2. LRCLIB — sólo si tenemos artist (sin artist el match es muy
    //    inexacto, mejor saltar). Errores de red no abortan el cascade.
    if let Some(artist) = query.artist {
        let lrc_query = lrclib::LrcLibQuery {
            artist,
            title: query.title,
            album: query.album,
            duration_seconds: query.duration_seconds,
        };
        match lrclib::try_lrclib(http, query.track_id, &lrc_query).await {
            Ok(Some(found)) => {
                if found.synced_lyrics.is_some() {
                    let c = found.confidence.unwrap_or(0.0);
                    if c >= CONFIDENCE_THRESHOLD {
                        db::lyrics::upsert(pool, &found).await?;
                        return Ok(Some(found));
                    }
                    best_synced = pick_better(best_synced, found);
                } else if best_plain.is_none() {
                    best_plain = Some(found);
                }
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("[lyrics] lrclib error, continuing cascade: {e}");
                transient_failure = true;
            }
        }
    }

    // 2.5 NetEase — siempre se intenta si hay artist y no tenemos synced
    //     de alta confidence aún. Gratis y sin key (ADR-030).
    //     Errores de red no abortan el cascade.
    if let Some(artist) = query.artist {
        let ne_query = netease::NeteaseQuery {
            artist,
            title: query.title,
            duration_seconds: query.duration_seconds,
        };
        match netease::try_netease(http, query.track_id, &ne_query).await {
            Ok(Some(found)) => {
                if found.synced_lyrics.is_some() {
                    let c = found.confidence.unwrap_or(0.0);
                    if c >= CONFIDENCE_THRESHOLD {
                        db::lyrics::upsert(pool, &found).await?;
                        return Ok(Some(found));
                    }
                    best_synced = pick_better(best_synced, found);
                } else if best_plain.is_none() {
                    best_plain = Some(found);
                }
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("[lyrics] netease error, continuing cascade: {e}");
                transient_failure = true;
            }
        }
    }

    // 3. Devolver el mejor candidato: synced > plain.
    if let Some(synced) = best_synced {
        db::lyrics::upsert(pool, &synced).await?;
        return Ok(Some(synced));
    }
    if let Some(plain) = best_plain {
        db::lyrics::upsert(pool, &plain).await?;
        return Ok(Some(plain));
    }

    // 4. Nada encontrado. Si hubo una falla transitoria (rate limit / red), NO
    //    cacheamos not_found: el track queda con status null para reintentar
    //    más tarde (sino un 429 puntual lo marca "sin letras" para siempre).
    if transient_failure {
        eprintln!(
            "[lyrics] track {} sin resultado por falla transitoria — no se cachea not_found",
            query.track_id
        );
        return Ok(None);
    }

    // Todos los providers respondieron limpio sin letra → no-match genuino,
    // cacheamos not_found para no retry-ear automáticamente.
    db::lyrics::mark_not_found(pool, query.track_id).await?;
    Ok(None)
}
