# Architecture — Brutalist Music Player

> Deep dive técnico. Documento vivo: las secciones marcadas `TODO` están abiertas; el resto refleja la implementación actual (Fase 1 ~90%).
> Decisiones formalizadas viven en [DECISIONS.md](./DECISIONS.md).
> Visión general y scope en [PLAN-reproductor-brutalist.md](./PLAN-reproductor-brutalist.md).
> Convenciones del día a día y footguns en [/CLAUDE.md](../CLAUDE.md).

---

## 1. Vista de alto nivel

```
┌───────────────────────────────────────────────────────────────┐
│                      Tauri Shell (WebView)                    │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                  React + TypeScript                     │  │
│  │  UI · AudioContext · Butterchurn · Zustand stores       │  │
│  └────────────┬──────────────────────────────▲─────────────┘  │
│               │ invoke()                     │ emit/listen    │
│  ┌────────────▼──────────────────────────────┴─────────────┐  │
│  │                    Rust (Tauri Core)                    │  │
│  │  commands::  library · downloader · system              │  │
│  │  db::        sqlx pool + migrate al boot                │  │
│  │  audio::     lofty metadata + cover extraction          │  │
│  │  downloader::yt-dlp spawn · progress parser             │  │
│  │  lyrics::    (stub, pendiente)                          │  │
│  └────────┬──────────────┬──────────────────────────────────┘  │
└───────────│──────────────│────────────────────────────────────┘
            ▼              ▼
       SQLite DB     yt-dlp (child)
       (~/Library/   ↳ ffmpeg (subproc)
        Application
        Support/…)
```

**Regla de separación** (la que más se viola en la práctica si uno se distrae):
- **Audio y WebGL viven en React.** No en Rust. El AudioContext no se puede compartir cross-process.
- **Filesystem, procesos y red viven en Rust.** No en React. Evita CORS, permisos de Tauri más restrictivos, y mantiene el frontend testeable sin Tauri.

---

## 2. Pipeline de audio (el flujo crítico)

```
Archivo en disco  ──►  Tauri expone vía asset protocol
                       (convertFileSrc)
                                │
                                ▼
                <audio> singleton (new Audio() en module scope,
                                   no en JSX — ver §6.2)
                                │
                                ▼
               MediaElementAudioSourceNode (source)
                                │
                                ▼
                      GainNode (masterGain)  ← volume + mute
                                │
                                ├──────► AudioContext.destination
                                │
                                └──► Butterchurn.connectAudio(source)
                                     (tapea el source pre-gain;
                                      el visualizer "ve" la señal
                                      siempre, aunque el usuario
                                      mutee el output)
```

**Implementación:** [src/audio/element.ts](../src/audio/element.ts) y [src/audio/context.ts](../src/audio/context.ts). Una sola instancia de `<audio>`, una sola de `AudioContext`, una sola de `MediaElementAudioSourceNode` (la API sólo permite uno por elemento).

### 2.1 Por qué el volumen va por GainNode, no por `audio.volume`

Una vez que llamás `ctx.createMediaElementSource(audio)`, Chromium **bypassea** `audio.volume` y `audio.muted`. La señal sale del elemento al grafo Web Audio y no respeta los controles HTML. Por eso `setVolume` y `toggleMute` escriben a `masterGain.gain.value`. (Gotcha #2 en CLAUDE.md.)

### 2.2 Validación inicial (2026-04-21)

El smoke test del pipeline confirmó tres requisitos permanentes:

1. **`protocol-asset` es requisito doble** — feature en `Cargo.toml` (`tauri = { features = ["protocol-asset"] }`) **y** flag en `tauri.conf.json` (`security.assetProtocol.enable = true`). Uno sin el otro falla silenciosamente.
2. **Scope de desarrollo: `["**"]`.** Para distribuir habría que apretarlo a `$HOME/Music/BrutalistPlayer/**`. El proyecto no se distribuye, pero el TODO queda anotado.
3. **`<audio crossOrigin="anonymous">` es obligatorio.** Sin eso, `createMediaElementSource()` marca el elemento como tainted y cualquier `AnalyserNode` (o el tap de Butterchurn) recibe ceros.

---

## 3. Contratos Tauri (invoke + events)

### 3.1 Convenciones

- Nombres de comando en **snake_case** (Tauri hace el bridge a `invoke()` en JS sin cambios).
- Tipos serializados con `serde` + `#[serde(rename_all = "camelCase")]` para que en TS lleguen como `camelCase`.
- Errores: enum `AppError` (`thiserror`) que serializa a string plano via `impl Serialize` custom. El frontend sólo muestra el mensaje, no discrimina variantes.
- Eventos Rust → React en **kebab-case**: `download-started`, `download-progress`, `download-postprocessing`, `download-completed`, `download-failed`.
- Tipos compartidos viven en [src-tauri/src/contracts.rs](../src-tauri/src/contracts.rs); su contraparte TS, escrita a mano, en [src/types.ts](../src/types.ts). Decisión sobre generación automática: ver [ADR-007](./DECISIONS.md#adr-007).

### 3.2 Comandos implementados

**Library** ([commands/library.rs](../src-tauri/src/commands/library.rs))
```rust
library_scan_directory(path: String) -> AppResult<ScanReport>
library_list_tracks() -> AppResult<Vec<Track>>
library_backfill_covers() -> AppResult<usize>   // re-extrae cover de tracks viejos sin imagen
```

**Downloader** ([commands/downloader.rs](../src-tauri/src/commands/downloader.rs))
```rust
download_track(url: String) -> AppResult<Download>
```
El comando bloquea hasta que yt-dlp termina, pero la UI no espera al return — los eventos `download-*` actualizan el store en tiempo real. ID de descarga: contador en memoria (`AtomicI64`) — no se persiste a la tabla `downloads` (chunk 1; persistencia en backlog).

**System** ([commands/system.rs](../src-tauri/src/commands/system.rs))
```rust
check_dependencies() -> DependencyStatus  // { ytDlp: bool, ffmpeg: bool }
```

### 3.3 Comandos en backlog (por feature pendiente)

```rust
// Letras (LRCLIB):
lyrics_fetch(track_id: i64) -> AppResult<Option<Lyrics>>

// Persistencia de último track:
playback_save_state(track_id: i64, position_ms: i64)
playback_load_state() -> Option<{ track_id, position_ms }>

// Borrado / settings: no implementados aún. Se agregan cuando los pida la UI.
```

---

## 4. Capa de datos

### 4.1 Driver SQLite

**SQLx 0.8** con feature set: `runtime-tokio`, `sqlite`, `migrate`, `macros`. Sin compile-time check (`query_as!`) — usamos `sqlx::query_as::<_, T>("...")` con `FromRow` derivado en `Track`. Razón: evitar requerir `DATABASE_URL` en el entorno de build/CI. Ver [ADR-001 — Accepted](./DECISIONS.md#adr-001).

### 4.2 Migraciones

`sqlx migrate` con archivos en `src-tauri/migrations/`. La app corre `sqlx::migrate!("./migrations").run(&pool)` al boot, **antes** de registrar comandos. Forward-only en desarrollo; sin `down` migrations hasta que sea necesario.

Schema actual: una sola migración (`20260421000001_initial_schema.sql`) que crea `tracks`, `playlists`, `playlist_tracks`, `lyrics`, `downloads`, `settings` + 3 índices sobre `tracks`. Las tablas `playlists`, `playlist_tracks`, `lyrics`, `downloads`, `settings` están creadas pero todavía sin uso real desde el código (Fase 2 / pendientes Fase 1).

### 4.3 Paths

- DB: `app_data_dir / player.db` (en macOS, `~/Library/Application Support/com.bryan.brutalistplayer/player.db`).
- Cover art extraído: `app_cache_dir / thumbnails / <track_id>.<ext>`.
- Library de descargas: `audio_dir / BrutalistPlayer / library / <uploader> / <title>.mp3` (por defecto `~/Music/BrutalistPlayer/...`).
- yt-dlp escribe primero a `library / _pending /` (flag `-P temp:...`) y mueve al final.

### 4.4 Idempotencia

`db::tracks::insert_from_metadata` usa `INSERT ... ON CONFLICT (file_path) DO NOTHING` y devuelve `Ok(Some(id))` si insertó, `Ok(None)` si ya existía. Re-escanear el mismo directorio o re-descargar la misma URL no duplica filas. yt-dlp corre con `--no-overwrites` para no rebajar archivos.

---

## 5. Módulos Rust (estado actual)

```
src-tauri/src/
├── lib.rs                  # bootstrap: tauri::Builder, init de pool, invoke_handler
├── main.rs                 # shim que llama lib::run
├── contracts.rs            # tipos compartidos con el frontend (Track, ScanReport, Download, etc)
├── errors.rs               # AppError enum + AppResult; serialize custom a string
├── db/
│   ├── mod.rs              # init() del pool + sqlx migrate
│   └── tracks.rs           # insert_from_metadata, list_all, set_cover_art, find_id_by_path
├── audio/
│   └── mod.rs              # is_audio_file, extract_metadata (lofty), extract_cover_art
├── downloader/
│   └── mod.rs              # run_yt_dlp + parsers de progreso y postprocess
├── lyrics/
│   └── mod.rs              # stub vacío — pendiente Fase 1
└── commands/               # thin wrappers
    ├── mod.rs
    ├── library.rs
    ├── downloader.rs
    └── system.rs
```

**Regla:** `commands/*` no contiene lógica. Reciben args, llaman al módulo de dominio, mapean errores a `AppError`. Los tests viven en los módulos.

Diferencias con la propuesta original del PLAN: no hay `db/playlists.rs` ni `db/downloads.rs` ni `db/settings.rs` (las tablas existen pero no las usa código todavía). `audio/metadata.rs` se colapsó a `audio/mod.rs`. `downloader/ytdlp.rs` + `downloader/progress.rs` se colapsaron a `downloader/mod.rs` (cuando crezca, separar). `lyrics/lrclib.rs` no existe aún.

---

## 6. Estado en React

### 6.1 Stores Zustand (estado actual)

```
src/stores/
├── playerStore.ts     currentTrackId, isPlaying, currentTime, duration,
│                       volume, muted, shuffle, playHistory (cap 64).
│                       Acciones: playTrack, togglePlay, seek, setVolume,
│                       toggleMute, toggleShuffle, next, prev. Persiste
│                       sólo { volume, muted, shuffle }.
├── libraryStore.ts    tracks, scanning, lastReport, error, searchQuery.
│                       Acciones: loadTracks, scanDirectory, backfillCovers,
│                       setSearchQuery. No persiste nada (la DB es la fuente
│                       de verdad; searchQuery es ephemeral).
├── uiStore.ts         view, presetIndex, visualizerSplit, autoCycle.
│                       Persiste { presetIndex, visualizerSplit, autoCycle }.
│                       version: 1 — bumpear cuando cambie un default que
│                       ya esté en localStorage del usuario.
└── downloadStore.ts   downloads (lista en memoria), deps, submitting, error.
                        Acciones de UI (startDownload, checkDependencies) +
                        acciones que llaman los handlers de evento
                        (upsertDownload, updateProgress, removeDownload).
```

Las acciones internas que sólo llama el adaptador de eventos (no la UI) van con prefijo `_` en `playerStore` (`_onTimeUpdate`, `_onPlay`, etc.) — convención simple para distinguir handlers de "API pública" de la store.

### 6.2 Singleton de audio fuera del JSX

El `<audio>` no vive como elemento React — se crea con `new Audio()` en [src/audio/element.ts](../src/audio/element.ts) y se mantiene en module scope. Igual el `AudioContext` y el `MediaElementAudioSourceNode` en [src/audio/context.ts](../src/audio/context.ts).

Razón: Butterchurn (un subtree distinto, montado/desmontado al cambiar de vista) necesita tapearse al mismo `MediaElementAudioSourceNode`. Si el elemento viviera en JSX y el contexto se creara en un provider, todo subtree que hiciera `connectAudio` necesitaría un ref pasado a través de React. El singleton elimina esa coordinación: cualquier módulo lo importa y obtiene la misma instancia. Ver [ADR-008](./DECISIONS.md#adr-008).

### 6.3 Sincronización con eventos de Tauri

[src/hooks/useDownloadEvents.ts](../src/hooks/useDownloadEvents.ts) se monta una sola vez en `App.tsx`. `Promise.all([...listen(...)])` setea los handlers; cleanup en unmount. Los handlers escriben directo al `downloadStore` (y, en `download-completed`, refrescan la library). Componentes de hoja **no** llaman `listen()`.

[src/hooks/useAudioPlayer.ts](../src/hooks/useAudioPlayer.ts) hace lo mismo para los eventos del `<audio>` singleton (`timeupdate`, `play`, `pause`, `ended`, `durationchange`).

---

## 7. Pipeline de descarga — detalle

```
1. Usuario pega URL → DownloadForm → downloadStore.startDownload(url)
2. invoke('download_track', { url })
3. Rust: emit 'download-started' { id, url, status: 'downloading' }
4. Rust: spawn yt-dlp con (ver downloader/mod.rs):
     --ignore-config --no-quiet
     --extract-audio --audio-format mp3 --audio-quality 0
     --embed-metadata --embed-thumbnail
     --no-playlist --no-overwrites
     --newline
     -o '%(uploader,channel|Unknown)s/%(title)s.%(ext)s'
     -P <library_dir>  -P temp:<library_dir>/_pending
     --print 'after_move:done %(filepath)s'
   env: PYTHONUNBUFFERED=1   ← yt-dlp es Python; sin esto el stdout queda
                                block-buffered y el progreso aparece en
                                tandas o nunca.
5. Rust lee STDOUT y STDERR en paralelo (dos lectores de líneas → un mpsc
   channel). Crítico: yt-dlp imprime '[download] X.X% of ...' a STDERR,
   no stdout. Sólo el 'done <path>' va a stdout.
6. Por cada línea recibida:
     - 'done <path>' → guardar como final_path
     - matchea '[download] N.N% ...' → emit 'download-progress'
     - empieza con '[ExtractAudio]' / '[Metadata]' / '[EmbedThumbnail]' /
       '[ThumbnailsConvertor]' / '[ffmpeg]' / '[Fixup*]' /
       '[VideoConvertor]' → emit 'download-postprocessing' (deduplicado:
       sólo el primero que match-ee)
7. Cuando ambos lectores llegan a EOF, esperamos child.wait().
   - exit 0 sin final_path → DownloadError::NoFilepath
   - exit != 0 → últimas 64 líneas guardadas, devolvemos la última
     no-vacía como mensaje (típicamente "ERROR: ...")
8. Post-éxito (commands/downloader.rs):
     a. lofty extract_metadata del archivo final
     b. db::tracks::insert_from_metadata (ON CONFLICT DO NOTHING)
        → Some(id) si insertó, None si ya estaba (re-download → Skipped)
     c. Si insertó: extract_cover_art (yt-dlp ya embebió el thumbnail) →
        cache/thumbnails/<id>.jpg → set_cover_art
     d. emit 'download-completed' { progress: 1.0, status, trackId }
9. Frontend: el handler de 'download-completed' refresca library_list_tracks
   para que el track aparezca en la tabla.
```

**TODOs abiertos:**
- Persistir descargas a la tabla `downloads` (history). Hoy son sólo memoria.
- Cancelación mid-download (`Child::kill()` ya lo hace `kill_on_drop(true)`, pero falta el botón en UI).
- Política de paralelismo: hoy es 1-a-la-vez (cada `download_track` es una llamada `await`-eada). N concurrentes requiere queue real.
- Reintentos automáticos en fallo de red.
- Fetch de letras a LRCLIB en paralelo al insert de la track (Fase 1 pendiente).

---

## 8. Visualizer — sizing y vida del canvas

Butterchurn 2.6.7 tiene dos footguns que pagamos:

1. **`createVisualizer(ctx, canvas, opts)` no aplica `opts.width`/`opts.height` al canvas.** El canvas se queda en 300×150 (default HTML) y todos los framebuffers internos nacen incompletos → zoom-in / esquina recortada. Hay que llamar `visualizer.setRendererSize(w, h)` explícito después.

2. **Algunos presets tocan `canvas.width`/`canvas.height` (atributos HTML, no CSS).** Eso afecta el intrinsic size y puede empujar el grid column. Confinamos forzando `canvas.style.width = "100%"` y poniendo el canvas como `absolute inset-0` dentro de un contenedor `relative overflow-hidden`. Un `ResizeObserver` sobre el **contenedor padre** (no el canvas) re-llama `setRendererSize` cuando el split cambia.

Implementación: [src/components/visualizer/VisualizerCanvas.tsx](../src/components/visualizer/VisualizerCanvas.tsx).

Auto-cycle de presets: [src/hooks/useAutoCyclePresets.ts](../src/hooks/useAutoCyclePresets.ts). Sólo corre mientras `VisualizerView` está montado — si navegás a LIBRARY, el timer se cancela. Re-armado en cada cambio de `presetIndex` (manual o automático), para que un click no dispare un auto-cambio 1s después.

---

## 9. Seguridad y permisos Tauri

`src-tauri/tauri.conf.json` actual:

- **`assetProtocol.scope: ["**"]`** — abierto a todo. Aceptable porque el proyecto no se distribuye. Para distribución habría que cerrarlo a `$HOME/Music/BrutalistPlayer/**` + el directorio que el usuario seleccione en el dialog.
- **Plugins habilitados:** `tauri-plugin-opener`, `tauri-plugin-dialog`. No hay HTTP plugin (las requests a LRCLIB no están implementadas; cuando las haya, allowlist `https://lrclib.net/*`). No hay shell plugin (yt-dlp y ffmpeg los spawneamos directo con `tokio::process::Command` desde Rust, no desde JS).
- **CSP:** `null` (sin restricciones). Ajustar antes de cualquier distribución.

---

## 10. Áreas sin resolver (tracking)

| # | Tema | Bloquea | Tracking |
|---|------|---------|----------|
| 1 | Letras sincronizadas (LRCLIB + UI panel) | Cierre Fase 1 | `lyrics/` stub; PLAN §5.4 |
| 2 | Crossfade entre tracks | Cierre Fase 1 | PLAN §5.2 |
| 3 | Persistencia último track / posición | Cierre Fase 1 | PLAN §6.1 |
| 4 | Persistir downloads a tabla `downloads` | Polish | sección 7 |
| 5 | Cancelación / retry de descargas en UI | Polish | sección 7 |
| 6 | Playlists de yt-dlp (multi-URL) | Backlog post Fase 1 | memoria del proyecto |
| 7 | Tightening del `assetProtocol.scope` | Pre-distribución | sección 9 |
| 8 | Generación automática de tipos Rust↔TS | Polish | [ADR-007](./DECISIONS.md#adr-007) |
| 9 | MPRIS en Linux / media keys | Fase 2 | PLAN §5.2 |

Las decisiones tomadas durante la implementación (ADR-001 sqlx, ADR-002 detect-not-bundle, ADR-008 audio singleton, etc.) están en [DECISIONS.md](./DECISIONS.md).
