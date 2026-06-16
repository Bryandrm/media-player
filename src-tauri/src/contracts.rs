//! Tipos compartidos con el frontend — serializados vía `invoke()` y eventos.
//!
//! Regla: cualquier tipo que cruce la frontera Rust ↔ TS vive acá.
//! Los módulos de dominio (`db`, `audio`, etc.) los importan.

use serde::{Deserialize, Serialize};

/// Un track en la biblioteca. Refleja la tabla `tracks` pero con sólo los
/// campos que el frontend necesita para listar y reproducir — no es 1:1.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub file_path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: i64,
    pub track_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub format: Option<String>,
    /// Ruta absoluta a la imagen de cover. Puede apuntar al cache
    /// (`<app_cache>/thumbnails/<id>.jpg`) o a un sibling como `cover.jpg`
    /// dentro de la carpeta del track. NULL si no encontramos nada.
    pub cover_art_path: Option<String>,
    /// Estado derivado de la tabla `lyrics` via LEFT JOIN en `list_all`:
    ///   - 'synced'        — hay synced_lyrics (mejor experiencia, karaoke)
    ///   - 'plain'         — sólo plain_lyrics
    ///   - 'instrumental'  — LRCLIB confirmó track sin letras
    ///   - 'not_found'     — buscamos y nadie tenía letras
    ///   - NULL            — todavía no fetcheamos para este track
    /// El frontend lo usa para el indicador en la library.
    pub lyrics_status: Option<String>,

    /// AcoustID UUID propio (distinto del MBID). Útil sólo internamente
    /// para futuras Fase 3 ops; el frontend lo recibe pero no lo usa hoy.
    pub acoustid_id: Option<String>,
    /// MBID de la grabación canónica en MusicBrainz. NULL = nunca
    /// identificamos o el match fue rechazado por low_confidence/no_match.
    /// Cuando está poblado, `lyrics/lrclib.rs::try_lrclib` lo usa como
    /// query exacto a LRCLIB (`?track_mbid=<uuid>`).
    pub mbid_recording: Option<String>,
    /// Estado de la última corrida de identification:
    ///   - 'identified'         — match aceptado, mbid_recording poblado
    ///   - 'low_confidence'     — hubo match pero score < threshold (0.80)
    ///   - 'no_match'           — AcoustID devolvió results: []
    ///   - 'fingerprint_failed' — fpcalc errored
    ///   - 'api_error'          — red / 5xx / quota — retriable
    ///   - NULL                 — nunca se intentó
    /// El frontend lo usa para el indicador ID en la library.
    pub identification_status: Option<String>,
    /// Score numérico de AcoustID (0..1) para el match aceptado. NULL si
    /// no hubo identify exitoso. La UI lo muestra en tooltip del [ID].
    pub acoustid_score: Option<f64>,
}

/// Reporte de un scan de directorio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned: usize,
    pub inserted: usize,
    pub skipped: usize,
    pub errors: usize,
}

/// Playlist del usuario. `track_count` viene de un agregado en SQL (vs traer
/// la lista entera de track_ids en cada list) — el frontend lo muestra al lado
/// del nombre en el sidebar.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub track_count: i64,
}

/// Estado de las dependencias externas. Detectadas al boot. Cada una
/// desbloquea features distintas — el frontend muestra un banner por cada
/// faltante con qué feature se queda inactiva.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub yt_dlp: bool,
    pub ffmpeg: bool,
    /// Chromaprint binary. Necesario para identificación canónica
    /// (AcoustID). Sin él, la feature IDENTIFY queda disabled — el
    /// resto del player funciona idéntico.
    pub fpcalc: bool,
    /// WhisperX binary (instalado vía pipx). Necesario para forced
    /// alignment de letras (per-word timing real). Sin él, la feature
    /// AUTO-ALIGN queda disabled — las letras siguen funcionando con
    /// karaoke fill linear (interpolación dentro de la línea).
    pub whisperx: bool,
}

/// Estados terminales o transitorios de una descarga, espejado en la columna
/// `downloads.status` de la DB.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Postprocessing,
    Completed,
    Failed,
    Skipped, // archivo ya existía en disco — no se re-bajó
}

/// Snapshot de una descarga. Lo que el frontend recibe en la lista del store
/// y en los eventos `download-*`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: i64,
    pub url: String,
    pub status: DownloadStatus,
    /// 0.0 a 1.0; -1 si yt-dlp aún no reporta total bytes (live streams, etc.).
    pub progress: f32,
    pub title: Option<String>,
    pub error: Option<String>,
    pub track_id: Option<i64>,
}

/// Letras de un track. El backend NO parsea el LRC — guarda el blob raw en
/// `synced_lyrics` y deja que el frontend lo parsee al renderizar (el parser
/// vive en `src/lib/lrcParser.ts`).
///
/// `status`:
///   - "found": tenemos contenido en `synced_lyrics` y/o `plain_lyrics`.
///   - "not_found": ningún provider devolvió nada — cacheado para no
///     retry-ear automáticamente.
///   - "manual_pending": (Fase 2) usuario quiere agregar manualmente.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub track_id: i64,
    pub synced_lyrics: Option<String>,
    pub plain_lyrics: Option<String>,
    /// Provider que respondió: "embedded" | "lrclib" | "manual" (Fase 2).
    pub source: Option<String>,
    /// ID en el provider — útil para "submit edit" (Fase 2). null en embedded.
    pub source_id: Option<String>,
    /// 0.0..1.0. Calculado en lrclib provider basado en duration delta.
    /// El frontend muestra warning si está bajo 0.8.
    pub confidence: Option<f64>,
    /// Offset global en ms aplicado a todos los timestamps. El usuario lo
    /// ajusta con los botones [-100][-10][+10][+100][RESET] cuando nota
    /// desincronización. Se persiste para no re-ajustar cada vez.
    pub offset_ms: i64,
    /// Multiplicador de tempo aplicado a los timestamps del LRC para
    /// corregir drift cuando LRCLIB tiene la letra de una edición distinta
    /// del audio del usuario. Default 1.0 (sin corrección). Fórmula:
    /// `audioTimeMs = lrcTimeMs * speed_ratio + offset_ms`. Se prepuebla
    /// automático si `audioDur / lrcLibDur` difiere de 1.0 en >0.5%, y
    /// el usuario lo ajusta fino con los botones SLOWER/FASTER (±0.5%).
    pub speed_ratio: f64,
    /// Timestamp de cuándo corrimos forced alignment para esta letra.
    /// NULL = nunca alineada (fallback al karaoke linear). Cuando hay
    /// valor, `synced_lyrics` está en formato A2 (timestamps por palabra).
    /// Ver docs/KARAOKE.md.
    pub aligned_at: Option<String>,
    /// Backup del LRC raw que vino de LRCLIB la primera vez. Se usa como
    /// fuente de verdad para re-alignments — sin esto, cada RE-ALIGN
    /// operaba sobre el A2 generado por el align anterior, propagando
    /// errores. NULL para rows pre-fix; el caller debe caer a `synced_lyrics`
    /// como fallback en ese caso.
    pub original_synced_lyrics: Option<String>,
    pub status: String,
}
