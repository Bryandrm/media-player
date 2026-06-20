//! Forced alignment de letras vía WhisperX + mismatch detection.
//!
//! Pipeline (Fase A — alignment):
//!   1. Leer track + lyrics actuales de DB.
//!   2. Parsear synced_lyrics para extraer line timestamps + text.
//!   3. Construir segmentos para whisperx (bounds line-level — limita
//!      acumulación de errores dentro del track).
//!   4. Llamar `whisperx::align()` -> `Vec<WordTiming>`.
//!   5. Convertir a A2 LRC string preservando metadata tags originales.
//!   6. Persistir en `lyrics.synced_lyrics` + `aligned_at`.
//!
//! Pipeline (2.c.4b Nivel 2 — mismatch detection):
//!   1. WhisperX transcribe → texto real del audio.
//!   2. phonemizer (espeak) → IPA de LRC y transcripción.
//!   3. Levenshtein normalizado por línea → score per-line.
//!   Deps extra: `phonemizer` (Python) + `espeak-ng` (sistema).
//!
//! Ver docs/KARAOKE.md.

pub mod whisperx;

use std::path::Path;

use sqlx::SqlitePool;

use crate::db;
use crate::errors::{AppError, AppResult};

/// Cascade entrypoint. Aligna la letra de un track usando WhisperX.
///
/// `script_path` es la ruta al wrapper `karaoke_align.py` resuelta del
/// Tauri resource bundle por el caller (típicamente `commands::karaoke`).
/// Resultado del alignment: score promedio de las palabras alineadas.
pub struct AlignResult {
    pub alignment_score: f64,
}

pub async fn align_track(
    pool: &SqlitePool,
    track_id: i64,
    language: &str,
    script_path: &Path,
) -> AppResult<AlignResult> {
    // 1. Leer lyrics actuales. Para el alignment usamos `original_synced_lyrics`
    //    como fuente — es el LRC raw tal como vino de LRCLIB, sin contaminar
    //    por A2 de aligns anteriores. Si no está poblado (rows pre-fix de
    //    backup), caemos a `synced_lyrics` con un eprintln warning.
    let lyrics = db::lyrics::get_for_track(pool, track_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("lyrics for track {track_id}")))?;
    let synced = match (lyrics.original_synced_lyrics, lyrics.synced_lyrics) {
        (Some(orig), _) => orig,
        (None, Some(s)) => {
            eprintln!(
                "[karaoke] track {track_id}: original_synced_lyrics no poblado \
                 (row pre-fix). Alineando contra synced_lyrics actual — si \
                 venía de un align previo el resultado puede ser incorrecto. \
                 Recovery: DELETE FROM lyrics WHERE track_id={track_id} y re-fetch."
            );
            s
        }
        (None, None) => {
            return Err(AppError::InvalidInput(
                "no synced_lyrics available to align".into(),
            ));
        }
    };

    // 2. Leer file_path + duration del track.
    let track_row: Option<(String, i64)> = sqlx::query_as(
        "SELECT file_path, duration_ms FROM tracks WHERE id = ?",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await?;
    let (file_path, duration_ms) =
        track_row.ok_or_else(|| AppError::NotFound(format!("track {track_id}")))?;

    // 3. Parse LRC + construir segmentos.
    let lines = parse_lrc_lines(&synced);
    if lines.is_empty() {
        return Err(AppError::InvalidInput(
            "no parseable lines in synced_lyrics".into(),
        ));
    }
    let segments = build_segments(&lines, duration_ms);

    // 4. Alinear via whisperx.
    let words =
        whisperx::align(Path::new(&file_path), &segments, language, script_path).await?;

    if words.is_empty() {
        return Err(AppError::WhisperxFailed(
            "whisperx returned 0 word timings".into(),
        ));
    }

    // 5. Calcular score promedio del alignment.
    let scored_words: Vec<f64> = words.iter().map(|w| w.score).collect();
    let alignment_score = if scored_words.is_empty() {
        0.0
    } else {
        scored_words.iter().sum::<f64>() / scored_words.len() as f64
    };
    eprintln!(
        "[karaoke] alignment score: {:.3} ({} words)",
        alignment_score,
        scored_words.len()
    );

    // 6. Convertir a A2 LRC.
    let a2 = build_a2_lrc(&synced, &lines, &words);

    // 7. Persistir.
    db::lyrics::save_aligned(pool, track_id, &a2, Some(alignment_score)).await?;

    Ok(AlignResult { alignment_score })
}

#[derive(Debug, Clone)]
struct LrcLine {
    timestamp_ms: u64,
    text: String,
}

/// Parser minimal de LRC para extraer líneas con timestamp + texto plano.
/// Strippea cualquier marker A2 del texto (cuando estamos re-alineando un
/// track que ya tenía A2). Ignora metadata tags y líneas malformadas.
fn parse_lrc_lines(lrc: &str) -> Vec<LrcLine> {
    let mut lines = Vec::new();
    for raw in lrc.lines() {
        let line = raw.trim();
        if line.is_empty() || !line.starts_with('[') {
            continue;
        }
        let close = match line.find(']') {
            Some(i) => i,
            None => continue,
        };
        let ts_str = &line[1..close];
        let timestamp_ms = match parse_lrc_timestamp(ts_str) {
            Some(ms) => ms,
            None => continue, // metadata tag (e.g., [ar:Avicii]) — saltar
        };
        let text_part = &line[close + 1..];
        let text = strip_a2_markers(text_part).trim().to_string();
        if text.is_empty() {
            continue; // líneas vacías de silencio — no hay nada que alinear
        }
        lines.push(LrcLine {
            timestamp_ms,
            text,
        });
    }
    lines.sort_by_key(|l| l.timestamp_ms);
    lines
}

fn parse_lrc_timestamp(ts: &str) -> Option<u64> {
    // Formato: mm:ss.xx (centésimas) o mm:ss.xxx (milésimas) o mm:ss.
    let (mins_str, rest) = ts.split_once(':')?;
    let mins: u64 = mins_str.parse().ok()?;
    let (secs_str, frac_str) = match rest.split_once('.') {
        Some((s, f)) => (s, f),
        None => (rest, "0"),
    };
    let secs: u64 = secs_str.parse().ok()?;
    let frac_ms: u64 = if frac_str.is_empty() {
        0
    } else if frac_str.len() == 3 {
        // milésimas
        frac_str.parse().ok()?
    } else {
        // centésimas (default LRC) — pad a 2 dígitos y multiplicar por 10
        let padded = format!("{:0<2}", frac_str);
        let cs: u64 = padded[..2].parse().ok()?;
        cs * 10
    };
    Some(mins * 60_000 + secs * 1000 + frac_ms)
}

/// Quita los markers `<mm:ss.xx>` de A2 LRC, dejando sólo el texto plano.
/// Útil para re-alineación de un track que ya tenía A2.
fn strip_a2_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '<' {
            // Skip until '>' o EOL.
            for d in chars.by_ref() {
                if d == '>' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Construye los segmentos para whisperx desde las líneas parseadas.
///
/// **Estrategia: un segmento por línea con bounds TIGHT del LRC** —
/// `[line.start, next_line.start]`.
///
/// Decisión tomada empíricamente tras intentar tres enfoques:
///
/// 1. **Bounds tight (LRC exact)** ← actual. Sirve cuando el LRC está
///    razonablemente bien alineado (caso típico LRCLIB). WhisperX se
///    constriñe a la ventana correcta y produce timestamps precisos.
/// 2. **Sin bounds (whole-track)** — descartado. WhisperX greedy-matches
///    fonemas desde t=0 y empuja todas las palabras al intro instrumental.
/// 3. **Bounds con buffer ±3s** — descartado. Daba a whisperx demasiada
///    libertad: "There's" se asignaba a algún sonido instrumental 2s
///    antes del canto real. El "tolerar drift del LRC" quedó como tarea
///    futura — si en práctica vemos LRC con drift grande, exploraremos
///    detección de drift por VAD o forced alignment con prompt.
///
/// Para tracks con LRC drifty, el usuario puede usar SLOWER/FASTER manual
/// post-align o re-fetchear el LRC (que a veces LRCLIB tiene mejores
/// versiones con el tiempo).
fn build_segments(lines: &[LrcLine], audio_duration_ms: i64) -> Vec<whisperx::AlignSegment> {
    let dur = audio_duration_ms.max(0) as u64;
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let start_ms = line.timestamp_ms;
            let end_ms = if i + 1 < lines.len() {
                lines[i + 1].timestamp_ms
            } else if dur > start_ms {
                dur
            } else {
                start_ms + 30_000
            };
            whisperx::AlignSegment {
                start: start_ms as f64 / 1000.0,
                end: end_ms as f64 / 1000.0,
                text: line.text.clone(),
            }
        })
        .collect()
}

/// Convierte el resultado de whisperx a un LRC formato A2:
///   `[mm:ss.xx]<mm:ss.xx>word1 <mm:ss.xx>word2 ...`
///
/// Estrategia: caminamos las líneas en orden y consumimos los WordTimings
/// en el orden recibido (whisperx preserva el orden del input). Si por
/// alguna razón whisperx devuelve menos palabras que las que mandamos
/// (raro pero posible), las líneas finales quedan con las palabras
/// faltantes sin timestamp — no roto, sólo degradado al fill linear.
///
/// Preservamos los metadata tags del LRC original (`[ar:...]`, `[ti:...]`,
/// etc) en el output.
fn build_a2_lrc(original_lrc: &str, lines: &[LrcLine], words: &[whisperx::WordTiming]) -> String {
    // Extraer metadata tags del LRC original.
    let metadata_tags: Vec<String> = original_lrc
        .lines()
        .filter_map(|raw| {
            let line = raw.trim();
            if !line.starts_with('[') {
                return None;
            }
            let close = line.find(']')?;
            let inner = &line[1..close];
            // Metadata tags tienen letra como primer char (ti, ar, al, etc).
            // Timestamps tienen dígito.
            let first = inner.chars().next()?;
            if first.is_ascii_digit() {
                None
            } else {
                Some(line.to_string())
            }
        })
        .collect();

    let mut out = String::new();
    for tag in &metadata_tags {
        out.push_str(tag);
        out.push('\n');
    }
    if !metadata_tags.is_empty() {
        out.push('\n');
    }

    // Pre-asignación de word timings a líneas: tomamos N palabras consecutivas
    // de `words` por línea, donde N = palabras de `line.text`. WhisperX devuelve
    // las palabras en el mismo orden que las mandamos, así que slicing por count
    // funciona. Si por alguna razón whisperx devuelve menos palabras (raro), las
    // últimas líneas quedan sin word timings — escribimos plain.
    let mut word_idx = 0usize;
    for line in lines {
        let line_words: Vec<&str> = line.text.split_whitespace().collect();
        let take_n = line_words.len().min(words.len().saturating_sub(word_idx));
        let line_word_timings: &[whisperx::WordTiming] =
            &words[word_idx..word_idx + take_n];
        word_idx += take_n;

        // Line marker: usamos el start de la PRIMERA palabra de la línea (lo
        // que whisperx detectó como el momento real). Eso reemplaza el
        // `line.timestamp_ms` original del LRC — que típicamente tenía drift
        // o estaba mal alineado al audio del usuario. Para el frontend nuestro
        // esto es secundario (effectiveOf usa wordTimestampsMs[0]); pero para
        // OTROS players LRC que no entienden A2, el line marker es lo único
        // que pueden leer, así que es importante que sea accurate.
        let line_marker_ms = line_word_timings
            .first()
            .map(|wt| (wt.start.max(0.0) * 1000.0) as u64)
            .unwrap_or(line.timestamp_ms);
        out.push_str(&format_lrc_timestamp(line_marker_ms, true));

        // Markers por palabra.
        for (i, word) in line_words.iter().enumerate() {
            if let Some(wt) = line_word_timings.get(i) {
                let word_ms = (wt.start.max(0.0) * 1000.0) as u64;
                out.push('<');
                out.push_str(&format_lrc_timestamp(word_ms, false));
                out.push('>');
                out.push_str(word);
            } else {
                // Sin más word timings — escribimos la palabra plain.
                out.push_str(word);
            }
            out.push(' ');
        }
        if out.ends_with(' ') {
            out.pop();
        }

        // Trailing marker = end timestamp de la última palabra alineada.
        // Sin esto, la última palabra se sigue rellenando durante el silencio
        // entre líneas — visible al usuario como "letra avanza durante espacio
        // vacío".
        if let Some(wt) = line_word_timings.last() {
            let end_ms = (wt.end.max(0.0) * 1000.0) as u64;
            out.push('<');
            out.push_str(&format_lrc_timestamp(end_ms, false));
            out.push('>');
        }
        out.push('\n');
    }

    out
}

/// Formato `[mm:ss.xx]` (con brackets) o `mm:ss.xx` (sin brackets, para A2 inner).
fn format_lrc_timestamp(ms: u64, with_brackets: bool) -> String {
    let mins = ms / 60_000;
    let secs = (ms / 1000) % 60;
    let cs = (ms / 10) % 100;
    if with_brackets {
        format!("[{:02}:{:02}.{:02}]", mins, secs, cs)
    } else {
        format!("{:02}:{:02}.{:02}", mins, secs, cs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_lrc() {
        let lrc = "[ar:Test]\n[ti:Song]\n[00:25.43]Hello world\n[00:30.10]Second line";
        let lines = parse_lrc_lines(lrc);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].timestamp_ms, 25_430);
        assert_eq!(lines[0].text, "Hello world");
        assert_eq!(lines[1].timestamp_ms, 30_100);
    }

    #[test]
    fn parses_lrc_with_a2_strips_markers() {
        let lrc = "[00:25.43]<00:25.43>Hello <00:25.85>world";
        let lines = parse_lrc_lines(lrc);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello world");
    }

    #[test]
    fn parse_timestamp_centiseconds() {
        assert_eq!(parse_lrc_timestamp("00:25.43"), Some(25_430));
        assert_eq!(parse_lrc_timestamp("01:00.00"), Some(60_000));
        assert_eq!(parse_lrc_timestamp("00:00.00"), Some(0));
    }

    #[test]
    fn parse_timestamp_milliseconds() {
        // 3 dígitos = ms directos
        assert_eq!(parse_lrc_timestamp("00:25.430"), Some(25_430));
    }

    #[test]
    fn parse_timestamp_no_fraction() {
        assert_eq!(parse_lrc_timestamp("00:25"), Some(25_000));
    }

    #[test]
    fn parse_timestamp_rejects_metadata_tag_content() {
        // ts_str = "ar:Avicii" — `ar` no parsea como minutos
        assert_eq!(parse_lrc_timestamp("ar:Avicii"), None);
    }

    #[test]
    fn formats_lrc_timestamp() {
        assert_eq!(format_lrc_timestamp(25_430, true), "[00:25.43]");
        assert_eq!(format_lrc_timestamp(25_430, false), "00:25.43");
        assert_eq!(format_lrc_timestamp(0, true), "[00:00.00]");
        assert_eq!(format_lrc_timestamp(60_000, true), "[01:00.00]");
    }

    #[test]
    fn strip_a2_removes_markers() {
        assert_eq!(strip_a2_markers("<00:25.43>Hello <00:25.85>world"), "Hello world");
        assert_eq!(strip_a2_markers("plain text"), "plain text");
    }

    #[test]
    fn builds_segments_with_tight_lrc_bounds() {
        // Cada línea es un segmento. Bounds = [line.start, next_line.start].
        // Para la última línea: end = audio_duration.
        let lines = vec![
            LrcLine { timestamp_ms: 5_000, text: "first".into() },
            LrcLine { timestamp_ms: 10_000, text: "second".into() },
            LrcLine { timestamp_ms: 20_000, text: "third".into() },
        ];
        let segments = build_segments(&lines, 30_000);
        assert_eq!(segments.len(), 3);
        assert!((segments[0].start - 5.0).abs() < 1e-6);
        assert!((segments[0].end - 10.0).abs() < 1e-6);
        assert!((segments[1].start - 10.0).abs() < 1e-6);
        assert!((segments[1].end - 20.0).abs() < 1e-6);
        // Última línea cierra en duration del audio.
        assert!((segments[2].start - 20.0).abs() < 1e-6);
        assert!((segments[2].end - 30.0).abs() < 1e-6);
    }

    #[test]
    fn builds_a2_lrc_uses_whisperx_timestamps_for_line_marker() {
        // Caso realista: el LRC original dice que la línea está en 00:25.43
        // pero whisperx detecta que la primera palabra realmente arranca en
        // 00:27.10 (drift de 1.67s). El line marker en el A2 LRC final usa
        // el timestamp de whisperx, no el del LRC original.
        let original = "[ar:Avicii]\n[ti:The Nights]\n[00:25.43]Once upon\n[00:30.21]Of memories";
        let lines = vec![
            LrcLine { timestamp_ms: 25_430, text: "Once upon".into() }, // LRC drifty
            LrcLine { timestamp_ms: 30_210, text: "Of memories".into() },
        ];
        let words = vec![
            // WhisperX detectó las palabras realmente arrancando en 27.10s
            whisperx::WordTiming { word: "Once".into(), start: 27.10, end: 27.50, score: 0.9 },
            whisperx::WordTiming { word: "upon".into(), start: 27.50, end: 27.80, score: 0.9 },
            whisperx::WordTiming { word: "Of".into(), start: 32.00, end: 32.20, score: 0.9 },
            whisperx::WordTiming { word: "memories".into(), start: 32.20, end: 32.80, score: 0.9 },
        ];
        let a2 = build_a2_lrc(original, &lines, &words);
        assert!(a2.contains("[ar:Avicii]"));
        assert!(a2.contains("[ti:The Nights]"));
        // Line marker usa el start de "Once" (27.10), NO el LRC original (25.43).
        assert!(
            a2.contains("[00:27.10]<00:27.10>Once <00:27.50>upon<00:27.80>"),
            "expected line marker to use whisperx start (27.10), not LRC (25.43). got: {}",
            a2
        );
        assert!(
            a2.contains("[00:32.00]<00:32.00>Of <00:32.20>memories<00:32.80>"),
            "expected line marker for second line at 32.00, got: {}",
            a2
        );
    }
}

// ---------------------------------------------------------------------------
// Mismatch detection (2.c.4b Nivel 2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct MismatchLine {
    pub index: usize,
    pub timestamp_ms: u64,
    pub lrc_text: String,
    pub transcribed_text: String,
    pub lrc_phonemes: String,
    pub transcribed_phonemes: String,
    pub score: f64,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct MismatchResult {
    pub overall_score: f64,
    pub lines: Vec<MismatchLine>,
}

pub async fn detect_mismatch(
    pool: &SqlitePool,
    track_id: i64,
    language: &str,
    script_path: &Path,
) -> AppResult<MismatchResult> {
    let lyrics = db::lyrics::get_for_track(pool, track_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("lyrics for track {track_id}")))?;
    let synced = match (lyrics.original_synced_lyrics, lyrics.synced_lyrics) {
        (Some(orig), _) => orig,
        (None, Some(s)) => s,
        (None, None) => {
            return Err(AppError::InvalidInput(
                "no synced_lyrics available for mismatch detection".into(),
            ));
        }
    };

    let file_path: Option<String> =
        sqlx::query_scalar("SELECT file_path FROM tracks WHERE id = ?")
            .bind(track_id)
            .fetch_optional(pool)
            .await?;
    let file_path =
        file_path.ok_or_else(|| AppError::NotFound(format!("track {track_id}")))?;

    whisperx::detect_mismatch(
        Path::new(&file_path),
        &synced,
        language,
        script_path,
    )
    .await
}
