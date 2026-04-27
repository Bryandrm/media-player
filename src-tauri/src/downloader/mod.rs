//! Integración con yt-dlp: spawn de child processes, parsing de progreso.
//!
//! Ver docs/PLAN-reproductor-brutalist.md §5.1.
//!
//! Diseño:
//! - `run_yt_dlp` spawnea el binario con flags fijas, stream-parsea stdout
//!   buscando dos prefijos: `download <bytes>/<total>/<estimate>` (progreso)
//!   y `done <path>` (filepath final post-move). Cualquier otra línea va a
//!   eprintln para debug.
//! - Stderr se acumula en background; si el proceso falla, lo usamos como
//!   mensaje de error visible en la UI.
//! - El callback `on_progress` se invoca en cada progreso parseado — el
//!   caller decide qué hacer (típicamente: emit a Tauri event).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

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
    // create_dir_all es idempotente; si falla no es fatal — yt-dlp también
    // crearía las carpetas, pero pre-crearlas evita race con el primer scan.
    let _ = std::fs::create_dir_all(library_dir);
    let _ = std::fs::create_dir_all(&pending_dir);

    let library_str = library_dir.to_string_lossy().into_owned();
    let temp_arg = format!("temp:{}", pending_dir.display());

    let mut child = Command::new("yt-dlp")
        .args([
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
            "--embed-metadata",
            "--embed-thumbnail",
            "--no-playlist",
            "--no-overwrites",
            "--newline",
            "--progress-template",
            "download %(progress.downloaded_bytes)s/%(progress.total_bytes)s/%(progress.total_bytes_estimate)s",
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(DownloadError::Spawn)?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Stderr en task aparte: si el buffer se llena, yt-dlp se bloquea.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buf).await;
        buf
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut final_path: Option<PathBuf> = None;

    while let Some(line) = lines.next_line().await.map_err(DownloadError::Io)? {
        if let Some(rest) = line.strip_prefix("download ") {
            if let Some(fraction) = parse_progress(rest) {
                on_event(DownloadEvent::Progress(fraction));
            }
        } else if let Some(path) = line.strip_prefix("done ") {
            final_path = Some(PathBuf::from(path.trim()));
        } else if is_postprocess_line(&line) {
            on_event(DownloadEvent::PostprocessStarted);
            eprintln!("[yt-dlp] {}", line);
        } else {
            // Líneas informativas de yt-dlp ([youtube], [download], etc).
            eprintln!("[yt-dlp] {}", line);
        }
    }

    let status = child.wait().await.map_err(DownloadError::Io)?;
    let stderr_text = stderr_task.await.unwrap_or_default();

    if !status.success() {
        let msg = stderr_text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .last()
            .map(str::to_string)
            .unwrap_or_else(|| format!("yt-dlp exited with code {:?}", status.code()));
        return Err(DownloadError::NonZeroExit(msg));
    }

    final_path.ok_or(DownloadError::NoFilepath)
}

/// Parsea "<downloaded>/<total>/<estimate>". Si total es 0 o "NA", cae a
/// estimate. Si ambos son 0/NA, devuelve fraction = -1.0 (indeterminado).
fn parse_progress(s: &str) -> Option<f32> {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() < 3 {
        return None;
    }
    let downloaded = parts[0].trim().parse::<f64>().ok()?;
    let total = parts[1].trim().parse::<f64>().ok().filter(|&t| t > 0.0);
    let estimate = parts[2].trim().parse::<f64>().ok().filter(|&t| t > 0.0);

    let denom = total.or(estimate);
    Some(match denom {
        Some(d) => (downloaded / d).clamp(0.0, 1.0) as f32,
        None => -1.0,
    })
}

/// yt-dlp imprime `[<Postprocessor>] ...` para cada paso después del download.
/// Cubrimos los postprocessors que dispara `--extract-audio --embed-metadata
/// --embed-thumbnail`. Detectarlos nos da el momento exacto en que entramos
/// en fase "CONVERTING".
fn is_postprocess_line(line: &str) -> bool {
    line.starts_with("[ExtractAudio]")
        || line.starts_with("[Metadata]")
        || line.starts_with("[EmbedThumbnail]")
        || line.starts_with("[ffmpeg]")
        || line.starts_with("[FixupM4a]")
}
