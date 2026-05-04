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
Archivo en disco  ──►  Tauri expone vía asset protocol (convertFileSrc)
                                │
                                ▼
        ┌────────────────────────────────────────────┐
        │  audioA (canal A)        audioB (canal B)  │   singletons en
        │  - new Audio()           - new Audio()     │   module scope —
        │  - crossOrigin="anonymous"                 │   ver §6.2
        └────────┬──────────────────┬────────────────┘
                 ▼                  ▼
              sourceA            sourceB        (MediaElementAudioSourceNode)
                 │                  │
                 ▼                  ▼
            channelGainA       channelGainB     ← crossfade ramps (1=activo,
                 │                  │             0=inactivo)
                 └────────┬─────────┘
                          ▼
                  preMasterGain  ──► Butterchurn.connectAudio()  (tap del visualizer:
                          │                                        ve la mezcla de
                          ▼                                        ambos canales,
                    masterGain                                     pre-volume/mute)
                          │ ← volume + mute (slider, M key)
                          ▼
                   playPauseGain
                          │ ← fade in/out al play/pause (200ms in, 150ms out)
                          ▼
                  AudioContext.destination
```

**Implementación:** [src/audio/element.ts](../src/audio/element.ts) y [src/audio/context.ts](../src/audio/context.ts).

Tres niveles de gain con responsabilidades distintas:
- **`channelGainA/B`**: control de crossfade entre canales. 1 = audible, 0 = silencio.
- **`masterGain`**: control de volumen del usuario + mute. Único stage donde el slider de volumen escribe.
- **`playPauseGain`**: fade in/out de play/pause. Independiente del volumen — el usuario puede mover el slider durante un fade sin interferencia.

`preMasterGain` es un junction node (gain fijo en 1) que existe sólo para que el visualizer tape la mezcla de ambos canales pre-volumen. Sin esto, Butterchurn perdería todo el audio del canal B durante un crossfade.

### 2.1 Por qué el volumen va por GainNode, no por `audio.volume`

Una vez que llamás `ctx.createMediaElementSource(audio)`, Chromium **bypassea** `audio.volume` y `audio.muted`. La señal sale del elemento al grafo Web Audio y no respeta los controles HTML. Por eso `setVolume` y `toggleMute` escriben a `masterGain.gain.value`. (Gotcha #2 en CLAUDE.md.)

### 2.2 Crossfade y play/pause fade — detalle

**Crossfade** (ADR-012): cuando `_onTimeUpdate` detecta que faltan `<= crossfadeMs/1000` para terminar el track, dispara `startCrossfade`:
1. Precarga próximo track en el canal inactivo (`audio.src = ...; audio.play()`).
2. Schedule de `linearRampToValueAtTime` sobre los dos channelGains: viejo 1→0, nuevo 0→1, en `crossfadeMs` segundos del reloj AudioContext.
3. Swap del `activeId` (el "canal activo" pasa a ser el nuevo). `useAudioPlayer` filtra eventos por `audio === getAudioElement()` para que el viejo no pise el state durante el fade.
4. setTimeout en wall-clock para `finishCrossfade`: pausa el viejo + clear de su src.

**Play/pause fade** (ADR-013): `togglePlay` branchea sobre `isPlaying` del store (eager update) en vez de `audio.paused` para soportar doble-click rápido durante un fade.
- Play: `audio.play()` + `fadeInPlayPause()` (`cancelAndHoldAtTime + linearRampToValueAtTime` 0→1 over 200ms).
- Pause: `fadeOutPlayPause(onFadeOut)` (ramp current→0 over 150ms), después `onFadeOut` llama `audio.pause()`.
- Crítico: `cancelAndHoldAtTime(t)` (no `cancelScheduledValues + setValueAtTime(g.value, t)`) porque `g.value` lee el INTRÍNSECO del AudioParam, no el computado del ramp en curso (Gotcha #9).

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
library_list_tracks() -> AppResult<Vec<Track>>     // Track incluye lyrics_status via LEFT JOIN
library_backfill_covers() -> AppResult<usize>      // re-extrae cover de tracks viejos sin imagen
library_backfill_metadata() -> AppResult<usize>    // aplica cleanup heurístico a metadata yt-dlp
```

**Downloader** ([commands/downloader.rs](../src-tauri/src/commands/downloader.rs))
```rust
download_track(url: String) -> AppResult<Download>
```
El comando bloquea hasta que yt-dlp termina, pero la UI no espera al return — los eventos `download-*` actualizan el store en tiempo real. ID de descarga: contador en memoria (`AtomicI64`) — no se persiste a la tabla `downloads` (chunk 1; persistencia en backlog).

**System** ([commands/system.rs](../src-tauri/src/commands/system.rs))
```rust
check_dependencies() -> DependencyStatus
// { ytDlp: bool, ffmpeg: bool, fpcalc: bool, whisperx: bool }
// Usa resolve_binary() con fallback a ~/.local/bin/, /usr/local/bin/,
// /opt/homebrew/bin/ — el proceso Tauri en macOS no siempre hereda PATH
// completo del shell.
```

**Lyrics** ([commands/lyrics.rs](../src-tauri/src/commands/lyrics.rs))
```rust
lyrics_fetch(track_id) -> AppResult<Option<Lyrics>>          // cache-first; cascade si miss
lyrics_set_offset(track_id, offset_ms) -> AppResult<()>      // user offset
lyrics_set_speed_ratio(track_id, speed_ratio) -> AppResult<()> // drift correction
lyrics_reset_sync(track_id) -> AppResult<()>                 // offset=0 + speed=1.0
```

**Identification** ([commands/identification.rs](../src-tauri/src/commands/identification.rs))
```rust
identification_identify_track(track_id) -> AppResult<IdentificationResult>
identification_get_api_key() -> AppResult<Option<String>>
identification_set_api_key(key: String) -> AppResult<()>
identification_identify_all() -> AppResult<()>     // bulk; emit progress events
identification_cancel_all() -> AppResult<()>       // setea cancel flag
```
Eventos: `identification-progress { done, total, current_track_id, last_status }`,
`identification-completed { total, identified, low_confidence, no_match,
fingerprint_failed, api_error, cancelled }`.

**Karaoke** ([commands/karaoke.rs](../src-tauri/src/commands/karaoke.rs))
```rust
karaoke_auto_align(track_id) -> AppResult<()>
// Lee lyrics.original_synced_lyrics; spawnea karaoke_align.py via python
// del venv whisperx; recibe word timings; serializa A2 LRC con trailing
// markers; guarda con save_aligned (que también resetea offset/speed).
```

### 3.3 Comandos en backlog

Persistencia del último track + posición se hace **client-side** vía localStorage en `usePlaybackPersist` — no requirió comando backend. Borrado de tracks, edit lyrics, y comandos relacionados a Fase 2.c/3 features aún no implementados.

---

## 4. Capa de datos

### 4.1 Driver SQLite

**SQLx 0.8** con feature set: `runtime-tokio`, `sqlite`, `migrate`, `macros`. Sin compile-time check (`query_as!`) — usamos `sqlx::query_as::<_, T>("...")` con `FromRow` derivado en `Track`. Razón: evitar requerir `DATABASE_URL` en el entorno de build/CI. Ver [ADR-001 — Accepted](./DECISIONS.md#adr-001).

### 4.2 Migraciones

`sqlx migrate` con archivos en `src-tauri/migrations/`. La app corre `sqlx::migrate!("./migrations").run(&pool)` al boot, **antes** de registrar comandos. Forward-only en desarrollo; sin `down` migrations hasta que sea necesario.

Schema actual: dos migraciones.
- `20260421000001_initial_schema.sql` — `tracks`, `playlists`, `playlist_tracks`, `lyrics`, `downloads`, `settings` + 3 índices sobre `tracks`.
- `20260502000001_lyrics_phase1.sql` — aditiva sobre `lyrics`: agrega `offset_ms`, `status`, `source_id`, `confidence`, `last_used_at` + índice `idx_lyrics_status`. La validación de `status ∈ {'found','not_found','manual_pending'}` se hace en código Rust (SQLite no soporta CHECK añadido por ALTER).

Tablas en uso activo: `tracks`, `lyrics`. Tablas creadas pero sin código que las use: `playlists`, `playlist_tracks`, `downloads`, `settings` (Fase 2+).

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
├── lib.rs                  # bootstrap: tauri::Builder, pool init, reqwest::Client init,
│                           # BulkIdentifyState manage(), invoke_handler
├── main.rs                 # shim que llama lib::run
├── contracts.rs            # tipos compartidos con el frontend (Track con lyrics_status +
│                           # identification_status + acoustid_score, Lyrics con
│                           # speed_ratio + aligned_at + original_synced_lyrics,
│                           # DependencyStatus con whisperx, ScanReport, Download)
├── errors.rs               # AppError enum + AppResult; serialize custom a string;
│                           # variantes: Database, Io, Http, NotFound, InvalidInput,
│                           # FpcalcFailed/Parse, AcoustIdApi, AcoustIdNoApiKey,
│                           # WhisperxMissing/Failed/Parse, Other
├── db/
│   ├── mod.rs              # init() del pool + sqlx migrate
│   ├── tracks.rs           # insert_from_metadata, list_all (con LEFT JOIN a lyrics +
│   │                       # cols identification), set_cover_art,
│   │                       # list_for_metadata_backfill, update_title_and_artist,
│   │                       # save_fingerprint, save_identification (con backup
│   │                       # original_title/artist), update_identification_status,
│   │                       # list_identifiable
│   ├── lyrics.rs           # get_for_track, upsert (con COALESCE para preservar
│   │                       # original_synced_lyrics + speed_ratio), mark_not_found,
│   │                       # set_offset, set_speed_ratio, reset_sync,
│   │                       # save_aligned, delete_for_track
│   └── settings.rs         # get/set key-value (acoustid_api_key)
├── audio/
│   ├── mod.rs              # is_audio_file, extract_metadata (lofty), extract_cover_art
│   └── cleanup.rs          # cleanup_metadata heurístico (post-yt-dlp); 23 unit tests
├── downloader/
│   └── mod.rs              # run_yt_dlp + parsers de progreso y postprocess
├── lyrics/
│   ├── mod.rs              # fetch_lyrics: cascade Embedded → LRCLIB → mark_not_found
│   ├── embedded.rs         # try_embedded: lee USLT vía lofty
│   └── lrclib.rs           # try_lrclib: /api/get con field fallback + /api/search fallback
├── identification/         # AcoustID + Chromaprint (forced fingerprinting → MBID)
│   ├── mod.rs              # identify_track cascade, IdentificationResult, threshold 0.80
│   ├── fpcalc.rs           # spawn fpcalc -json + parse output
│   └── acoustid.rs         # HTTP a AcoustID API + parse response
├── karaoke/                # Forced alignment de lyrics via WhisperX
│   ├── mod.rs              # align_track cascade, parse_lrc_lines, build_segments
│   │                       # (tight LRC bounds), build_a2_lrc (con trailing markers);
│   │                       # 11 unit tests
│   └── whisperx.rs         # spawn Python wrapper (resources/scripts/karaoke_align.py),
│                           # find_python_for_whisperx via resolve_binary fallback,
│                           # parse JSON output
└── commands/               # thin wrappers
    ├── mod.rs
    ├── library.rs          # scan_directory, list_tracks, backfill_covers,
    │                       # backfill_metadata
    ├── downloader.rs       # download_track
    ├── lyrics.rs           # lyrics_fetch (cache-first), lyrics_set_offset,
    │                       # lyrics_set_speed_ratio, lyrics_reset_sync
    ├── identification.rs   # identification_identify_track, get_api_key, set_api_key,
    │                       # identification_identify_all (bulk + cancelable),
    │                       # identification_cancel_all
    ├── karaoke.rs          # karaoke_auto_align (resuelve script vía Tauri resource API)
    └── system.rs           # check_dependencies (yt-dlp, ffmpeg, fpcalc, whisperx);
                            # resolve_binary helper con fallback PATH

src-tauri/resources/scripts/
└── karaoke_align.py        # Wrapper Python (~80 líneas) que usa whisperx.align()
                            # Python API en modo align-only. Shippeado vía Tauri
                            # bundle.resources. Spawn con el python del venv pipx.
```

**Regla:** `commands/*` no contiene lógica. Reciben args, llaman al módulo de dominio, mapean errores a `AppError`. Los tests viven en los módulos.

**Resources:** `karaoke_align.py` se shippea como resource via `tauri.conf.json bundle.resources`. Resolución en runtime via `app.path().resolve("scripts/karaoke_align.py", BaseDirectory::Resource)`.

Diferencias con la propuesta original del PLAN: no hay `db/playlists.rs` ni `db/downloads.rs` (las tablas existen pero no las usa código todavía). `downloader/ytdlp.rs` + `downloader/progress.rs` se colapsaron a `downloader/mod.rs` (cuando crezca, separar). `db/settings.rs` se agregó para AcoustID API key.

---

## 6. Estado en React

### 6.1 Stores Zustand (estado actual)

```
src/stores/
├── playerStore.ts     currentTrackId, isPlaying, currentTime, duration,
│                       volume, muted, shuffle, crossfadeMs, _isCrossfading,
│                       playHistory (cap 64). Acciones: playTrack,
│                       loadTrackForResume, togglePlay (con eager update +
│                       fade), seek, setVolume, toggleMute, toggleShuffle,
│                       cycleCrossfade, next, prev. Persiste sólo
│                       { volume, muted, shuffle, crossfadeMs }.
├── libraryStore.ts    tracks, scanning, lastReport, error, searchQuery,
│                       cleaning, lastCleanedCount. Acciones: loadTracks,
│                       scanDirectory, backfillCovers, backfillMetadata,
│                       setSearchQuery. No persiste nada (DB es la fuente).
├── uiStore.ts         view, presetIndex, visualizerSplit, autoCycle,
│                       playerPaneMode ('visualizer' | 'lyrics'). Persiste
│                       { presetIndex, visualizerSplit, autoCycle,
│                       playerPaneMode }. version: 1 — bumpear al cambiar
│                       un default ya persistido.
├── lyricsStore.ts     current (Lyrics | null), forTrackId, loading,
│                       notFound, error. Acciones: fetch (con race-guard),
│                       setOffset (optimistic update), clear. No persiste —
│                       la DB es la cache.
└── downloadStore.ts   downloads (lista en memoria), deps, submitting, error.
                        Acciones de UI (startDownload, checkDependencies) +
                        acciones que llaman los handlers de evento.
```

Las acciones internas que sólo llama el adaptador de eventos (no la UI) van con prefijo `_` en `playerStore` (`_onTimeUpdate`, `_onPlay`, `_isCrossfading`, etc.) — convención simple para distinguir handlers de "API pública" de la store.

### 6.2 Singleton de audio fuera del JSX

El `<audio>` no vive como elemento React — se crea con `new Audio()` en [src/audio/element.ts](../src/audio/element.ts) y se mantiene en module scope. Igual el `AudioContext` y el `MediaElementAudioSourceNode` en [src/audio/context.ts](../src/audio/context.ts).

Razón: Butterchurn (un subtree distinto, montado/desmontado al cambiar de vista) necesita tapearse al mismo `MediaElementAudioSourceNode`. Si el elemento viviera en JSX y el contexto se creara en un provider, todo subtree que hiciera `connectAudio` necesitaría un ref pasado a través de React. El singleton elimina esa coordinación: cualquier módulo lo importa y obtiene la misma instancia. Ver [ADR-008](./DECISIONS.md#adr-008).

### 6.3 Sincronización con eventos de Tauri

[src/hooks/useDownloadEvents.ts](../src/hooks/useDownloadEvents.ts) se monta una sola vez en `App.tsx`. `Promise.all([...listen(...)])` setea los handlers; cleanup en unmount. Los handlers escriben directo al `downloadStore` (y, en `download-completed`, refrescan la library). Componentes de hoja **no** llaman `listen()`.

[src/hooks/useAudioPlayer.ts](../src/hooks/useAudioPlayer.ts) atacha listeners en **ambos** audios (canal A y B) para los eventos del `<audio>` singleton (`timeupdate`, `play`, `pause`, `ended`, `durationchange`). Cada handler filtra por `audio === getAudioElement()` para que sólo el canal activo actualice el store — durante un crossfade ambos canales reproducen pero sólo el "nuevo" (el que el usuario está escuchando en su modelo mental) maneja el state.

### 6.4 Hooks globales montados en App

```
useAudioPlayer       eventos del <audio> → playerStore
useKeyboardShortcuts Space, ←/→, ↑/↓, M, N, P, S, V, F
useDownloadEvents    eventos download-* → downloadStore
usePlaybackPersist   ¿qué track + posición? localStorage entre sesiones
useMediaSession      MediaSession API (media keys, AirPods, Now Playing)
useLyricsSync        auto-fetch de letras on currentTrackId change
```

---

## 7. Lyrics — sub-sistema

Ver [LYRICS.md](./LYRICS.md) para el plan completo por fases.

**Fase 1 (implementada)**: Embedded (USLT vía lofty) + LRCLIB. Sin trait abstraction — dos `async fn` libres en `src-tauri/src/lyrics/`. Ver [ADR-015](./DECISIONS.md#adr-015).

**Cascade** (`fetch_lyrics`):
1. **Embedded**: lee `ItemKey::Lyrics` del archivo (USLT en ID3v2). Sólo plain en Fase 1; SYLT (synced embebido) queda Fase 2.
2. **LRCLIB**: cascade interna — `/api/get` con todos los campos → `/api/get` sin album → `/api/search` (fuzzy keyword search). Cada nivel valida `duration` con tolerancia ±10s para evitar matches a versiones equivocadas (live/edit/remix).
3. Si nada matchea: `mark_not_found` (cache `status='not_found'` para no re-pegarle automáticamente).

**Cleanup heurístico** ([audio/cleanup.rs](../src-tauri/src/audio/cleanup.rs)) corre antes de insertar metadata de yt-dlp. Strip de sufijos de YouTube (`- Topic`, `OfficialVEVO`, `(Official Video)`, etc) + extracción de `Artist - Title` patterns. **Conservador por elección** — falsos negativos preferibles a falsos positivos. Ver [ADR-016](./DECISIONS.md#adr-016).

**Auto-fetch on track change** ([useLyricsSync](../src/hooks/useLyricsSync.ts)): cada vez que cambia `currentTrackId`, dispara `lyrics_fetch` en background y refresca la library. La cache previene requests duplicados. Pobla el indicador `L` en la library con el uso natural. Ver [ADR-017](./DECISIONS.md#adr-017).

**Indicador `L` en LibraryTable**:
- `[L]` accent → synced
- `·` muted → plain only
- `♪` muted → instrumental confirmado por LRCLIB
- `—` muted → not_found (buscamos, no había)
- vacío → no fetcheado todavía

`lyrics_status` se computa en SQL via CASE en `db::tracks::list_all` con LEFT JOIN a `lyrics` — el frontend recibe el estado por track sin necesidad de query separada.

**Sincronización en runtime** ([useSyncedLyrics](../src/hooks/useSyncedLyrics.ts)): `requestAnimationFrame` con cursor incremental. rAF en vez de `timeupdate` (que dispara cada ~250ms y se siente lento) — para letras synced el delay perceptible importa. Cursor amortizado O(1) durante reproducción lineal; reset a -1 en `seeked`.

**Parser LRC**: [src/lib/lrcParser.ts](../src/lib/lrcParser.ts) — TS, no Rust. El backend guarda el blob crudo en `lyrics.synced_lyrics` y el frontend lo parsea al renderizar. Maneja múltiples timestamps por línea (`[00:25.43][01:32.10]Chorus`), tags de metadata (`[ti:]`, `[ar:]`, `[al:]`, `[offset:]`), BOM, CRLF. Líneas malformadas se descartan silenciosamente (best-effort).

---

## 8. Pipeline de descarga — detalle

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

## 9. Visualizer — sizing, vida del canvas, persistent mount

Butterchurn 2.6.7 tiene dos footguns que pagamos:

1. **`createVisualizer(ctx, canvas, opts)` no aplica `opts.width`/`opts.height` al canvas.** El canvas se queda en 300×150 (default HTML) y todos los framebuffers internos nacen incompletos → zoom-in / esquina recortada. Hay que llamar `visualizer.setRendererSize(w, h)` explícito después.

2. **Algunos presets tocan `canvas.width`/`canvas.height` (atributos HTML, no CSS).** Eso afecta el intrinsic size y puede empujar el grid column. Confinamos forzando `canvas.style.width = "100%"` y poniendo el canvas como `absolute inset-0` dentro de un contenedor `relative overflow-hidden`. Un `ResizeObserver` sobre el **contenedor padre** (no el canvas) re-llama `setRendererSize` cuando el split cambia.

Implementación: [src/components/visualizer/VisualizerCanvas.tsx](../src/components/visualizer/VisualizerCanvas.tsx).

### 9.1 Persistent mount + visibility-gated rAF

`butterchurn.createVisualizer` + `loadPreset` compilan shaders WebGL sincrono en el main thread (~100-300ms de freeze). Re-montar el componente en cada cambio de tab era inaceptable como UX. Ver [ADR-014](./DECISIONS.md#adr-014).

**Solución implementada:**
1. **Mount lazy + persistente**: `App.tsx` mantiene flag `visualizerVisited`. Primera entrada a la tab visualizer lo flippea a true, ahí se monta `VisualizerView`. Una vez montado queda montado hasta cerrar la app.
2. **Hidden via CSS**: cuando `view !== "visualizer"`, el wrapper de `VisualizerView` recibe `absolute inset-0 invisible pointer-events-none` — preserva dimensions (no fluctúa el ResizeObserver) pero los clicks pasan a la vista activa abajo.
3. **rAF gated por `visible`**: el render loop dentro de `VisualizerCanvas` se separa del init effect y depende de `visible = view === "visualizer" && paneMode === "visualizer"`. Cuando false, cancela rAF — el canvas queda con el último frame estático.
4. **Auto-cycle gated también**: sino cambiaría `presetIndex` en background y dispararía `loadPreset` (recompila shaders) → freeze invisible. Ver [src/hooks/useAutoCyclePresets.ts](../src/hooks/useAutoCyclePresets.ts).
5. **ResizeObserver skipea size 0**: caso `display: none` reportaría 0×0 al ocultar el pane lyrics; setRendererSize(0,0) shrinkearía framebuffers y al volver tocaría re-allocar.

**Costo**: ~50MB RAM (GPU buffers + shaders compilados + JS state) que viven mientras la app corre. En Apple Silicon (memoria unificada) ~0.3% del total, despreciable.

### 9.2 Toggle visualizer ↔ lyrics

VisualizerView tiene un `PaneToggle` arriba del pane izquierdo (`VISUALIZER` / `LYRICS`). El estado vive en `uiStore.playerPaneMode` (persistido). En modo lyrics, el wrapper del canvas + PresetSelector recibe `hidden` (display:none). Canvas conserva su WebGL context — el toggle es instantáneo.

La library queda en el pane derecho del split, visible en ambos modos.

---

## 10. Seguridad y permisos Tauri

`src-tauri/tauri.conf.json` actual:

- **`assetProtocol.scope: ["**"]`** — abierto a todo. Aceptable porque el proyecto no se distribuye. Para distribución habría que cerrarlo a `$HOME/Music/BrutalistPlayer/**` + el directorio que el usuario seleccione en el dialog.
- **Plugins habilitados:** `tauri-plugin-opener`, `tauri-plugin-dialog`. HTTP a LRCLIB se hace desde Rust con `reqwest` (rustls-tls, sin OpenSSL) — no via Tauri http plugin, así que no hay allowlist a configurar. Shell: yt-dlp y ffmpeg los spawneamos directo con `tokio::process::Command` desde Rust, no desde JS.
- **CSP:** `null` (sin restricciones). Ajustar antes de cualquier distribución.

---

## 11. Áreas sin resolver (tracking)

Fase 1 cerrada. Lo que queda es Fase 2/3 backlog:

| # | Tema | Fase | Tracking |
|---|------|------|----------|
| 1 | AcoustID + Chromaprint (identificación canónica) | 3 (próximo) | LYRICS.md Fase 3, propio sub-doc |
| 2 | Persistir downloads a tabla `downloads` | Polish | sección 8, [ADR-011](./DECISIONS.md#adr-011) |
| 3 | Cancelación / retry de descargas en UI | Polish | sección 8 |
| 4 | Playlists de yt-dlp (multi-URL) | Polish | memoria del proyecto |
| 5 | Lyrics Fase 2 (Genius, manual paste, drift correction, refetch) | 2 | LYRICS.md |
| 6 | Playlists (CRUD, reordenar, M3U export) | 2 | PLAN §6.1 Fase 2 |
| 7 | Equalizer 10-band BiquadFilter | 2 | PLAN §6.1 Fase 2 |
| 8 | Test MediaSession en Windows | Cross-platform | useMediaSession.ts TODO |
| 9 | Webfonts (Space Grotesk + JetBrains Mono) | Polish | [ADR-003](./DECISIONS.md#adr-003) |
| 10 | Windows titlebar custom | Polish | [ADR-005](./DECISIONS.md#adr-005) |
| 11 | Tightening `assetProtocol.scope` | Pre-distribución | §10 |
| 12 | MPRIS en Linux | 2 | PLAN §6.1 Fase 2 |
| 13 | Generación automática de tipos Rust↔TS | Polish | [ADR-007](./DECISIONS.md#adr-007) |

Las decisiones tomadas durante la implementación (ADR-001 sqlx, ADR-002 detect-not-bundle, ADR-008 audio singleton, etc.) están en [DECISIONS.md](./DECISIONS.md).
