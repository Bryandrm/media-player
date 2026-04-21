# Architecture — Brutalist Music Player

> Deep dive técnico. Documento vivo: las secciones marcadas `TODO` se resuelven durante Fase 0/1.
> Decisiones formalizadas viven en [DECISIONS.md](./DECISIONS.md).
> Visión general y scope en [PLAN-reproductor-brutalist.md](./PLAN-reproductor-brutalist.md).

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
│  │  commands::  library · downloader · playback · lyrics   │  │
│  │  db::        sqlite · migrations                        │  │
│  │  audio::     lofty metadata · cover extraction          │  │
│  │  downloader::yt-dlp spawn · progress parser             │  │
│  └────────┬──────────────┬──────────────┬──────────────────┘  │
└───────────│──────────────│──────────────│─────────────────────┘
            ▼              ▼              ▼
       SQLite DB     yt-dlp (child)   ffmpeg (child)
       (~/Music/…)   HTTPS: LRCLIB
```

**Regla de separación** (repetida del PLAN por ser la que más se viola en la práctica):
- **Audio y WebGL viven en React.** No en Rust. El AudioContext no se puede compartir cross-process.
- **Filesystem, procesos y red viven en Rust.** No en React. Evita CORS y permisos de Tauri más restrictivos.

---

## 2. Pipeline de audio (el flujo crítico)

El camino que debe funcionar *antes de cualquier otra cosa* en Fase 1:

```
Archivo en disco  ──►  Tauri expone vía asset protocol
                       (convertFileSrc)
                                │
                                ▼
                       <audio src="asset://..."> element
                                │
                                ▼
               MediaElementAudioSourceNode
                                │
                                ├─► GainNode (volume)
                                │        │
                                │        ├─► AnalyserNode ─► Butterchurn canvas
                                │        │
                                │        └─► AudioContext.destination
                                │
                                └─► (segundo GainNode para crossfade)
```

**Puntos que hay que validar temprano (Fase 0):**

1. Que `convertFileSrc()` funcione con archivos fuera del bundle (en `~/Music/...`).
2. Que el `<audio>` no sufra CORS al pasar por `MediaElementAudioSourceNode`.
3. Que `tauri.conf.json > app.security.assetProtocol` permita el scope del directorio de biblioteca.

> Si esto falla, fallback documentado: leer el archivo desde Rust, exponerlo como `Blob` vía `invoke`, crear `URL.createObjectURL`. Más costoso en memoria pero funciona garantizado.

### 2.1 Validación (2026-04-21) — riesgo Alto neutralizado

El pipeline completo fue probado con un smoke test (ver `src/App.tsx` y `src/App.css` del commit correspondiente). Tres hallazgos concretos que quedan como requisito permanente:

1. **`protocol-asset` es requisito doble.** Habilitar el asset protocol requiere tanto el flag en config:
   ```json
   "security": { "assetProtocol": { "enable": true, "scope": ["**"] } }
   ```
   como la feature en el crate `tauri`:
   ```toml
   tauri = { version = "2", features = ["protocol-asset"] }
   ```
   Uno sin el otro falla silenciosamente (el `<audio>` no carga).

2. **Scope durante desarrollo: `["**"]`.** Para Fase 1 hay que ajustarlo a `$HOME/Music/BrutalistPlayer/**` o al directorio configurado. No dejar `**` en producción — permite leer cualquier archivo al que el proceso tenga acceso.

3. **`<audio crossOrigin="anonymous">` es obligatorio.** Sin ese atributo, `createMediaElementSource()` marca el elemento como tainted y el `AnalyserNode` devuelve ceros (audio suena pero visualizer queda muerto). Síntoma típico: canvas plano mientras la música suena.

---

## 3. Contratos Tauri (invoke + events)

### 3.1 Convenciones

- Nombres de comando en **snake_case** (convención Rust, Tauri hace el bridge).
- Errores tipados con un enum `AppError` serializable a JSON (`thiserror` + `serde`).
- Eventos desde Rust → React en **kebab-case**: `download-progress`, `library-scan-finished`.
- Payloads tipados: compartir tipos entre Rust y TS vía `ts-rs` o generación manual en Fase 0.

### 3.2 Comandos (propuesta inicial — refinar al implementar)

**Library**
```rust
library_scan_directory(path: String) -> Result<ScanReport, AppError>
library_list_tracks(filter: Option<TrackFilter>) -> Result<Vec<Track>, AppError>
library_get_track(id: i64) -> Result<Track, AppError>
library_delete_track(id: i64, also_delete_file: bool) -> Result<(), AppError>
```

**Downloader**
```rust
downloader_enqueue(url: String) -> Result<DownloadId, AppError>
downloader_list() -> Result<Vec<Download>, AppError>
downloader_cancel(id: DownloadId) -> Result<(), AppError>
```
Emite eventos: `download-progress { id, progress, eta, speed }`, `download-finished { id, track_id }`, `download-failed { id, error }`.

**Playback** (mayormente cliente, pero algunos hooks al backend)
```rust
playback_report_play(track_id: i64) -> Result<(), AppError>  // para play_count / last_played_at
```

**Lyrics**
```rust
lyrics_fetch(track_id: i64) -> Result<Option<Lyrics>, AppError>  // cache-first, LRCLIB fallback
```

**Settings**
```rust
settings_get(key: String) -> Result<Option<String>, AppError>
settings_set(key: String, value: String) -> Result<(), AppError>
```

**System**
```rust
system_check_dependencies() -> Result<DependencyStatus, AppError>  // ¿yt-dlp y ffmpeg existen?
```

> TODO Fase 0: escribir los tipos en un módulo `src-tauri/src/contracts.rs` y generar `.d.ts` para el frontend.

---

## 4. Capa de datos

### 4.1 ORM / Driver SQLite

**Estado:** abierto. Ver [ADR-001](./DECISIONS.md#adr-001).
Candidatos: `sqlx` (favorito), `rusqlite` crudo, `diesel`.

### 4.2 Migraciones

Estrategia propuesta: `sqlx migrate` si se elige SQLx. Archivos en `src-tauri/migrations/` versionados por timestamp.

- Siempre forward-only en desarrollo. Sin `down` migrations hasta Fase 2.
- La app corre `migrate().run(&pool)` en el arranque, antes de cualquier comando.
- Schema inicial vive en [PLAN §3.1](./PLAN-reproductor-brutalist.md#31-esquema-sqlite-propuesta-inicial) — portar a `001_initial_schema.sql` en Fase 0.

### 4.3 Paths y convenciones

- DB ubicada en directorio de datos del usuario (vía `tauri::api::path::app_data_dir`), no al lado del binario.
- Archivos de biblioteca en ruta configurable (default `~/Music/BrutalistPlayer/`).
- Cover art extraído a `<data_dir>/cache/thumbnails/<track_id>.<ext>`.

---

## 5. Módulos Rust

```
src-tauri/src/
├── main.rs               # bootstrap: tauri::Builder, pool de DB, registro de comandos
├── contracts.rs          # tipos compartidos con el frontend (serde + ts-rs)
├── errors.rs             # AppError enum + From impls
├── db/
│   ├── mod.rs            # pool, migrate on startup
│   ├── tracks.rs         # CRUD tracks
│   ├── playlists.rs
│   ├── downloads.rs
│   └── settings.rs
├── audio/
│   ├── mod.rs
│   └── metadata.rs       # lofty-rs wrappers, cover extraction
├── downloader/
│   ├── mod.rs            # queue + worker
│   ├── ytdlp.rs          # spawn + flags + argv builder
│   └── progress.rs       # parser de stdout de yt-dlp
├── lyrics/
│   ├── mod.rs
│   └── lrclib.rs         # HTTP client a lrclib.net
└── commands/             # thin layer — solo wraps módulos anteriores
    ├── library.rs
    ├── downloader.rs
    ├── playback.rs
    ├── lyrics.rs
    └── system.rs
```

**Regla:** `commands/*` no contiene lógica — solo traduce args, llama al módulo correspondiente, mapea errores. Lógica y tests viven en los módulos.

---

## 6. Estado en React

### 6.1 Stores Zustand (propuesta)

```
stores/
├── playerStore.ts        # track actual, queue, play state, volumen, crossfade config
├── libraryStore.ts       # cache en memoria del listado, filtros, ordenamiento
├── downloadStore.ts      # mirror del estado de descargas (sincronizado via events)
└── uiStore.ts            # vista actual, modales, preset del visualizer
```

### 6.2 AudioContext singleton

Un solo `AudioContext` para toda la app, creado en un `AudioProvider` al root. Motivo: crear múltiples contexts desperdicia recursos y Butterchurn espera uno estable. Suspender cuando no haya playback > N segundos para ahorrar CPU.

### 6.3 Sincronización con eventos de Tauri

Wrapper `useTauriEvent(name, handler)` que se suscribe con `listen()` y hace cleanup en unmount. Los stores exponen métodos que los handlers llaman directamente — la UI no hace `listen` en componentes de hoja.

---

## 7. Pipeline de descarga — detalle

Estado de verdad: tabla `downloads` en SQLite. El store de React es mirror.

```
1. user paste URL
2. invoke('downloader_enqueue', { url })
3. Rust: INSERT downloads(status='queued', url)
4. Rust: worker toma el job
5. spawn yt-dlp con --newline --progress-template '%(progress._percent_str)s|%(progress.eta)s|%(progress.speed)s'
   (flags completos en PLAN §5.1)
6. parse stdout línea a línea → UPDATE downloads SET progress=... + emit 'download-progress'
7. al exit code 0:
   a. leer .info.json escrito por yt-dlp
   b. mover archivo a library/<artist>/<album>/
   c. lofty-rs: leer tags del archivo final → INSERT tracks
   d. extraer cover art → cache/thumbnails/
   e. UPDATE downloads SET status='completed', track_id=...
   f. emit 'download-finished'
   g. (paralelo, no-blocking) fetch LRCLIB → INSERT lyrics
8. al exit code != 0: capturar stderr, UPDATE status='failed', emit 'download-failed'
```

**TODOs abiertos:**
- Política de paralelismo: ¿1 descarga a la vez o N configurable? (ver ADR futuro).
- Reintentos automáticos en fallo de red vs. fallo de yt-dlp (404, edad, etc).
- Cancelación mid-download: necesita `Child::kill()` + cleanup del archivo parcial.

---

## 8. Seguridad y permisos Tauri

`tauri.conf.json` debe limitar el scope:

- **Filesystem plugin:** solo lectura/escritura en el directorio de biblioteca configurado + `app_data_dir`. Nunca `$HOME` completo.
- **Shell plugin:** solo ejecutables permitidos (`yt-dlp`, `ffmpeg`), no shell arbitrario.
- **HTTP plugin:** solo `https://lrclib.net/*` allowlist.
- **Asset protocol:** scope al directorio de biblioteca (no a todo el disco).

> TODO Fase 0: documentar el `tauri.conf.json` final con comentarios explicando cada permiso.

---

## 9. Áreas sin resolver (tracking)

| # | Tema | Bloquea | Tracking |
|---|------|---------|----------|
| 1 | ORM SQLite | Fase 0 | [ADR-001](./DECISIONS.md#adr-001) |
| 2 | Bundle vs detect binarios | Fase 1 cierre | [ADR-002](./DECISIONS.md#adr-002) |
| 3 | Paralelismo descargas | Fase 1 | Abrir ADR al implementar downloader |
| 4 | Generación de tipos Rust↔TS | Fase 0 | Decidir entre `ts-rs` / manual / `specta` |
| 5 | Testing E2E del downloader sin YouTube | Fase 1 | Buscar URL CC0 estable o servir fixture local |
| 6 | MPRIS en Linux | Fase 2 | No bloqueante |
