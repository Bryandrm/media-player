# CLAUDE.md

> Contexto operativo para Claude Code trabajando en este repo.
> Mantener corto. Las decisiones y los detalles técnicos viven en [docs/](./docs/).

---

## Qué es este proyecto

Reproductor de música local desktop con visualizador estilo MilkDrop (Butterchurn) y downloader integrado vía yt-dlp. Proyecto **personal + portfolio piece**, no producto comercial. Construido en Tauri 2 + Rust + React.

Documentos fuente de verdad:
- [docs/PLAN-reproductor-brutalist.md](./docs/PLAN-reproductor-brutalist.md) — visión, scope, roadmap.
- [docs/BACKLOG.md](./docs/BACKLOG.md) — tareas de desarrollo formalizadas (vista única + priorización). Leer al planear qué sigue.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — arquitectura técnica, contratos Tauri, pipeline de audio.
- [docs/DECISIONS.md](./docs/DECISIONS.md) — ADRs. Leer antes de proponer cambios técnicos importantes.
- [docs/LYRICS.md](./docs/LYRICS.md) — sub-sistema de letras (LRCLIB + USLT, drift correction, etc.).
- [docs/IDENTIFICATION.md](./docs/IDENTIFICATION.md) — sub-sistema de identificación (AcoustID + Chromaprint).
- [docs/KARAOKE.md](./docs/KARAOKE.md) — sub-sistema de karaoke (forced alignment + per-word timing + future fullscreen + vocal removal). Fase A ✓ (per-word real); Fase B–E pendientes.
- [docs/SECURITY.md](./docs/SECURITY.md) — auditoría de seguridad, superficie de ataque, plan de hardening.

---

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView).
- **Frontend:** React 19 + TypeScript + Vite + Tailwind v4.
- **Estado React:** Zustand 5 con `persist` middleware. Stores por dominio:
  `playerStore`, `libraryStore`, `uiStore`, `downloadStore`.
- **Backend:** Rust. SQLite vía `sqlx` 0.8 (runtime tokio).
- **Audio:** **dos** singletons `<audio>` (channel A y B, fuera de JSX, en
  `audio/element.ts`) para soportar crossfade. Pipeline:
  `audioA/B → sourceA/B → channelGainA/B → preMasterGain → eqBands[0..9] → masterGain → playPauseGain → destination`.
  Butterchurn tapea `preMasterGain` (mezcla de los dos canales). **El volumen
  real se controla con `masterGain`**, no con `audio.volume` (ver Gotcha #2).
  Fade in/out al play/pause via `playPauseGain` con `cancelAndHoldAtTime`.
- **Visualizer:** `butterchurn` 2.6 + `butterchurn-presets` 2.4 (~100 presets base).
  Mount **persistente** post-primer-visit (ver Gotcha #8).
- **Lyrics:** `lofty` (USLT embebido) + `LRCLIB` API. Parser LRC en frontend
  con soporte A2 (per-word timestamps) + trailing markers. Auto-fetch on
  track change para poblar el indicador `L` en la library. Drift correction
  via `speedRatio` + `offset_ms` + ALIGN mode.
- **Identification:** `fpcalc` (Chromaprint, **bundleado** como Tauri resource
  en `resources/bin/`) + AcoustID API. Pisa metadata sucia con canónica de
  MusicBrainz. API key del usuario en `settings`.
- **Karaoke:** `whisperx` (Python + PyTorch + wav2vec2) en align-only mode
  via wrapper Python shippeado como Tauri resource. Genera A2 LRC con
  per-word timestamps **+ score de confianza** por palabra (formato custom
  `<mm:ss.xx|score>word`). Forced alignment con bounds tight del LRC.
  **Hybrid fill:** palabras con score bajo (<0.3) se interpolan entre anchors
  confiables en vez de usar su timestamp dudoso (fill suave, no salta).
  **Mismatch detection (Nivel 2):** segundo script Python
  (`mismatch_detect.py`) transcribe el audio con WhisperX, convierte LRC
  y transcripción a fonemas IPA vía `phonemizer` (espeak), y compara con
  Levenshtein normalizado por línea. Botón CHECK QUALITY en el panel de
  lyrics (detecta líneas malas; la corrección es manual vía EDIT — no
  auto-reemplazamos letra con la transcripción de whisper).
- **Bundled como Tauri resources:** `fpcalc` 1.5.1 (Chromaprint, identification)
  en `resources/bin/`. Resuelto vía `resolve_binary_or_bundled` (bundled first,
  fallback a system PATH).
- **Externos como deps del sistema** (no bundled): `yt-dlp` + `ffmpeg`
  (downloader), `whisperx` via pipx (karaoke),
  `phonemizer` (`pipx inject whisperx phonemizer`) + `espeak-ng` (mismatch
  detection). Cada uno detect-and-banner si falta. `lofty-rs` para tags +
  cover art + USLT. `reqwest` con `rustls-tls` (sin OpenSSL).

---

## Principios que guían las decisiones

1. **Brutalist de verdad, no template.** Sin border-radius, sin gradients, sin shadows blur, sin iconos decorativos. Tipografía + bordes + contraste duro. Si propones una UI "más suave", estás contradiciendo la identidad del proyecto — preguntá primero.
2. **El visualizador es el protagonista.** La UI se aparta cuando suena música.
3. **Scope conservador.** Lo que no esté en [PLAN §1.3](./docs/PLAN-reproductor-brutalist.md) está fuera, incluso si parece "una mejora pequeña". Preguntar antes de añadir.
4. **El autor está aprendiendo Rust.** Preferir patrones simples (funciones libres, queries explícitas) sobre abstracciones prematuras (traits complejos, macros custom). Cuando expliques código Rust, tratá al lector como alguien que sabe programar pero no conoce idioms específicos.
5. **Separación Rust/React dura:** audio + WebGL en React; filesystem + procesos + red en Rust. Nunca al revés.

---

## Estructura del repo

```
src/
├── App.tsx                 layout shell + monta hooks globales
├── main.tsx
├── audio/
│   ├── element.ts          singletons <audio> A/B + activeId
│   └── context.ts          AudioContext + channelGains + preMasterGain
│                           + masterGain + playPauseGain + fade helpers
├── components/
│   ├── ui/                 Button, Tabs (con tab EQ), MarqueeText (genéricos)
│   ├── library/            LibraryTable (con indicador L / K-aligned + columna +/−),
│   │                       LibrarySearchBar, LibraryToolbar (SCAN + CLEAN +
│   │                       MB BACKFILL), PlaylistSidebar (tabs PLAYLISTS /
│   │                       DETAILS), AddToPlaylistPopover, MultiSelectPicker,
│   │                       SmartPlaylistModal, TrackDetailsPanel
│   ├── player/             PlayerBar, Controls (con XFADE button), SeekBar,
│   │                       VolumeSlider, CoverArt
│   ├── visualizer/         VisualizerView (con toggle vis/lyrics + persistent
│   │                       mount), VisualizerCanvas, PresetSelector
│   ├── lyrics/             LyricsView (panel sincronizado + flag inline de
│   │                       líneas malas + edición inline), LyricsEditModal,
│   │                       WaveformEditor (T6: editor de timing con onda),
│   │                       KaraokeView (Fase B: overlay fullscreen, tecla K)
│   ├── eq/                 EqualizerView (10 sliders verticales + bypass)
│   └── downloads/          DownloadsView, DownloadForm, DownloadQueue, …
├── hooks/                  useAudioPlayer, useKeyboardShortcuts, usePressFlash,
│                           usePlaybackPersist, useMediaSession, useLyricsSync,
│                           useSyncedLyrics (rAF active-line tracking),
│                           useAutoCyclePresets, useDownloadEvents,
│                           useIdentificationEvents
├── stores/                 playerStore (con eqGains + eqEnabled), libraryStore,
│                           uiStore (view incluye 'eq'), downloadStore,
│                           lyricsStore, identificationStore, playlistStore
├── lib/                    format.ts, search.ts, lrcParser.ts (puros)
├── styles/tokens.css       design tokens + range/marquee/progress CSS +
│                           range-brutal-vert (EQ vertical slider)
└── types.ts                Track, Download, Lyrics, IdentificationResult,
                            Playlist, …

src-tauri/src/
├── lib.rs                  Tauri builder + invoke_handler + reqwest::Client +
│                           BulkIdentifyState manage()
├── commands/               thin wrappers — library, downloader, system,
│                           lyrics, identification, karaoke, playlists
├── db/                     sqlx queries por tabla (tracks, lyrics, settings,
│                           playlists)
├── audio/                  lofty: extract_metadata + extract_cover_art
│   └── cleanup.rs          heurísticas para limpiar metadata yt-dlp
│                           (Topic/VEVO/Official Video/Artist - Title prefix)
├── downloader/             yt-dlp child process + stdout/stderr fan-in
├── lyrics/                 fetch_lyrics cascade: embedded.rs (USLT) +
│                           lrclib.rs (get + search fallback)
├── identification/         fpcalc.rs (Chromaprint binary wrapper) +
│                           acoustid.rs (HTTP client) + mod.rs (cascade)
├── karaoke/                whisperx.rs (Python wrapper: align + mismatch) +
│                           mod.rs (cascade + LRC parser + A2 serializer +
│                           mismatch detection)
├── contracts.rs            tipos serializados a TS
└── errors.rs               AppError + AppResult

src-tauri/resources/
├── bin/
│   └── fpcalc.exe          Chromaprint 1.5.1 (bundleado, .gitignore-ado);
│                           resuelto vía resolve_binary_or_bundled()
└── scripts/
    ├── karaoke_align.py    whisperx Python API en align-only mode (~80 líneas);
    │                       shippeado vía Tauri bundle.resources
    └── mismatch_detect.py  whisperx transcribe + phonemizer (IPA) +
                            Levenshtein per-line; mismatch detection Nivel 2
```

**Estado actual:**
- Fase 0 (setup) ✓
- Fase 1 (MVP) **100%** ✓ — los 10 criterios "done" cerrados.
- **AcoustID identification Fase 1 + Fase 2** ✓ (2026-05-02) — single-track
  IDENTIFY + bulk IDENTIFY ALL. Pisa metadata sucia con canónica de
  MusicBrainz. **`[ID]` ⊥ `[L]`**: identificación y disponibilidad de
  letras son independientes. Ver [docs/IDENTIFICATION.md](./docs/IDENTIFICATION.md).
- **MB metadata expansion + Cover Art Archive** ✓ (2026-06-18) — el cascade
  de identify ahora trae **genre + year + album + release_group_mbid** desde
  MusicBrainz en un solo request adicional (`inc=tags+genres+releases+release-groups`).
  Lógica de selección de release-group: prefiere Album, earliest first-release;
  dedup por id. **Cover Art Archive**: durante el backfill, descarga el front
  cover canónico por release_group_mbid si el track no tenía portada. Mismo
  throttle 1 req/seg (MB + CAA dentro del mismo intervalo). Botón **MB BACKFILL**
  en la library toolbar; criterio amplio (genre malo, year null, album null o
  cover null). Ver [ADR-035](./docs/DECISIONS.md#adr-035--identify-extendido-mb-metadata-genre--year--album--cover-art-archive).
- **Lyrics Fase 2.a** ✓ (2026-05-03) — drift correction (`speedRatio`) +
  SET OFFSET HERE (botón ALIGN) + RESET extendido + auto-baseline por
  duration ratio.
- **Karaoke Fase A** ✓ (2026-05-04) — forced alignment via WhisperX en
  align-only mode + parser A2 + botón AUTO-ALIGN. **Caveat:** la calidad
  del alignment depende de la calidad del LRC; con LRCLIB community-curated
  hay tracks donde funciona excelente y tracks donde el mismatch text↔audio
  hereda errores. Ver [docs/KARAOKE.md §13](./docs/KARAOKE.md#13-lecciones-aprendidas-fase-a)
  para el journey completo de implementación + límites honestos.
  **Estado actual (2026-06-23): karaoke per-word REAL activo** vía hybrid fill
  por confianza (Mejora 1, ver abajo) — ya **no** es el "fake karaoke"
  (interpolación uniforme) que hubo en el ínterin. Las piezas que destrabaron
  esto ya están shipped: 2.c.3 (NetEase, +cobertura synced), 2.c.4a
  (auto-fallback por confidence) y 2.c.4b (auto-detect de mismatch). Las
  palabras con score bajo se interpolan suave entre anchors confiables en vez
  de saltar.
- **Lyrics Fase 2.c.1 — manual edit modal** ✓ (2026-06-14) — botón EDIT en
  LyricsView abre modal con textareas synced + plain. Save vía
  `lyrics_save_manual_edit` sobreescribe `original_synced_lyrics` (preserva
  edición a través de RE-ALIGNs) y resetea offset/speedRatio/aligned_at.
  **Caveat de UX honesto**: es escalera de emergencia para usuario técnico,
  no flujo seamless. Ver [docs/LYRICS.md "Bandera de UX"](./docs/LYRICS.md)
  para el path hacia automatización (NetEase ✓ 2.c.3 + auto-fallback por
  confidence + auto-detect de mismatch via whisperx score, pendientes).
- **Equalizer 10 bandas** ✓ (2026-06-14) — `BiquadFilterNode` chain ISO
  estándar (lowshelf + 8 peaking + highshelf), ±12dB, tab EQ dedicada con
  sliders verticales, BYPASS preserva preset, double-click resetea banda
  individual. Insertado entre `preMasterGain` y `masterGain` → visualizer
  (tap pre-EQ) independiente. Ver [ADR-023](./docs/DECISIONS.md#adr-023).
- **Playlists** ✓ (2026-06-14, cerrado 2026-06-16) — CRUD + add/remove
  tracks + sidebar UI + **rename inline (doble-click)** + **reorder por
  drag & drop** (`playlist_reorder` reescribe `position`; sólo en vista de
  playlist sin search activo) + `getQueue()` lee de playlist seleccionada →
  NEXT/PREV/shuffle navegan dentro de la playlist. Schema desde Fase 0 (no
  migración nueva). **Cache de la playlist seleccionada se sincroniza vía
  `libraryStore.loadTracks()`** (único punto): identify/clean/scan/fetch de
  letras refrescan también `tracksOfSelected`. **Export M3U** ✓ (2026-06-18):
  botón M3U en hover del sidebar (sólo si la playlist tiene tracks) → save
  dialog nativo (`@tauri-apps/plugin-dialog`) → comando `playlist_export_m3u`
  escribe extended M3U con rutas **absolutas** (`#EXTINF:<seg>,<artista> -
  <título>`). El filesystem lo toca Rust, no el frontend.
- **Smart playlists** ✓ (2026-06-18) — motor multi-regla (AND/OR). Columnas
  `is_smart` + `rules` (JSON) en `playlists`; **sin filas en
  `playlist_tracks`** (membresía derivada de reglas, recalculada por query).
  El query builder ([db/smart.rs](src-tauri/src/db/smart.rs)) usa
  `sqlx::QueryBuilder`: **whitelist** de campos (columna por `match` contra
  literales) + valores **siempre por `push_bind`** (cero inyección);
  condiciones inválidas se descartan, sin ninguna válida → `WHERE 1=0`.
  Campos: title/artist/album/genre (text), year/play_count (num),
  added_within_days/played_within_days (fecha relativa). `list_tracks`
  ramifica smart vs JOIN normal → `getQueue()` + `playlist_export_m3u`
  funcionan en smart sin cambios. UI: botón `+ SMART ⚡` → `SmartPlaylistModal`,
  marcador ⚡ + EDIT en el sidebar; `LibraryTable` deshabilita reorder y +/−
  (read-only). **Picker cascadante** ✓ (2026-06-18) — operadores `in`/`not_in`
  (value JSON array), comando `playlist_smart_distinct_values` con prefilter
  por reglas hermanas excluyendo el mismo field; `MultiSelectPicker` brutalist
  con search + checkboxes custom. Default op `in` para text/numeric; cascade
  activa en modo `all` (AND), inerte en `any` (OR). Orphan values (seleccionados
  pero fuera del prefilter actual) renderizados arriba con marker `?`. Ver
  [ADR-034](./docs/DECISIONS.md#adr-034--smart-playlists-motor-multi-regla-con-query-builder-dinámico)
  + [ADR-036](./docs/DECISIONS.md#adr-036--smart-playlists-picker-cascadante--operador-innot_in).
- **Descarga de listas** ✓ (2026-06-16) — toggle **FULL PLAYLIST** en el
  DownloadForm (default OFF = `--no-playlist`, un solo video; ON =
  `--yes-playlist`). `run_yt_dlp` devuelve `Vec<DownloadedEntry>` (multi-file)
  con `playlist_title`/`playlist_index` parseados del `--print` tab-delimited.
  Si fue lista, los tracks van a "all tracks" **y** a una playlist
  (`get_or_create_id` por nombre → idempotente al re-bajar). Progreso por item
  vía evento `download-item` (N/M). Para listas ya bajadas, recupera el path de
  la línea `has already been downloaded` (por si yt-dlp saltea `done`).
  **Éxito parcial**: si un item de la lista falla (borrado/privado/region-locked)
  yt-dlp sale con exit ≠ 0 aunque baje el resto; `run_yt_dlp` se queda con los
  entries capturados en vez de descartar todo (sólo es falla real cuando no se
  materializó nada). Ver Gotcha #19 + [ADR-028](./docs/DECISIONS.md#adr-028).
  **Cookies** (dos fuentes, archivo > navegador): select de navegador
  (`cookiesBrowser`) → `--cookies-from-browser <b>`, **o** botón COOKIES FILE
  (`cookiesFile`) → `--cookies <archivo.txt>`. Ambos persistidos en
  downloadStore; si hay archivo, el select queda inerte. Necesario para
  **playlists privadas** (yt-dlp anónimo devuelve "playlist does not exist") +
  videos age-restricted / members-only. El archivo (cookies.txt exportado)
  funciona con el navegador abierto — único camino con Chromium en Windows,
  ver Gotcha #18. "" = sin cookies (default).
- **Dedup de descargas** ✓ (2026-06-16) — en `persist_downloaded_file`, dos
  niveles: (1) **por path** (`file_path UNIQUE` + `--no-overwrites`) para el
  mismo video; (2) **por contenido** vía fingerprint Chromaprint exacto
  (`find_id_by_fingerprint`) para la misma grabación traída de otro upload →
  borra el archivo nuevo y reusa el track. Match **exacto** a propósito (cero
  falsos positivos; re-encodes con master distinto NO matchean — mismo
  principio que Gotcha #11). Sólo dedupea contra tracks con fingerprint
  cacheado (download nuevo guarda el suyo, o identify previo). Requiere
  `fpcalc`; sin él cae a dedup por-path solamente. **No aplica al SCAN** (no
  borramos archivos del usuario).
- **History persistente + cancelar descargas** ✓ (2026-06-18) — la tabla
  `downloads` ahora se persiste (insert al arrancar → su id ES el download_id;
  finish al terminar). Se carga al boot (`list_recent`); fila con **fecha**
  (`completed_at`), descargas de lista **expandibles** (guardan `playlist_id` →
  lazy-load de tracks), botones CLEAR HISTORY / ✕ / **CANCEL**. Cancelar =
  `oneshot` por download + `download_cancel` mata yt-dlp (`tokio::select!`,
  feature `macros`) **conservando los parciales** (estado Cancelled). **Reconcile
  al boot**: filas no-terminales de sesiones previas (app cerrada a mitad) →
  `failed` (sino quedan "pegadas" en downloading). **Limpieza de `_pending`** al
  boot (temporales huérfanos). Ver [ADR-031](./docs/DECISIONS.md#adr-031--history-de-descargas-persistente--reconcile-de-huérfanas),
  [ADR-032](./docs/DECISIONS.md#adr-032--cancelar-descarga-conservando-parciales).
- **Drag & drop import** ✓ (2026-06-18) — arrastrar archivos/carpetas a la
  ventana los importa a la library (sin SCAN). Usa el **drag-drop nativo de
  Tauri** (`onDragDropEvent` → paths reales), distinto del HTML5 DnD (roto en
  WKWebView, Gotcha #17) y del pointer-events del reorder. Comando
  `library_import_paths` reusa `import_one_file` (idempotente). Overlay
  "DROP TO IMPORT". Ver [ADR-033](./docs/DECISIONS.md#adr-033--import-por-drag--drop-via-drag-drop-nativo-de-tauri).
- **Hardening del downloader (Windows)** ✓ (2026-06-17, extendido 2026-06-21)
  — sesión dedicada a hacer la descarga de playlists robusta en Windows. Ocho
  cambios + un aprendizaje de uso (ver [ADR-028](./docs/DECISIONS.md#adr-028),
  [ADR-038](./docs/DECISIONS.md#adr-038--impersonación-de-navegador--stdin-null-en-yt-dlp)
  + Gotchas #18-22, #29):
  1. **cookies.txt** como segunda fuente (botón COOKIES FILE, prioridad sobre
     el navegador) — Chromium en Windows lockea su DB de cookies con el
     navegador abierto (Gotcha #18).
  2. **Éxito parcial**: un item roto en la playlist ya no descarta toda la
     descarga; + captura de líneas `ERROR:` para mensajes útiles (Gotcha #19).
  3. **`--js-runtimes node`**: YouTube exige resolver un JS challenge; sin
     runtime sólo da storyboards. Node ≥22 pasa a ser dep del sistema
     (Gotcha #20).
  4. **SQLite WAL + busy_timeout**: el persist loop largo se colgaba por
     contención de lock con el frontend (Gotcha #21).
  5. **Persist resiliente por entry**: un archivo que falla se saltea, no
     aborta la playlist (ADR-028).
  6. **`--encoding utf-8`**: yt-dlp mutilaba los paths no-ASCII (kanji, hangul,
     fullwidth) al imprimir bajo el codepage de Windows → el archivo no se
     encontraba (Gotcha #22).
  7. **`--impersonate Chrome`** (2026-06-21): YouTube throttlea descargas sin
     TLS fingerprint de navegador (~180KB/s vs ~4MB/s). Las descargas parecían
     congeladas en la UI (Gotcha #29, [ADR-038](./docs/DECISIONS.md#adr-038--impersonación-de-navegador--stdin-null-en-yt-dlp)).
  8. **`.stdin(Stdio::null())`** (2026-06-21): previene hang si yt-dlp intenta
     prompts interactivos (consent, captcha) dentro de Tauri sin TTY.
  - **Aprendizaje de uso**: un `cookies.txt` exportado puede verse "completo"
    (cientos de cookies) pero faltarle `LOGIN_INFO` (httpOnly de YouTube) →
    "Unable to recognize playlist". `--cookies-from-browser firefox` la incluye
    y es el camino confiable para playlists privadas. (Firefox no sufre el lock
    de Gotcha #18 en ninguna plataforma.)
- **Lyrics Fase 2.c.3 — NetEase** ✓ (2026-06-18) — tercer provider synced
  free/keyless en el cascade (`Embedded → LRCLIB → NetEase → not_found`).
  Devuelve LRC directo, matching conservador por duración (±8s), todo falla
  graceful a not_found. **Reemplazó el plan de Musixmatch** (free tier
  preview-only / de pago). Sin key ni modal. Botón REFETCH en not_found
  (flag `force` en `lyrics_fetch`). Ver [ADR-030](./docs/DECISIONS.md#adr-030--netease-como-tercer-provider-free-keyless)
  y [docs/LYRICS.md §15](./docs/LYRICS.md#15-netease-fase-2c3).
- **Panel DETAILS en sidebar** ✓ (2026-06-19) — PlaylistSidebar gana un
  toggle de tabs PLAYLISTS / DETAILS (persistido en `uiStore.sidebarTab`).
  La pestaña DETAILS **auto-sigue al `currentTrackId`** y muestra cover
  full-width + 5 secciones brutalist (TRACK / TECH / PLAYBACK / EXTERNAL
  / SOURCE) con KV components copyable para MBID / ACOUSTID / URL / PATH.
  Backend: `TrackDetails` contract con TODOS los campos de la DB +
  `file_size_bytes` (leído del filesystem on-demand con
  `tokio::fs::metadata`); comando dedicado `library_get_track_details` —
  intencionalmente fuera de `list_tracks` para no engrosar el listado.
  Race-guard en el fetch del frontend.
- **Play count tracking** ✓ (2026-06-19) — `library_record_play` incrementa
  `play_count` + `last_played_at` en DB. Threshold estándar de scrobbling
  (30s mínimo AND 50% de duración OR 4min, lo que sea menor). Flag
  `_playRecorded` en playerStore previene duplicados; se resetea en cada
  cambio de track (loadAndPlay, gaplessSwitch, crossfade, resume).
- **Tests + CI** ✓ (2026-06-19) — tests de DB con SQLite temporal real
  (`tempfile` + `sqlx::migrate!`, cero mocks). 5 tests en `db/tracks.rs`
  (insert, idempotencia, record_play, find_by_path, get_details None).
  Helper `db::test_pool()` reutilizable. **GitHub Actions CI** en
  `.github/workflows/ci.yml`: Rust job (Windows + macOS matrix, `cargo
  check` + `cargo test` + cache) + Frontend job (Ubuntu, `tsc --noEmit` +
  `pnpm build`). Se ejecuta en push a main y PRs. **Build de producción
  validado** en Windows (`pnpm tauri build` → MSI + NSIS funcionando).
- **Lyrics Fase 2.c.4a — smart cascade** ✓ (2026-06-19) — el cascade de
  providers ya NO para en el primer synced que encuentra. Si un provider
  devuelve synced con `confidence < 0.7`, lo retiene como candidato y sigue
  al siguiente provider — al final devuelve el de mayor confidence. Synced
  con confidence >= 0.7 sigue siendo fast-path (retorno inmediato).
  Constante `CONFIDENCE_THRESHOLD` en `lyrics/mod.rs`. Escenario concreto:
  LRCLIB fuzzy match con confidence 0.3 (duración muy distinta = live
  version) ya no bloquea que NetEase devuelva un match correcto (0.85).
- **Lyrics Fase 2.c.4b — alignment score + mismatch detection** ✓
  (2026-06-19) — **Nivel 1:** `align_track` calcula el promedio de
  `word.score` (0..1) de los word timings de WhisperX y lo persiste en
  `lyrics.alignment_score` (migración `20260619000001`). Score bajo
  (< 0.5) indica mismatch LRC↔audio. **Nivel 2:** script
  `mismatch_detect.py` transcribe el audio con **faster-whisper directo**
  (sin pipeline whisperx), convierte ambos textos (LRC + transcripción) a
  fonemas IPA vía `phonemizer` (espeak-ng), y calcula Levenshtein
  normalizado por línea. Botón **CHECK QUALITY** en el panel de lyrics →
  panel con score overall + líneas mismatched (<50%).
  Deps: `phonemizer` (`pipx inject whisperx phonemizer`) + `espeak-ng`.
  Fallback a comparación de texto raw si phonemizer no está instalado.
  **Auto-detect de idioma** (2026-06-19): tanto mismatch detection como
  AUTO-ALIGN pasan `language="auto"` → detectan español, japonés, etc.
  automáticamente. AUTO-ALIGN transcribe 30s del audio con whisper base
  para detectar el idioma, luego carga el wav2vec2 correspondiente.
  **Bypass de VAD** (2026-06-19): mismatch detection usa
  `faster_whisper.WhisperModel.transcribe()` directamente en vez del
  pipeline de whisperx, salteando el VAD de pyannote que filtraba ~60%
  de voces cantadas sobre instrumentación pesada (ver Gotcha #27).
  Modelo "small" (más preciso en no-inglés que "base").
  **Normalización de texto** antes de fonemizar: NFC Unicode, lowercase,
  strip puntuación, collapse whitespace. **Fix phonemizer batch**:
  phonemizer descarta strings vacíos del batch output, rompiendo el
  indexing — ahora se fonemizan solo textos no-vacíos y se reconstruye
  el array completo.
  **Guía visual**: después de AUTO-ALIGN muestra alignment score + link
  a CHECK QUALITY si <50%; después de CHECK QUALITY con mismatches
  muestra "USE EDIT TO FIX BAD LINES, THEN RE-ALIGN". Word-level
  matching en mismatch (faster-whisper con `word_timestamps=True` da
  per-word timing directamente, sin paso de alignment separado).
- **Cascade de lyrics resiliente** ✓ (2026-06-19) — errores de red en un
  provider (LRCLIB caído, timeout NetEase) ya no abortan el cascade. Se
  logean y se sigue al siguiente provider. Antes, un `?` propagaba el
  error y todo fallaba.
- **Karaoke quality — Mejora 1 (hybrid fill por confianza)** ✓ (2026-06-21):
  el A2 LRC se extendió a `<mm:ss.xx|score>word`: `build_a2_lrc` propaga el
  `score` (0..1) de cada `WordTiming` de whisperx. El parser frontend
  (`parseA2Markers`) lo lee a `LrcLine.wordScores`; backwards-compat con A2
  sin score (queda undefined). En `useSyncedLyrics`, las palabras con
  `score < 0.3` ya no usan su timestamp (poco confiable — wav2vec2 entrenado
  en habla, no canto): su ventana de fill se **interpola por caracteres entre
  las palabras confiables vecinas** (anchors). El fill fluye suave en vez de
  saltar. Tracks con todo score alto se comportan idéntico a antes. **Sólo
  toca timing, nunca el texto.** La Mejora 2 del plan (auto-fix: reemplazar
  líneas del LRC con la transcripción de whisper) **se descartó a propósito**
  — transcribir canto es menos confiable que el LRC curado, no queremos pisar
  letra humana con la adivinanza del modelo. EDIT manual sigue siendo el path
  para corregir letras. Ver [docs/KARAOKE.md §14](docs/KARAOKE.md).
- **Indicadores de whisperx (UX)** ✓ (2026-06-21) — whisperx era "disabled
  silencioso". Dos preguntas distintas: ¿están instaladas las tecnologías? vs
  ¿ya se procesó ESTA canción? (a) **Deps:** línea en el panel LYRICS
  (`WHISPERX: OK · ESPEAK-NG: OK` o `NOT DETECTED — INSTALL…`) + feedback de
  run (`ALIGNING… FIRST RUN DOWNLOADS THE MODEL`). (b) **Per-canción:** cartel
  explícito en LYRICS (`ALIGNED ✓ <fecha> — ALIGN SCORE X%` / `NOT ALIGNED
  YET`; `QUALITY CHECKED: X% · <fecha>` / `NOT CHECKED YET`) + marcador
  `[K]` per-track en la LibraryTable (vs `[L]`) — el `lyrics_status` ganó el
  estado `'aligned'` (`aligned_at IS NOT NULL`) por CASE en `db/tracks.rs`.
  **CHECK QUALITY ahora se persiste** (`lyrics.mismatch_score` +
  `mismatch_checked_at`, migración `20260621000001`; se resetea cuando el LRC
  cambia). Ver [docs/KARAOKE.md §14.3](docs/KARAOKE.md).
- **Lyrics — módulo de edición (T1) inc.1: flag visual inline** ✓ (2026-06-23)
  — las líneas con mismatch (CHECK QUALITY score <50%) se marcan **dentro** del
  panel synced (borde accent + badge `⚠NN%` + `audio: "<transcripción>"`), en
  vez de una lista aparte. **Score per-línea persistido** (`lyrics.mismatch_lines`
  JSON, migración `20260623000001`) → sobrevive reinicios y cambios de track; se
  invalida cuando el LRC cambia (refetch / manual edit). Se eliminó el estado en
  memoria `mismatchResult` (quedaba pegado del track anterior y, vía un guard,
  ocultaba el panel ALIGNED/QUALITY en el nuevo) → **única fuente `current`**,
  recarga por track. Botón **RE-CHECK QUALITY** cuando ya se chequeó. Match
  línea↔mismatch por texto normalizado (robusto a A2-align). Roadmap del módulo
  (inc.2 edición inline, inc.3 auto-refetch, etc.) en
  [docs/BACKLOG.md](docs/BACKLOG.md) (T1).
- **Fix audio: resume del AudioContext** ✓ (2026-06-23, en observación) —
  macOS/WKWebView suspende el ctx tras sleep / idle / cambio de output device
  (ej: desconectar/reconectar audífonos BT) → el `<audio>` avanza pero no suena
  (audio ruteado por `createMediaElementSource`, Gotcha #2).
  `ensureAudioContextRunning()` en `fadeInPlayPause()` + hook
  `useAudioContextResume` (devicechange / focus / visibility). Ver Gotcha #32 +
  B2 en [docs/BACKLOG.md](docs/BACKLOG.md).
- **Editor de timing con waveform (T6)** ✓ en progreso (2026-06-24/25) —
  mini-DAW para afinar el timing del karaoke. Overlay full-screen
  ([WaveformEditor.tsx](src/components/lyrics/WaveformEditor.tsx)) que abre el
  botón **TIMING** en LyricsView. Decodifica el audio
  (`convertFileSrc` + `fetch` + `decodeAudioData`, peaks en **canvas custom**,
  con stride para no congelar). **Dos vistas:** *overview* (canción completa =
  timeline de líneas: ticks, hover + tooltip con la letra; **click = seek**,
  **doble-click = zoom** centrado, **rueda = zoom** (suavizado para trackpad),
  **shift+rueda o drag = pan**, `FULL VIEW` + indicador de % de zoom) y
  *detalle* (zoom a la línea seleccionada con las **palabras como cajas** sobre
  la onda; **pan lateral** por drag/rueda). **Edición (pointer-events, Gotcha #17):** en el detalle, mover
  palabra (handle/label de arriba) / resize cotas / **push de colisión** entre
  palabras; en el overview, **mover la línea** entera (traslada las palabras
  manteniendo duración — NO escala). **FOLLOW** (sigue la línea que suena) +
  **LOOP LINE** (repite). **Guardado:** **SAVE LINE** serializa el A2 re-editado
  y llama `lyrics_save_word_timing` — actualiza `synced_lyrics` + `aligned_at`
  **sin** resetear texto/offset/speed/quality (a diferencia del manual edit de
  texto). **Formato A2 extendido a start+end por palabra** (`<s>word<e>`, ver
  [docs/KARAOKE.md §6.1](docs/KARAOKE.md)) → permite gaps;
  parser/serializer/renderer actualizados. Fases + caveats (duración de línea
  parqueada) en [docs/BACKLOG.md](docs/BACKLOG.md) (T6).
- **Karaoke Fase B (fullscreen)** ✓ MVP (2026-06-25) —
  [KaraokeView.tsx](src/components/lyrics/KaraokeView.tsx), overlay global
  montado en App. Línea activa gigante con **sweep per-word** (reusa
  `useSyncedLyrics` + `.karaoke-word`), línea pasada/próxima, **countdown** en
  gaps instrumentales (sólo con fin de línea explícito A2) y progress bar abajo.
  Trigger: botón **KARAOKE** en LyricsView o tecla **`K`** (toggle, gated por
  track cargado); salida con **Escape**/EXIT. Estado `uiStore.karaokeOpen`
  (runtime, no persistido); cerrado pasa `NO_LINES` a `useSyncedLyrics` → cero
  rAF de fondo. Ver [docs/KARAOKE.md §8](docs/KARAOKE.md).
- Próximo (orden acordado con Bryan 2026-06-18): quick wins **cerrados** (drag
  & drop ✓ + history persistente ✓ + export M3U ✓ + smart playlists ✓).
  **(2) calidad/plataforma** — ✓ testing Windows, ✓ `pnpm tauri build`,
  ✓ tests + CI. **(3) lyrics/karaoke quality** — smart cascade ✓, alignment
  score ✓, mismatch detection ✓. **Features grandes**: Karaoke Fase B ✓
  (fullscreen), pendientes Fase C-E + Identification Fase 3. **Tareas vivas +
  priorización en [docs/BACKLOG.md](docs/BACKLOG.md)** — T1 (módulo de edición
  de lyrics, inc.1/inc.2 ✓).

---

## Convenciones

### Rust
- `snake_case` comandos Tauri.
- Errores: enum `AppError` con `thiserror`, serializable.
- `commands/*` son thin wrappers — lógica en módulos de dominio (`db/`, `audio/`, `downloader/`, `lyrics/`).
- Tipos compartidos con frontend en `contracts.rs`.

### TypeScript / React
- `camelCase` para variables y funciones, `PascalCase` para componentes y tipos.
- Stores Zustand por dominio. State persistido vía `persist` middleware
  con `partialize` explícito (no persistir runtime state). **Bumpear
  `version`** cuando cambies un default que ya esté en localStorage.
- Singleton de DOM/Web Audio en `src/audio/*` — no JSX-mounted, así otros
  subtrees (Visualizer) pueden tapear el grafo sin coordinación de refs.
- Eventos de Tauri: hooks dedicados que listen una vez en `useEffect`
  (ej: `useDownloadEvents`). No `listen()` en componentes de hoja.
- **Botones interactivos**: usar `<Button>` (con `variant` y `size`).
  Toggles → `variant={on ? "active" : "default"}`. No tocar colores via
  `className` (ver Gotcha #1).

### Estilo visual
- Tokens en `src/styles/tokens.css`. No inventar colores nuevos — usar variables existentes.
- Border-radius: `0` siempre. Si ves `rounded-*` en código, es bug.
- Transiciones: `50-80ms` máximo o ninguna.
- Sombras: sólo hard (`4px 4px 0 var(--border)`), nunca blur.

---

## Comandos

```bash
# dev (Vite + Tauri webview con HMR)
pnpm tauri dev

# build de producción (binario)
pnpm tauri build

# typecheck frontend (sin emit)
pnpm exec tsc --noEmit

# build vite a dist/ (para verificar que el bundle arma)
pnpm build

# cargo check del backend (rápido, sin tauri runtime)
cd src-tauri && cargo check

# cargo test (cuando haya tests)
cd src-tauri && cargo test
```

**Deps del sistema** que el usuario tiene que tener en PATH para que
el downloader funcione: `yt-dlp`, `ffmpeg` (`brew install yt-dlp ffmpeg`
en macOS) y **`node` ≥22** (runtime de JS que yt-dlp usa para resolver el
challenge de YouTube — ver Gotcha #20; alternativa: `deno`). La app verifica
al boot vía `check_dependencies` y muestra un banner si faltan.

**Bundled** (incluido en el binario, no requiere instalación):
- `fpcalc` 1.5.1 (Chromaprint) — identification (AcoustID). Bundleado como
  Tauri resource en `src-tauri/resources/bin/`. `.gitignore`-ado (binario
  platform-specific, no va al repo). En un entorno nuevo, correr
  `pnpm setup:fpcalc` (`tools/setup-fpcalc.sh`) lo descarga para la plataforma
  actual; sin él, el bundle de Tauri falla con `glob pattern resources/bin/*
  ... didn't match any files`.

**Deps opcionales** (features específicas, sin banner — disabled silencioso):
- `whisperx` — forced alignment (AUTO-ALIGN).
- `phonemizer` + `espeak-ng` — mismatch detection (CHECK QUALITY). Si
  `phonemizer` no está, el script cae a comparación de texto raw (funcional
  pero menos preciso).

**Entorno de deps vía pixi** (`pixi.toml`, platforms `win-64` + `osx-arm64`):
las deps opcionales (`whisperx`, `faster-whisper`, `phonemizer` + `torch`)
viven en el env `full`. `pixi install -e full` las instala. **El backend
resuelve los binarios por PATH** (`resolve_binary`), y el env de pixi NO está
en el PATH por default → para habilitar karaoke hay que arrancar la app dentro
del env: **`pixi run -e full dev`** (task definida en `pixi.toml`; `core` =
sin karaoke). En macOS `espeak-ng` va aparte por brew (`brew install
espeak-ng`) — conda-forge no tiene build osx-arm64; `mismatch_detect.py`
apunta la dylib de `/opt/homebrew/lib`. Alternativa sin pixi: `pipx install
whisperx` + `pipx inject whisperx phonemizer` (cae en `~/.local/bin`, que el
resolver ya cubre). `pixi.lock` está `.gitignore`-ado (cada máquina re-resuelve).

---

## Cosas que **no** hacer

- No añadir features fuera del scope del PLAN sin preguntar.
- No introducir librerías pesadas cuando hay una solución nativa (evitar MUI, Chakra, Bootstrap — contradicen brutalist).
- No abstraer prematuramente: preferir tres lugares con código repetido a un helper genérico que nadie entiende.
- No mockear SQLite en tests — usar una DB temporal real (`tempfile` + migrate).
- No commitear con `yt-dlp` bundled (decisión ADR-002 pendiente; por default: detectar, no bundlear).
- No publicar binarios públicamente — el proyecto es personal/portfolio, no producto.

---

## Gotchas (footguns que ya pagamos)

### 1. Tailwind v4: utilities de color en orden alfabético
Las utilidades `bg-bg`, `bg-fg`, `bg-accent` se generan en el CSS layer en
**orden alfabético**, no en el orden que las pongas en el className. O sea
`bg-bg` cae después de `bg-accent` en el CSS final → si tu base tiene
`bg-bg` y querés overridear con `bg-accent` desde un className concatenado,
**`bg-bg` gana**. El botón se queda negro aunque le digas naranja.

**Fix:** elegir un solo set de colores antes de armar el className. En
`<Button>` lo hacemos con `variant: "default" | "active"` que switchea el
set entero, no agrega utilidades de override.

### 2. `audio.volume` queda bypassed con Web Audio
Cuando se llama `createMediaElementSource(audio)` (necesario para que
Butterchurn tapee la señal), Chromium **ignora `audio.volume` y
`audio.muted`**. El volumen real se controla con un `GainNode` en el
grafo. Ver [audio/context.ts](src/audio/context.ts):
`source → GainNode (masterGain) → destination`.

### 3. HMR + Zustand = listeners apuntando al store viejo
Cuando editás un store y Vite hace HMR, los `useEffect` que ya corrieron
mantienen una referencia al store **viejo** en sus closures. Los
listeners del audio (en `useAudioPlayer`) actualizan el store viejo,
los componentes leen del nuevo. Síntoma: progress bar no avanza,
PLAY/PAUSE no togglea, etc.

**Fix:** `Ctrl+C` y restart de `pnpm tauri dev`. En producción no pasa
porque no hay HMR.

### 4. `:active` CSS no se ve con tap-to-click de macOS
Los toques sin presionar el trackpad disparan `:active` por ~5ms, demasiado
corto para verse. Usar el hook `usePressFlash` que mantiene el state
visible 150ms via JS (`onPointerDown` + `setTimeout`).

### 5. `setRendererSize` explícito en Butterchurn
`butterchurn.createVisualizer(ctx, canvas, { width, height })` recibe las
opts pero **no aplica el tamaño al canvas en v2.6.7**. Hay que llamar
`visualizer.setRendererSize(w, h)` después o el canvas queda en 300×150
default y todos los framebuffers internos nacen con tamaño cero.

### 6. yt-dlp imprime el progreso en stderr, no stdout
Sólo el `--print after_move:filepath` va a stdout. `[youtube]`, `[download]`,
`[ExtractAudio]`, etc. van a stderr. Cuando spawneamos yt-dlp leemos
stdout + stderr en paralelo y los fan-in a un `mpsc` channel.

### 7. yt-dlp + Python + pipes = block buffering
Sin `PYTHONUNBUFFERED=1` en el env del child, yt-dlp queda con stdout
block-buffered cuando lo conectás a un pipe. Resultado: el progreso
aparece en tandas o nunca. Ya está seteado en
[downloader/mod.rs](src-tauri/src/downloader/mod.rs).

### 8. Visualizer mount = ~100-300ms de freeze
`butterchurn.createVisualizer` + `loadPreset` compilan shaders WebGL
sincrono en el main thread. Por eso VisualizerView se monta **persistente**
(post-primer-visit) y se oculta con `visibility: hidden` + `pointer-events:
none` cuando no se ve. El rAF loop se pausa (gated por `view + paneMode`)
para no quemar CPU/GPU mientras está oculto. **No re-mountar el canvas**
en cambios de tab/paneMode — el costo se paga una sola vez.

### 9. `AudioParam.value` lee el valor INTRÍNSECO, no computado
En Chromium/WebKit, leer `gain.value` devuelve la última asignación directa
(`gain.value = X`), NO el valor que un ramp activo está produciendo en
ese momento. Si querés cancelar un ramp y empezar otro **desde el valor
audible actual** (ej: pause-fade interrumpido por play), usá
`gain.cancelAndHoldAtTime(t)` — inserta un setValueAtTime implícito con
el valor computado. Sin esto, los fades se sienten como "click" abrupto
en vez de transición continua. Ver [audio/context.ts](src/audio/context.ts).

### 10. Tauri: Rust hot-reload no existe
Cambios en `src-tauri/src/*.rs` requieren matar y volver a levantar
`pnpm tauri dev`. Vite hace HMR del frontend, pero el binario Rust es
un proceso aparte que sigue corriendo el código compilado al startup.
Síntoma: el comando que acabás de modificar tiene comportamiento viejo.

### 11. yt-dlp metadata viene sucia — heurísticas tienen tradeoffs
yt-dlp escribe metadata desde campos de YouTube que vienen ruidosos:
`artist="Avicii - Topic"`, `title="Avicii - The Nights (Official Video)"`,
artistas `"AviciiOfficialVEVO"` (canales sin espacios). El cleanup en
[audio/cleanup.rs](src-tauri/src/audio/cleanup.rs) tiene **heurísticas
conservadoras** — strip de patrones específicos (Topic, VEVO,
OfficialVEVO, parens con Official Video/Lyric Video/etc, prefix
`<artist> - ` en title). Trade-off explícito: preferir falsos negativos
(no limpiar) sobre falsos positivos (borrar contenido legítimo). Para
matchear tracks que las heurísticas no alcanzan, ahora tenemos AcoustID
([identification/](src-tauri/src/identification/)) que pisa la metadata
con la canónica de MusicBrainz cuando hay match con score alto.

**`genre` es especialmente inútil (resuelto parcial 2026-06-18):** yt-dlp
escribe ahí la *categoría* del video de YouTube ("Music", "People & Blogs",
"Gaming"), no el género musical. En una library bajada de YT casi todo queda
`genre="Music"`. Las heurísticas de cleanup **no** tocan genre (no hay forma
confiable de derivar el género real del título). **Fix actual ([ADR-035](docs/DECISIONS.md#adr-035--identify-extendido-mb-metadata-genre--year--album--cover-art-archive)):**
para tracks identificados (con `mbid_recording`), el botón **MB BACKFILL**
trae genre real desde MusicBrainz (tags + genres curados). Tracks
no-identificados siguen necesitando tagging manual. Cobertura observada
~70-80% en mainstream.

### 12. LRCLIB **no** acepta lookup por MBID
Asunción que se pagó: el plan original de identification proponía hacer
`/api/get?track_mbid=<uuid>` para letras exactas vía MusicBrainz ID.
Verificación contra la API real (curl) confirmó que LRCLIB sólo acepta
`track_name`+`artist_name`+`album_name`+`duration`. No hay endpoint con
MBID en `/api/get`, ni `/api/search?mbid=...`, ni `?recording_mbid=...`
(devuelven `[]` o error). El valor real de AcoustID es entregar
**metadata canónica limpia** que feedea al cascade text-based existente,
no un lookup directo. Si en el futuro aparece otro provider de letras
(Genius, NetEase) que sí acepte MBID, ahí sí servirá — el MBID está
persistido en `tracks.mbid_recording`.

### 13. `[ID]` ⊥ `[L]` — son independientes
Confusión natural pero importante: la columna ID (identification AcoustID)
y la columna L (lyrics LRCLIB) reportan dos verdades distintas. Un track
puede tener `[ID]` y no tener `[L]` — no es bug. MusicBrainz tiene cobertura
~50M+ recordings; LRCLIB es comunitario y mucho más chico. DJ livesets,
indie nicho, y muchos idiomas (J-pop, K-pop indie, latino indie) caen en
"`[ID]` + `—`" porque están en MB pero no tienen letra en LRCLIB. Ver
[IDENTIFICATION.md §1.4](docs/IDENTIFICATION.md#14-id--l--son-independientes).

### 14. PATH no se hereda al proceso Tauri en macOS
El proceso Tauri lanzado vía `cargo run` (que es como `pnpm tauri dev`
spawnea el binario) **no siempre hereda el PATH completo del shell** del
usuario. Especialmente `~/.local/bin/` (donde pipx pone los binaries)
suele faltar. Síntoma: `which::which("whisperx")` retorna false aunque
en la terminal del usuario `which whisperx` funcione bien.

**Fix:** [`commands::system::resolve_binary`](src-tauri/src/commands/system.rs)
con fallback. Primero intenta `which`, después chequea `~/.local/bin/<name>`,
`/usr/local/bin/<name>`, `/opt/homebrew/bin/<name>`. En Windows: `USERPROFILE`
en vez de `HOME`, y candidatos adicionales `%USERPROFILE%\.local\bin\<name>.exe`.
Detección + spawn ambos lo usan. Si pipx mueve sus binaries en el futuro,
agregar el path al fallback.

### 15. Forced alignment ≤ calidad del LRC
WhisperX hace forced alignment de los fonemas del texto provisto contra
el audio. Si el texto del LRC no coincide con el audio (LRCLIB tiene
letras aproximadas o community-curated con errores), **el alignment
hereda el mismatch** y los timestamps salen mal en proporción a cuánto
difieren texto y audio.

**Lo que NO se puede arreglar automático:** un LRC que dice "There's a
vulture perching right offscreen" cuando el audio canta "right out of
me". WhisperX busca los fonemas de "offscreen" y los ubica donde mejor
matchea — pero si nunca aparecen, el resultado es ruido.

**Lecciones del journey de bounds**: probamos cuatro approaches (whole-track,
tight LRC, buffer ±3s, blind transcribe + proporcional). Los detalles vivos
en [KARAOKE.md §13.2](docs/KARAOKE.md#132-el-journey-de-los-segment-bounds).
Approach final: **tight LRC bounds**. Más predecible — confina errores a
la línea afectada en vez de propagarlos.

**Path forward para LRC malo**: UI manual edit (Lyrics Fase 2.c). Si el
usuario corrige el LRC, el alignment automático mejora.

### 16. Re-align idempotente requiere `original_synced_lyrics` backup
Bug que costó tiempo: cada `RE-ALIGN` operaba sobre `synced_lyrics` actual.
Pero después del primer alignment, `synced_lyrics` ya tenía A2 con
timestamps de whisperx (posiblemente equivocados). El cascade extraía
esos como bounds → resultados peores cada round.

**Fix:** columna `lyrics.original_synced_lyrics TEXT` que guarda el LRC
raw como vino de LRCLIB la primera vez. Cascade siempre lee de ahí.
Mismo patrón que `tracks.original_title` para identification. Ver
[ADR-020](docs/DECISIONS.md#adr-020--backup-original_synced_lyrics-para-re-aligns-idempotentes).

### 17. HTML5 drag-and-drop nativo no funciona en WKWebView (macOS)
El evento `drop` **no dispara** en el webview de macOS aunque hagas todo
"bien": `dataTransfer.setData()` en `dragstart` + `preventDefault()` en
`dragover` **y** `dragenter`. El drag se ve (la fila se arrastra) pero soltar
no hace nada. Es una limitación conocida de WKWebView, no del código.

**Fix:** implementar el drag a mano con **pointer events** — `pointerdown` en
un handle inicia, listeners de `pointermove`/`pointerup` en `window`, y
`document.elementFromPoint()` resuelve el target (vía un `data-*` attr). Sin la
API nativa de DnD. Así está el reorder de playlists en
[LibraryTable](src/components/library/LibraryTable.tsx). Ver
[ADR-027](docs/DECISIONS.md#adr-027--reorder-de-playlist-via-pointer-events-no-html5-dnd).

### 18. `--cookies-from-browser` choca con el lock de Chromium en Windows
`--cookies-from-browser chrome|brave|edge|...` falla con `Could not copy
Chrome cookie database` (yt-dlp issue #7271) **si el navegador está abierto en
Windows**. Causa: Chromium mantiene su base SQLite de cookies con un lock
**obligatorio** (mandatory) a nivel filesystem; Windows le niega a yt-dlp hasta
la copia. En macOS/Linux los locks son cooperativos (advisory) → no pasa, por
eso "en macOS andaba". **Firefox no tiene el problema en ninguna plataforma**
(maneja el archivo distinto). Copiar la DB nosotros choca con el mismo lock
(+ App-Bound Encryption en Chromium reciente) → no vale la pena.

**Fixes (en orden de preferencia):** (1) usar **Firefox**; (2) `--cookies
<archivo.txt>` con un cookies.txt exportado a mano (extensión "Get cookies.txt
LOCALLY") — funciona con el navegador abierto porque no toca la SQLite. El
`DownloadForm` soporta ambos: el select de navegador **y** un botón COOKIES
FILE; el archivo tiene prioridad (`cookies_file` antes que `cookies_browser`
en [downloader/mod.rs](src-tauri/src/downloader/mod.rs)). (3) cerrar el
navegador Chromium del todo (incluido procesos en background).

### 19. yt-dlp sale con exit ≠ 0 si UN item de la playlist falla
En una playlist con un video borrado/privado/region-locked, yt-dlp baja el
resto perfecto pero **sale con código ≠ 0**. Bug que se pagó: `run_yt_dlp`
trataba *cualquier* exit ≠ 0 como falla total → descartaba todos los entries
buenos y la UI mostraba FAILED con la última línea de stderr (que suele ser
`Finished downloading playlist: <name>`, un mensaje de **éxito** — confuso). El
`ERROR:` del item fallido ya scrolleó fuera del buffer de 64 líneas.

**Fix:** si capturamos ≥1 entry, es **éxito parcial** → `Ok(entries)`. Sólo es
falla real cuando no se materializó nada. Ver
[downloader/mod.rs](src-tauri/src/downloader/mod.rs) (chequeo de `entries`
**antes** que `status.success()`). Bonus: ahora capturamos las líneas `ERROR:`
aparte de `recent_lines` y las usamos como mensaje de error (las largas se iban
del buffer de 64 líneas → el error mostrado era el "Finished" engañoso).

### 20. YouTube exige un runtime de JS — sin él, sólo storyboards
yt-dlp falla con `Requested format is not available` para **todos** los items y,
en `-F`, sólo lista formatos `mhtml` (storyboards / imágenes). La causa NO es
cookies ni yt-dlp viejo: YouTube ahora exige **resolver un challenge de
JavaScript** (firma + param `n` de throttling) para entregar los formatos de
audio. yt-dlp trae el solver (`yt_dlp_ejs`) pero necesita un **runtime de JS**
para correrlo, y por default **sólo habilita Deno**. Síntoma en `--verbose`:
`JS runtimes: none` + `WARNING: No supported JavaScript runtime could be found`.

**Fix:** pasamos `--js-runtimes node` (Node ≥22, ya dep del proyecto) en
[downloader/mod.rs](src-tauri/src/downloader/mod.rs). Confirmado: con el flag,
`[jsc:node] Solving JS challenges using node` y aparecen los formatos de audio
(140 m4a, 251 webm, etc). Alternativa: instalar **Deno** (runtime recomendado
por yt-dlp, se auto-detecta sin flag). **Node pasa a ser dep del sistema** para
el downloader, además de yt-dlp + ffmpeg.

### 21. SQLite sin WAL se cuelga en escrituras largas concurrentes
Síntoma que se pagó: descargar una playlist de 16 tracks dejó la UI pegada en
CONVERTING ~15 min. Diagnóstico: yt-dlp terminó bien (16 mp3 en disco), pero el
`persist_downloaded_file` loop (fpcalc + insert por archivo = escritura larga)
se colgó a mitad — solo 6 de 16 tracks llegaron a la DB y las escrituras
pararon. Causa: el pool abría SQLite en journal mode **rollback/DELETE** (default)
sin `busy_timeout`. Mientras el loop escribía, el frontend tocaba la DB en
paralelo (ej: persistencia de la posición de playback del track que sonaba) →
contención de locks (reader bloquea writer y viceversa) → cuelgue.

**Fix:** en [db/mod.rs](src-tauri/src/db/mod.rs), abrir con
`journal_mode(WAL)` + `synchronous(NORMAL)` + `busy_timeout(10s)`. WAL permite
lecturas concurrentes con una escritura sin bloqueo mutuo; busy_timeout
reintenta locks transitorios. Además, el persist loop de
[commands/downloader.rs](src-tauri/src/commands/downloader.rs) ahora es
**resiliente por entry**: un archivo que falla se saltea (log + continue) en vez
de abortar toda la playlist con `?`; sólo es falla real si NO se persistió
ninguno. WAL crea archivos `player.db-wal` / `-shm` al lado de `player.db`
(normal, no borrarlos en caliente).

### 22. yt-dlp mutila los paths no-ASCII al imprimir (Windows codepage)
Síntoma que se pagó: al bajar una playlist de 70 items, ~10 tracks con nombres
no-ASCII (kanji 米津玄師, hangul 뜨거운, `：` fullwidth, Λ griega) fallaron al
persistir con `metadata read failed: ... no such file (os error 2/3)`. Los
archivos **sí estaban en disco** con el Unicode correcto, pero yt-dlp imprimió
el `after_move:filepath` con esos caracteres **reemplazados por espacios**. En
Windows la consola usa un codepage legacy (Latin-1/cp1252 acá); la creación del
archivo usa la API wide (preserva Unicode) pero el `print` a stdout codifica con
el codepage y reemplaza lo no representable. Path impreso ≠ path real → nuestro
`extract_metadata(entry.path)` no encuentra el archivo. Los tracks ASCII andan;
sólo fallan los de otros alfabetos. `PYTHONUTF8=1`/`PYTHONIOENCODING` **no**
alcanzan (el build frozen no los respeta acá).

**Fix:** `--encoding utf-8` en [downloader/mod.rs](src-tauri/src/downloader/mod.rs).
Verificado: con el flag, el path impreso coincide byte-a-byte con disco (kanji
incluidos) y nuestro reader (`from_utf8_lossy`) lo decodifica bien. Las tags
internas del mp3 nunca se vieron afectadas (la metadata mostrada sale de ahí,
no del filename).

### 23. Desconexión/handoff de audífonos — el player no pausa (bug abierto)
**Reportado 2026-06-19, ampliado 2026-06-23. Pendiente investigar. Tarea: B1 en
[docs/BACKLOG.md](docs/BACKLOG.md).** Dos síntomas del mismo problema de fondo
(no reaccionamos al cambio de output device):

1. **AirPods Pro multipoint Mac↔iPhone:** con multipoint emparejado entre Mac
   (este player) y iPhone, al empezar audio en el iPhone el handoff **no es
   limpio** — el audio se entrecorta en vez de "Mac pausa + iPhone arranca".
2. **Sony XM6 — al desconectar los audífonos, el player transiciona a los
   altavoces y sigue sonando, en vez de pausar.** Comportamiento esperado:
   perder el output device (desconexión) → **pausar** (estándar de
   reproductores; evita que la música salga de golpe por los parlantes).

Hipótesis ordenadas por probabilidad (sin verificar todavía):
1. **MediaSession no recibe `pause`** al perder foco → el `<audio>` element
   sigue empujando datos al sink viejo mientras AirPods se mueven al
   iPhone.
2. **`navigator.mediaDevices.ondevicechange` no se escucha** → cuando el
   output device cambia, no lo detectamos para auto-pausar.
3. **Sample rate negotiation** 48kHz (Mac) ↔ 44.1kHz (iPhone) durante el
   handoff causa buffer underrun.
4. **Heurística del firmware AirPods** oscila entre los dos devices porque
   ambos están "activos" simultáneamente.

**Camino de investigación recomendado** (~10 min para descartar #1):
1. En [src/hooks/useMediaSession.ts](src/hooks/useMediaSession.ts) agregar
   `console.log("MediaSession pause")` en el handler de pause.
2. Reproducir en Mac, switchear a iPhone, mirar DevTools.
3. Si dispara → handler existente debería pausar el `<audio>`; ajustarlo.
4. Si no dispara → la API no nos avisa, pasamos a hipótesis #2 (escuchar
   `mediaDevices.devicechange`).

Detalle completo + memoria persistente en
`~/.claude/projects/-Users-bryan-Documents-projects-00-various-media-player/memory/project_airpods_handoff_bug.md`.

### 24. Python scripts deben usar `encoding="utf-8"` en `open()` (Windows)
En Windows, `open()` sin encoding usa el codepage del sistema (Latin-1 /
cp1252). Cuando el JSON de segments contiene caracteres no-ASCII (letras en
español, japonés, etc.), la lectura explota con `UnicodeDecodeError:
'charmap' codec can't decode byte 0x90`. Mismo principio que Gotcha #22
pero en Python en vez de yt-dlp.

**Fix:** `open(path, encoding="utf-8")` en todos los `open()` de
`karaoke_align.py` y `mismatch_detect.py` (lectura + escritura).

### 25. pipx venv layout en Windows ≠ Unix
En Unix, pipx hace `~/.local/bin/whisperx` → symlink a
`~/.local/pipx/venvs/whisperx/bin/whisperx`. `canonicalize()` resuelve
el symlink y `python` está al lado. En Windows: `~/.local/bin/whisperx.exe`
es un wrapper exe (no symlink), y el Python del venv está en
`%USERPROFILE%\pipx\venvs\whisperx\Scripts\python.exe` (path totalmente
distinto). `canonicalize()` del wrapper devuelve el mismo path →
`find_python_for_whisperx` buscaba `python` en `~/.local/bin/` y no lo
encontraba.

**Fix:** fallback en `find_python_for_whisperx` que chequea los paths
estándar de pipx en Windows: `%USERPROFILE%\pipx\venvs\whisperx\Scripts\`
y `%USERPROFILE%\.local\pipx\venvs\whisperx\Scripts\`.

### 26. phonemizer en Windows necesita `PHONEMIZER_ESPEAK_LIBRARY`
`phonemizer` busca espeak como **shared library** (`.so`/`.dll`), no
como exe en PATH. Instalar `espeak-ng.exe` y tenerlo en PATH no alcanza.
Síntoma: `RuntimeError: espeak not installed on your system` aunque
`where espeak-ng` funcione.

**Fix:** `mismatch_detect.py` setea `PHONEMIZER_ESPEAK_LIBRARY` a
`%ProgramFiles%\eSpeak NG\libespeak-ng.dll` automáticamente en Windows
si no está seteada.

### 27. pyannote VAD filtra voces cantadas sobre instrumentación pesada
whisperx usa pyannote como VAD (Voice Activity Detection) antes de
transcribir — decide qué regiones del audio son "habla" y solo transcribe
esas. El modelo está entrenado en speech datasets, no en música. Para
voces cantadas mezcladas con reggaeton / EDM / instrumentación densa, el
VAD filtra ~60% de las voces como "no speech" — resultado: la mayoría
de líneas del LRC no tienen transcripción contra la cual comparar.

Bajar `vad_onset` de 0.5 a 0.1 apenas mejoró (8→10 segmentos) — las
probabilidades de speech del modelo pyannote son genuinamente bajas para
voces cantadas.

**Fix:** `mismatch_detect.py` usa `faster_whisper.WhisperModel.transcribe()`
directamente con `word_timestamps=True`, salteando el pipeline de whisperx
(y su VAD) por completo. Whisper procesa todo el audio sin filtrado →
cobertura completa. Puede producir hallucinations en secciones
instrumentales, pero esas se scorean bajo contra el LRC real — no peor
que `(silence)` y con mucha mejor cobertura en las voces.

### 28. phonemizer descarta strings vacíos del batch
`phonemize(["hola", "", "mundo"])` devuelve `["ola", "mundo"]` — 2 items
en vez de 3. Si el input tiene N textos y M son vacíos, el output tiene
N-M items. Esto rompe el indexing cuando se usa `zip` o slicing con
posiciones asumidas. Síntoma: 111 líneas de LRC pero solo ~51 en el
resultado JSON (las últimas 60 se pierden silenciosamente porque el `zip`
trunca al iterable más corto).

**Fix:** en `mismatch_detect.py`, solo se fonemizan textos no-vacíos y
se reconstruye el array completo con `""` en las posiciones vacías.

### 29. YouTube throttlea descargas sin impersonación de navegador
Sin `--impersonate`, yt-dlp hace requests como un cliente genérico. YouTube
responde con throttling agresivo (~180 KB/s vs ~4 MB/s con impersonate) —
suficiente para que las descargas parezcan **congeladas** en la UI. En la
terminal el efecto es "lento"; en la app (sin TTY, sin progress visible en
la consola) parece un hang total.

**Fix:** `--impersonate Chrome` en
[downloader/mod.rs](src-tauri/src/downloader/mod.rs). Usa `curl_cffi`
(incluido en el exe oficial de yt-dlp) para hacer TLS fingerprinting
idéntico a Chrome. Sin versión específica → yt-dlp elige la más reciente
disponible.

**Caveat macOS/pixi:** el yt-dlp de conda-forge / brew **NO** trae `curl_cffi`
(solo el .exe oficial de Windows lo bundlea) → falla con `Impersonate target
"chrome" is not available`. En el entorno pixi se resuelve sumando `curl_cffi`
como pypi-dependency en `pixi.toml` (conda-forge no tiene build win-64; los
wheels de PyPI traen libcurl-impersonate en todas las plataformas). Verificar
con `yt-dlp --list-impersonate-targets` (Chrome debe aparecer sin
`(unavailable)`).

**Bonus fix:** `.stdin(Stdio::null())` en el spawn de yt-dlp. Previene
que yt-dlp se cuelgue esperando input interactivo (consent, captcha, PO
token prompt) cuando se ejecuta dentro de Tauri sin TTY.

### 30. Un cluster de AcoustID puede agrupar grabaciones DISTINTAS
Síntoma que se pagó: bajamos "BTS - Dynamite", corrimos IDENTIFY, y quedó como
**"Control / Metro Station"** con score 0.971. No fue dedup ni un AcoustID roto:
el cluster del fingerprint (`/v2/lookup`) devolvía **3 recordings** —
`Control / Metro Station` PRIMERA (mislabel comunitario), después dos
`Dynamite / BTS`. El código viejo tomaba **la primera recording con MBID** del
result de mayor score → "Control". El `score` mide qué tan bien matchea el
**fingerprint contra el cluster**, NO que la recording elegida sea la correcta;
AcoustID es comunitario y un cluster puede mezclar canciones por merges/mislabels.

**Fix ([acoustid.rs](src-tauri/src/identification/acoustid.rs) + [mod.rs](src-tauri/src/identification/mod.rs)):**
aplanamos TODAS las recordings de TODOS los results y elegimos la que mejor
**coincide con la metadata existente** del track (`MetadataHint`: tokens
normalizados de `original_title`, o title+artist si no hay). `original_title`
se prefiere porque es el título raw del download/import — NO contaminado por un
identify previo equivocado (clave para que re-identificar el track ya pisado se
auto-corrija). **Safeguard:** si el cluster tiene ≥2 canciones distintas y la
elegida no coincide en NADA con la pista, marcamos `low_confidence` y **no
pisamos** la metadata (el usuario revisa). Un cluster de una sola canción se
confía aunque la metadata vieja fuera basura (el identify existe para eso).
**Recovery del track ya roto:** reiniciar la app (Gotcha #10) y re-IDENTIFY —
ahora elige Dynamite por la pista de `original_title`.

### 31. Un 429 de LRCLIB/NetEase NO debe cachear `not_found`
Síntoma que se pagó: recorrer una library grande (260 tracks) dispara el
auto-fetch de letras por cada cambio de track → ráfaga de requests casi
simultáneos → LRCLIB responde **429 Too Many Requests**. El bug: los providers
trataban **cualquier** non-success (incluido 429) como `Ok(None)` = "no hay
letra" → el cascade cacheaba `not_found` **permanente**. Resultado real: 61
tracks marcados "sin letras" que sí tenían letra, solo por el rate limit.

**Fix (dos partes):**
1. **No cachear not_found en falla transitoria.** 404 = no-match genuino →
   `Ok(None)` (se puede cachear). 429/5xx/red → `Err` → el cascade
   ([lyrics/mod.rs](src-tauri/src/lyrics/mod.rs)) setea un flag `transient_failure`
   y, si no encontró nada, **NO** llama `mark_not_found` (deja status null para
   reintentar). Recovery de los ya-marcados: `DELETE FROM lyrics WHERE
   status='not_found' AND <recientes>`.
2. **Throttle + backoff** ([lyrics/mod.rs](src-tauri/src/lyrics/mod.rs)
   `send_throttled`): gate global (`OnceLock<Mutex<Instant>>`) que espacia los
   requests salientes a ~3/seg (`MIN_LYRICS_REQUEST_INTERVAL = 300ms`) + reintento
   con backoff exponencial ante 429 (700ms→1.4s→2.8s, 3 intentos). En uso normal
   (un fetch cada varios minutos) el gate nunca se toca; sólo espacia las ráfagas.

### 32. El AudioContext se suspende y el `<audio>` avanza pero no suena
Síntoma que se pagó: dejar el player abierto un rato (sleep / idle de la Mac, o
desconectar/reconectar audífonos Bluetooth) y al volver la canción **avanza pero
no sale sonido**. Causa: macOS/WKWebView **suspende el `AudioContext`** ante
sleep, idle largo, o interrupciones de audio session (cambio de output device).
Como todo el audio se rutea por `createMediaElementSource` (Gotcha #2), el
`<audio>` element sigue su timeline (por eso "avanza") pero el grafo de Web Audio
dormido no produce sonido. No había `resume()` salvo en el path paused→play del
toggle, así que un ctx suspendido con `isPlaying=true` no se despertaba.

**Fix v1 — resume ([audio/context.ts](src/audio/context.ts) + [useAudioContextResume.ts](src/hooks/useAudioContextResume.ts)):**
`ensureAudioContextRunning()` (resume si `state !== "running"`) llamado desde
`fadeInPlayPause()` → **todo** play reanuda el ctx; + un hook montado en App que
escucha `visibilitychange` / `focus` / `navigator.mediaDevices.devicechange` y,
si `isPlaying`, reanuda. Cubrió el caso `suspended` simple.

**Fix v2 — reconexión de fuentes + priming de devicechange (2026-06-26).** El
síntoma volvió con un detalle nuevo en los logs: (a) aparecía el estado
**`interrupted`** (propio de WebKit, lo dispara la interrupción de la audio
session por cambio de output device BT) y (b) a veces el ctx **se quedaba en
`running`** y mudo, sin `suspended`/`interrupted`. Aprendizajes:
- Tras un `interrupted`, WebKit deja el `MediaElementAudioSourceNode`
  **desconectado del output aunque el ctx vuelva a `running`** → resume solo NO
  alcanza. Hay que **reconectar la fuente** (`source.disconnect()` +
  `source.connect(gain)`; la cadena gain→preMaster→… queda intacta). Se hace en
  el listener de `statechange` al volver a `running` tras suspended/interrupted,
  **y** en `recoverAudioRouting()` (resume + reconnect) que ahora llaman los
  triggers del hook — así reconecta aunque el ctx nunca haya dejado `running`.
- **`devicechange` NO dispara en WKWebView** hasta llamar `enumerateDevices()`
  al menos una vez → el hook lo **primea** al montar. Sin esto el reconectar
  automático ante cambio de BT nunca se enteraba (no había línea `devicechange`
  en los logs).
- Efecto secundario: como `focus`/`visibility` ahora reconectan, queda un
  **escape hatch manual** — click afuera y de vuelta a la ventana recupera el
  audio aunque `devicechange` falle.

**Fix v3 — botón RESET AUDIO (restart de la app) (2026-06-29).** Reconectar
**tampoco alcanzó**: el test clave fue que **YouTube en el navegador sí sonaba**
por los mismos audífonos mientras el reproductor quedaba mudo. YouTube usa el
`<audio>`/`<video>` directo (el OS lo re-rutea); nosotros ruteamos TODO por Web
Audio, y el **`AudioContext.destination` queda clavado en el output viejo** —
WebKit lo bindea al device **al crear el ctx** y no sigue los cambios;
reconectar nodos internos no re-apunta el destination. Confirmado por el usuario:
**cerrar y reabrir la app sí lo arregla** (proceso nuevo = `AudioContext` nuevo
que bindea al device actual). Como el `setSinkId` de `AudioContext` no es
confiable en WKWebView y el visualizer está atado al ctx (recrear in-place
obliga a recrear el visualizer → freeze), la recuperación confiable es **un
proceso nuevo**: comando Rust `restart_app` (`AppHandle::restart()`, core, sin
plugin) detrás del botón **RESET AUDIO** en el PlayerBar. Antes de reiniciar,
`persistResumeNow()` guarda la posición → el resume la restaura al bootear. La
auto-recuperación (v1/v2) se mantiene para los casos `suspended`/`interrupted`
livianos; el botón es el martillo para el destination clavado.
**No confundir con B1**: ahí el objetivo es *pausar* al desconectar (no
*resumir*); mismo origen (no reaccionábamos al cambio de output device),
reacción opuesta. Logs `[audio-debug]` temporales siguen mientras B2 está en
observación ([docs/BACKLOG.md](docs/BACKLOG.md)).

---

## Disclaimer legal (recordatorio)

El uso de yt-dlp puede violar ToS de servicios como YouTube. Este proyecto es de uso personal. No distribuir binarios al público. Incluir disclaimer en el README cuando se escriba.
