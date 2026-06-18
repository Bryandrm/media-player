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
use tokio::sync::{mpsc, oneshot};

/// Eventos que reporta `run_yt_dlp` al caller. Cubrimos download (con fracción)
/// y postprocess (sólo señal de que arrancó — yt-dlp no reporta fracción para
/// la extracción de audio con ffmpeg).
#[derive(Debug, Clone)]
pub enum DownloadEvent {
    /// Fracción 0..1; -1.0 si yt-dlp todavía no reporta total bytes.
    Progress(f32),
    /// Empezó alguno de los postprocessors ([ExtractAudio], [Metadata], etc).
    PostprocessStarted,
    /// Sólo en descargas de playlist: yt-dlp empezó el item `current` de
    /// `total`. Lo usamos para mostrar "3/12" en la UI.
    ItemProgress { current: u32, total: u32 },
}

/// Un archivo final materializado por yt-dlp. En descargas de un solo video
/// la lista tiene un elemento con `playlist_title`/`playlist_index` en None.
/// En descargas de playlist, uno por entry, con el título de la lista y el
/// índice 1-based (orden original de la playlist).
#[derive(Debug, Clone)]
pub struct DownloadedEntry {
    pub path: PathBuf,
    pub playlist_title: Option<String>,
    pub playlist_index: Option<i64>,
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

/// Borra los temporales abandonados en `_pending` (ej: el track a medio bajar
/// de una descarga cancelada o interrumpida). Se llama al boot, cuando no hay
/// ninguna descarga en curso, así que borrar todo el dir es seguro — yt-dlp lo
/// recrea en la próxima descarga. Best-effort: si falla, no rompe el arranque.
pub fn clean_pending(library_dir: &Path) {
    let pending = library_dir.join("_pending");
    if pending.exists() {
        let _ = std::fs::remove_dir_all(&pending);
    }
}

/// Corre yt-dlp para una URL. `library_dir` es la raíz donde se materializa
/// el árbol `<uploader>/<title>.mp3`. Si `playlist` es false, fuerza
/// `--no-playlist` (un solo video aunque la URL traiga `list=`); si es true,
/// `--yes-playlist` baja la lista completa. Devuelve un entry por archivo
/// final materializado (post-conversión + post-move).
pub async fn run_yt_dlp<F>(
    url: &str,
    library_dir: &Path,
    playlist: bool,
    cookies_browser: Option<&str>,
    cookies_file: Option<&str>,
    mut cancel_rx: oneshot::Receiver<()>,
    mut on_event: F,
) -> Result<(Vec<DownloadedEntry>, bool), DownloadError>
where
    F: FnMut(DownloadEvent) + Send + 'static,
{
    let pending_dir = library_dir.join("_pending");
    let _ = std::fs::create_dir_all(library_dir);
    let _ = std::fs::create_dir_all(&pending_dir);

    let library_str = library_dir.to_string_lossy().into_owned();
    let temp_arg = format!("temp:{}", pending_dir.display());

    // El template de `--print` emite los campos separados por TAB para que el
    // parser los split-ee sin ambigüedad (los títulos pueden tener espacios,
    // guiones, etc, pero no tabs). `playlist_title`/`playlist_index` salen
    // "NA" en un video suelto → el parser los mapea a None.
    let playlist_flag = if playlist { "--yes-playlist" } else { "--no-playlist" };

    // Cookies: necesarias para playlists privadas, videos con restricción de
    // edad, members-only, etc. Dos fuentes posibles, con el archivo teniendo
    // prioridad:
    //   1. `--cookies <archivo.txt>`  — un cookies.txt exportado a mano. Funciona
    //      con el navegador ABIERTO (no toca su base SQLite). Único camino viable
    //      con Chromium en Windows, donde el lock del archivo de cookies impide
    //      `--cookies-from-browser` mientras el navegador corre (ver Gotcha #18).
    //   2. `--cookies-from-browser <b>` — lee la base del navegador en vivo.
    //      Requiere el navegador cerrado en Chromium/Windows; Firefox anda igual.
    // Sin ninguna de las dos, descarga anónima (default).
    let cookie_args: Vec<&str> = match (cookies_file, cookies_browser) {
        (Some(f), _) if !f.is_empty() => vec!["--cookies", f],
        (_, Some(b)) if !b.is_empty() => vec!["--cookies-from-browser", b],
        _ => vec![],
    };

    let mut child = Command::new("yt-dlp")
        .args(&cookie_args)
        .args([
            // Ignorar configs globales/usuario. Si el usuario tiene un
            // ~/.config/yt-dlp/config con `--quiet`, nuestro parsing de
            // progreso queda mudo. Acá necesitamos el output completo y
            // determinístico, no la config personal.
            "--ignore-config",
            "--no-quiet",
            // Forzar UTF-8 en el output de yt-dlp. En Windows, la consola usa
            // un codepage legacy (ej Latin-1/cp1252) y yt-dlp, al imprimir el
            // `after_move:filepath`, REEMPLAZA los caracteres no representables
            // (kanji, hangul, `：` fullwidth, etc) por espacios. Pero el ARCHIVO
            // en disco sí los tiene (la creación usa la API wide de Windows).
            // Resultado: el path impreso ≠ el path real → `extract_metadata`
            // falla con "no such file" y el track no se persiste. Con
            // `--encoding utf-8` el path impreso coincide byte-a-byte con disco
            // (nuestro reader ya decodifica UTF-8). Ver Gotcha #22.
            "--encoding",
            "utf-8",
            // YouTube exige resolver un challenge de JavaScript (firma + param
            // `n` de throttling) para entregar los formatos de audio/video. Sin
            // un runtime de JS, yt-dlp solo obtiene storyboards → "Requested
            // format is not available" para todos los items. El solver
            // (`yt_dlp_ejs`) ya viene con yt-dlp, pero por default SÓLO habilita
            // Deno; Node hay que activarlo explícito. Usamos Node (≥22) porque
            // ya es dep del entorno de este proyecto. Si en el futuro querés
            // Deno, es el runtime recomendado por yt-dlp y se auto-detecta sin
            // este flag. Ver Gotcha #20.
            "--js-runtimes",
            "node",
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0",
            "--embed-metadata",
            "--embed-thumbnail",
            playlist_flag,
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
            "after_move:done\t%(filepath)s\t%(playlist_title)s\t%(playlist_index)s",
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

    let mut entries: Vec<DownloadedEntry> = Vec::new();
    // Título de la playlist capturado de la línea "Downloading playlist:" —
    // fallback para nombrar la lista cuando TODOS los items ya estaban bajados
    // (y por ende ningún `done` trae el `playlist_title`).
    let mut playlist_title_hint: Option<String> = None;
    let mut recent_lines: Vec<String> = Vec::with_capacity(RECENT_LINES_CAP);
    // Líneas `ERROR: ...` que imprime yt-dlp por cada item que falla. Las
    // guardamos aparte porque en playlists largas se van del buffer de
    // `recent_lines` antes de terminar → el mensaje de error caía en la última
    // línea de stderr ("Finished downloading playlist", un falso positivo).
    let mut error_lines: Vec<String> = Vec::new();

    let mut cancelled = false;
    loop {
        let line = if cancelled {
            // Ya matamos el child; sólo drenamos las líneas que queden en el
            // canal hasta EOF (para no perder `done` ya emitidos).
            match rx.recv().await {
                Some(l) => l,
                None => break,
            }
        } else {
            tokio::select! {
                maybe = rx.recv() => match maybe {
                    Some(l) => l,
                    None => break,
                },
                _ = &mut cancel_rx => {
                    // Cancelación del usuario: matamos yt-dlp y pasamos a modo
                    // drenado. Los archivos ya bajados quedan en `entries` →
                    // el caller los persiste (éxito parcial).
                    let _ = child.start_kill();
                    cancelled = true;
                    continue;
                }
            }
        };
        if recent_lines.len() >= RECENT_LINES_CAP {
            recent_lines.remove(0);
        }
        recent_lines.push(line.clone());
        if line.starts_with("ERROR") && error_lines.len() < RECENT_LINES_CAP {
            error_lines.push(line.clone());
        }

        if let Some(rest) = line.strip_prefix("done\t") {
            if let Some(entry) = parse_done_line(rest) {
                entries.push(entry);
            }
        } else if let Some(fraction) = parse_default_progress(&line) {
            on_event(DownloadEvent::Progress(fraction));
        } else if let Some((current, total)) = parse_item_progress(&line) {
            on_event(DownloadEvent::ItemProgress { current, total });
        } else if let Some(title) = parse_downloading_playlist(&line) {
            playlist_title_hint = Some(title);
        } else if let Some(path) = parse_already_downloaded(&line) {
            // `--no-overwrites` salteó el download → no corre el hook after_move
            // que imprime `done`. Recuperamos el path para que el track ya
            // existente igual se agregue a la playlist. Best-effort: si el path
            // no matchea un track, el caller lo ignora.
            entries.push(DownloadedEntry {
                path,
                playlist_title: None,
                playlist_index: None,
            });
        } else if is_postprocess_line(&line) {
            on_event(DownloadEvent::PostprocessStarted);
        }
    }

    // Backfill del título de playlist en los entries que no lo traen (los
    // recuperados de "already downloaded").
    if let Some(title) = &playlist_title_hint {
        for e in entries.iter_mut() {
            if e.playlist_title.is_none() {
                e.playlist_title = Some(title.clone());
            }
        }
    }

    // Dedup por path: si un mismo archivo apareció por `done` Y por "already
    // downloaded", nos quedamos con el que trae playlist_index (más rico). El
    // sort estable pone los que tienen índice primero; retain conserva el
    // primero de cada path.
    entries.sort_by_key(|e| e.playlist_index.is_none());
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert(e.path.clone()));

    // Los readers ya terminaron (rx devolvió None), pero esperamos sus tasks
    // para que no queden colgando.
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let status = child.wait().await.map_err(DownloadError::Io)?;

    // Cancelado por el usuario: devolvemos lo parcial (puede estar vacío) con el
    // flag, sin tratar el exit non-zero del kill como error.
    if cancelled {
        return Ok((entries, true));
    }

    // yt-dlp devuelve exit code ≠ 0 si CUALQUIER item de una playlist falló
    // (video borrado/privado/region-locked), aunque el resto se haya bajado
    // perfecto. Si capturamos al menos un archivo, es un éxito parcial: nos
    // quedamos con lo bueno en vez de descartar la lista entera. Sólo es falla
    // real cuando no se materializó NADA (URL inválida, auth, fpcalc, etc).
    if !entries.is_empty() {
        return Ok((entries, false));
    }

    if !status.success() {
        // Preferimos las líneas `ERROR:` capturadas (dicen el motivo real por
        // item: formato no disponible, privado, age-restricted, etc) sobre la
        // última línea de stderr, que en playlists suele ser un mensaje de
        // éxito confuso. Mostramos hasta 3 distintas + un conteo del resto.
        let msg = if !error_lines.is_empty() {
            let mut unique: Vec<String> = Vec::new();
            for e in &error_lines {
                if !unique.contains(e) {
                    unique.push(e.clone());
                }
            }
            let shown = unique.len().min(3);
            let mut m = unique[..shown].join(" | ");
            if unique.len() > shown {
                m.push_str(&format!(" | (+{} errores más)", unique.len() - shown));
            }
            m
        } else {
            recent_lines
                .iter()
                .rev()
                .find(|l| !l.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| format!("yt-dlp exited with code {:?}", status.code()))
        };
        return Err(DownloadError::NonZeroExit(msg));
    }

    Err(DownloadError::NoFilepath)
}

/// Parsea una línea `done\t<filepath>\t<playlist_title>\t<playlist_index>`
/// (sin el prefijo "done\t", ya strip-eado por el caller). `playlist_title`
/// y `playlist_index` valen "NA" cuando no es una playlist → los mapeamos a
/// None. Devuelve None si no hay filepath (línea corrupta).
fn parse_done_line(rest: &str) -> Option<DownloadedEntry> {
    let mut parts = rest.split('\t');
    let path = parts.next()?.trim();
    if path.is_empty() {
        return None;
    }
    let na_to_none = |s: Option<&str>| -> Option<String> {
        let v = s?.trim();
        if v.is_empty() || v == "NA" {
            None
        } else {
            Some(v.to_string())
        }
    };
    let playlist_title = na_to_none(parts.next());
    let playlist_index = parts.next().and_then(|s| s.trim().parse::<i64>().ok());
    Some(DownloadedEntry {
        path: PathBuf::from(path),
        playlist_title,
        playlist_index,
    })
}

/// Parsea `[download] Downloading item N of M` (yt-dlp lo imprime al empezar
/// cada entry de una playlist). Versiones viejas decían "video" en vez de
/// "item" — cubrimos ambas. Devuelve (current, total).
fn parse_item_progress(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let rest = rest
        .strip_prefix("Downloading item ")
        .or_else(|| rest.strip_prefix("Downloading video "))?;
    let (cur, total) = rest.split_once(" of ")?;
    Some((cur.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// Parsea `[download] Downloading playlist: <title>` — yt-dlp lo imprime al
/// arrancar una playlist, aun si todos los items ya estaban descargados.
/// Fallback para nombrar la lista cuando ningún `done` trae el título.
fn parse_downloading_playlist(line: &str) -> Option<String> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let title = rest.strip_prefix("Downloading playlist:")?.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// Parsea `[download] <path> has already been downloaded` — yt-dlp lo imprime
/// cuando `--no-overwrites` saltea un archivo ya presente. Recuperamos el path
/// para agregar el track existente a la playlist aunque no haya `done`.
fn parse_already_downloaded(line: &str) -> Option<PathBuf> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let path = rest.strip_suffix("has already been downloaded")?.trim();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_line_single_video_has_no_playlist_fields() {
        // Video suelto: playlist_title/index salen "NA" → None.
        let entry = parse_done_line("/lib/Artist/Song.mp3\tNA\tNA").expect("parse");
        assert_eq!(entry.path, PathBuf::from("/lib/Artist/Song.mp3"));
        assert_eq!(entry.playlist_title, None);
        assert_eq!(entry.playlist_index, None);
    }

    #[test]
    fn done_line_playlist_parses_title_and_index() {
        let entry = parse_done_line("/lib/Artist/Song.mp3\tMy Mix\t3").expect("parse");
        assert_eq!(entry.playlist_title.as_deref(), Some("My Mix"));
        assert_eq!(entry.playlist_index, Some(3));
    }

    #[test]
    fn done_line_empty_path_is_rejected() {
        assert!(parse_done_line("\tMy Mix\t3").is_none());
    }

    #[test]
    fn item_progress_parses_item_and_video_wording() {
        assert_eq!(
            parse_item_progress("[download] Downloading item 3 of 12"),
            Some((3, 12))
        );
        assert_eq!(
            parse_item_progress("[download] Downloading video 1 of 5"),
            Some((1, 5))
        );
        assert_eq!(parse_item_progress("[download]  50.0% of 4.00MiB"), None);
    }

    #[test]
    fn downloading_playlist_captures_title() {
        assert_eq!(
            parse_downloading_playlist("[download] Downloading playlist: Summer 2026"),
            Some("Summer 2026".to_string())
        );
        assert_eq!(parse_downloading_playlist("[download] 50.0% of 4MiB"), None);
    }

    #[test]
    fn already_downloaded_recovers_path() {
        assert_eq!(
            parse_already_downloaded("[download] /lib/Artist/Song.mp3 has already been downloaded"),
            Some(PathBuf::from("/lib/Artist/Song.mp3"))
        );
        assert_eq!(
            parse_already_downloaded("[download] Destination: /lib/x.mp3"),
            None
        );
    }

    #[test]
    fn default_progress_parses_percent() {
        assert_eq!(parse_default_progress("[download]  50.0% of 4.00MiB"), Some(0.5));
        assert_eq!(parse_default_progress("[download] Destination: x"), None);
    }
}
