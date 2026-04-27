//! Integración con yt-dlp: spawn de child processes, parsing de progreso.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §5.1.
//!
//! Diseño:
//! - `run_yt_dlp` spawnea el binario con flags fijas. Lee **stdout y stderr en
//!   paralelo** y los fan-in a un canal mpsc — yt-dlp imprime el progreso y
//!   los `[youtube]`/`[ExtractAudio]`/etc en STDERR (no stdout); sólo el
//!   `--print after_move:done <path>` va a stdout. Sin esto el progreso era
//!   invisible.
//! - Línea por línea, dispatch por prefijo: `download X/Y/Z` (progreso),
//!   `done <path>` (filepath final), `[<Postprocessor>]` (transición a
//!   converting). Cualquier otra línea queda en `recent_lines` para reportarla
//!   como mensaje de error si yt-dlp falla.
//! - El callback `on_event` se invoca en el task principal (no en los lectores)
//!   — el caller decide qué hacer (típicamente: emit a Tauri event).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::sync::mpsc;

/// Eventos que reporta `run_yt_dlp` al caller. Cubrimos download (con fracción)
/// y postprocess (sólo señal de que arrancó — yt-dlp no reporta fracción para
/// la extracción de audio con ffmpeg).
#[derive(Debug, Clone)]
pub enum DownloadEvent {
    /// Fracción 0..1; -1.0 si yt-dlp todavía no reporta total bytes.
    Progress(f32),
    /// Empezó alguno de los postprocessors ([ExtractAudio], [Metadata], etc).
    PostprocessStarted,
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("failed to spawn yt-dlp: {0}")]
    Spawn(std::io::Error),
    #[error("yt-dlp io error: {0}")]
    Io(std::io::Error),
    #[error("yt-dlp failed: {0}")]
    NonZeroExit(String),
    #[error("yt-dlp finished but no output filepath was captured")]
    NoFilepath,
}

const RECENT_LINES_CAP: usize = 64;

/// Corre yt-dlp para una URL. `library_dir` es la raíz donde se materializa
/// el árbol `<uploader>/<title>.mp3`. Devuelve la ruta absoluta del archivo
/// final (post-conversión + post-move).
pub async fn run_yt_dlp<F>(
    url: &str,
    library_dir: &Path,
    mut on_event: F,
) -> Result<PathBuf, DownloadError>
where
    F: FnMut(DownloadEvent) + Send + 'static,
{
    let pending_dir = library_dir.join("_pending");
    let _ = std::fs::create_dir_all(library_dir);
    let _ = std::fs::create_dir_all(&pending_dir);

    let library_str = library_dir.to_string_lossy().into_owned();
    let temp_arg = format!("temp:{}", pending_dir.display());

    let mut child = Command::new("yt-dlp")
        .args([
            // Ignorar configs globales/usuario. Si el usuario tiene un
            // ~/.config/yt-dlp/config con `--quiet`, nuestro parsing de
            // progreso queda mudo. Acá necesitamos el output completo y
            // determinístico, no la config personal.
            "--ignore-config",
            "--no-quiet",
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
            "--embed-metadata",
            "--embed-thumbnail",
            "--no-playlist",
            "--no-overwrites",
            // `--newline` hace que cada update de progreso vaya en su propia
            // línea (default es overwriting con `\r`). Parseamos el formato
            // default `[download]   X.X% of  YY.YMiB at  ZZ.ZMiB/s ETA ...`
            // directamente — `--progress-template` con TYPES prefix no es
            // soportado por todas las versiones de yt-dlp y caía silente al
            // default sin que detectáramos nada.
            "--newline",
            "-o",
            "%(uploader,channel|Unknown)s/%(title)s.%(ext)s",
            "-P",
            &library_str,
            "-P",
            &temp_arg,
            "--print",
            "after_move:done %(filepath)s",
            url,
        ])
        // yt-dlp es Python; sin esto su stdout/stderr quedan block-buffered
        // cuando están conectados a pipes (no-TTY) y el progreso aparece en
        // tandas grandes en vez de en tiempo real.
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(DownloadError::Spawn)?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Fan-in: dos lectores que mandan líneas al mismo canal. Cuando ambos
    // tx se droppean (EOF en ambos pipes), rx.recv() devuelve None y salimos.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let stdout_task = tokio::spawn(spawn_line_reader(stdout, tx.clone()));
    let stderr_task = tokio::spawn(spawn_line_reader_stderr(stderr, tx));

    let mut final_path: Option<PathBuf> = None;
    let mut recent_lines: Vec<String> = Vec::with_capacity(RECENT_LINES_CAP);

    while let Some(line) = rx.recv().await {
        if recent_lines.len() >= RECENT_LINES_CAP {
            recent_lines.remove(0);
        }
        recent_lines.push(line.clone());

        if let Some(path) = line.strip_prefix("done ") {
            final_path = Some(PathBuf::from(path.trim()));
        } else if let Some(fraction) = parse_default_progress(&line) {
            on_event(DownloadEvent::Progress(fraction));
        } else if is_postprocess_line(&line) {
            on_event(DownloadEvent::PostprocessStarted);
        }
    }

    // Los readers ya terminaron (rx devolvió None), pero esperamos sus tasks
    // para que no queden colgando.
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let status = child.wait().await.map_err(DownloadError::Io)?;

    if !status.success() {
        // Última línea no-vacía como mensaje de error (yt-dlp suele cerrar con
        // "ERROR: <descripción>"). Si no hay nada útil, fallback al exit code.
        let msg = recent_lines
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| format!("yt-dlp exited with code {:?}", status.code()));
        return Err(DownloadError::NonZeroExit(msg));
    }

    final_path.ok_or(DownloadError::NoFilepath)
}

/// Lector genérico: lee del pipe hasta `\n`, después dentro de cada chunk
/// divide por `\r` (yt-dlp en algunas versiones aún usa `\r` aunque pidamos
/// `--newline`), trimea y manda cada línea no-vacía al canal.
async fn spawn_line_reader(stdout: ChildStdout, tx: mpsc::UnboundedSender<String>) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let raw = String::from_utf8_lossy(&buf).into_owned();
        for piece in raw.split(['\r', '\n']) {
            let line = piece.trim();
            if line.is_empty() {
                continue;
            }
            if tx.send(line.to_string()).is_err() {
                return; // receiver dropped
            }
        }
    }
}

// Necesario por el sistema de tipos de tokio: ChildStdout y ChildStderr son
// tipos distintos. Alternativa: trait objects, pero esto es más simple.
async fn spawn_line_reader_stderr(stderr: ChildStderr, tx: mpsc::UnboundedSender<String>) {
    let mut reader = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let raw = String::from_utf8_lossy(&buf).into_owned();
        for piece in raw.split(['\r', '\n']) {
            let line = piece.trim();
            if line.is_empty() {
                continue;
            }
            if tx.send(line.to_string()).is_err() {
                return;
            }
        }
    }
}

/// Parsea el formato default de progreso de yt-dlp:
///   "[download]   X.X% of   YY.YMiB at   Z.ZMiB/s ETA HH:MM:SS"
///   "[download] 100% of   21.43MiB in 00:00:02 at 10.71MiB/s"
///   "[download] Destination: <path>"   ← ESTE NO matchea (no tiene `%`)
///
/// Devuelve la fracción 0..1, o `None` si la línea no es de progreso.
fn parse_default_progress(line: &str) -> Option<f32> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let percent_end = rest.find('%')?;
    let pct: f32 = rest[..percent_end].trim().parse().ok()?;
    Some((pct / 100.0).clamp(0.0, 1.0))
}

/// yt-dlp imprime `[<Postprocessor>] ...` para cada paso después del download.
/// Cubrimos los postprocessors que dispara `--extract-audio --embed-metadata
/// --embed-thumbnail` (y los Fixup* que pueden correr según el formato fuente).
/// Detectarlos nos da el momento exacto en que entramos en fase "CONVERTING".
fn is_postprocess_line(line: &str) -> bool {
    line.starts_with("[ExtractAudio]")
        || line.starts_with("[Metadata]")
        || line.starts_with("[EmbedThumbnail]")
        || line.starts_with("[ThumbnailsConvertor]")
        || line.starts_with("[ffmpeg]")
        || line.starts_with("[Fixup") // FixupM4a, FixupTimestamp, FixupOggOpus, etc.
        || line.starts_with("[VideoConvertor]")
}
