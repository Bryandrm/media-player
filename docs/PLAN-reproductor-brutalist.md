# Brutalist Music Player — Planning Document

> Reproductor de audio local con visualizador estilo MilkDrop, downloader integrado vía yt-dlp, construido en Tauri + Rust + React. Proyecto personal/portfolio.

---

## 1. Visión del proyecto

### 1.1 Problema que resuelve (personal)
- No tengo biblioteca de música local; todo mi consumo es vía streaming.
- Quiero un reproductor que se sienta *mío*, no un producto corporativo.
- Quiero construir una biblioteca offline de música que me guste.
- Quiero explorar Rust/Tauri como parte de mi skill tree (passive skills: Rust, audio APIs, WebGL visual).

### 1.2 Propuesta de valor como portfolio piece
- Demuestra **full-stack desktop**: Rust backend + React frontend, no solo web.
- Demuestra **integración de sistema**: child processes (yt-dlp, ffmpeg), filesystem, audio pipeline.
- Demuestra **diseño con intención**: brutalist UI diferencia de 99% de reproductores genéricos.
- Demuestra **manejo de Web Audio API y WebGL** (Butterchurn).
- Narrativa clara: "Un reproductor que me construí para mí, con el visualizador legendario de Winamp".

### 1.3 Scope explícito
**Está DENTRO del scope:**
- App desktop (Tauri) — Windows, Linux, macOS.
- Descarga de audio vía yt-dlp desde URLs (YouTube y otros sitios soportados por yt-dlp).
- Biblioteca local indexada (SQLite).
- Reproducción con controles estándar (play/pause, seek, volume, queue).
- Visualizador Butterchurn (port de MilkDrop) conectado al audio.
- Extracción automática de metadata + cover art.
- Crossfade entre canciones.
- Letras sincronizadas cuando estén disponibles (best-effort).
- UI brutalist.

**Está FUERA del scope (al menos por ahora):**
- Streaming desde servicios (Spotify/Apple Music APIs).
- Sincronización cloud / multi-device.
- Social features (compartir, scrobbling público).
- Distribución pública como producto.
- Mobile (Tauri mobile todavía es inmaduro, descartado por ahora).

### 1.4 Nota legal
- Uso estrictamente personal y como portfolio piece.
- No se publica como producto. No se distribuye binario públicamente (o si se distribuye, sin yt-dlp bundled; el usuario lo instala aparte).
- Disclaimer visible en el README del repo.

---

## 2. Stack técnico

### 2.1 Decisiones principales

| Capa | Tecnología | Por qué |
|---|---|---|
| Shell desktop | **Tauri 2.x** | Lightweight vs Electron (~10MB vs ~150MB), Rust backend nativo, buena DX. |
| Lenguaje backend | **Rust** | Oportunidad de passive skill, seguridad, performance para audio. |
| Frontend framework | **React 18 + TypeScript** | Dominio existente, encaja con Butterchurn (que es JS/WebGL). |
| Build tool frontend | **Vite** | Estándar Tauri, hot reload rápido. |
| Styling | **Tailwind CSS v4** + CSS vars | Brutalist se puede hacer bien con Tailwind usando utilities crudas. |
| Base de datos local | **SQLite** | Embebida, cero setup, portable. |
| ORM Rust | **SQLx 0.8** runtime-tokio | [ADR-001 Accepted](DECISIONS.md#adr-001) — sin macros checked para no requerir `DATABASE_URL` en build. |
| Audio playback | **HTML5 Audio + Web Audio API** | Necesario para que Butterchurn reciba el AnalyserNode. |
| Visualizador | **Butterchurn** (npm: `butterchurn`, `butterchurn-presets`) | Port WebGL de MilkDrop, soporta presets originales. |
| Downloader | **yt-dlp** (binario externo) | Invocado como child process desde Rust. |
| Procesamiento audio | **ffmpeg** (binario externo) | Conversión de formatos, normalización, extracción de metadata. |
| Extracción metadata | **lofty-rs** (crate de Rust) | Lee tags ID3/Vorbis/FLAC sin depender solo de ffmpeg. |
| Letras sincronizadas | **LRCLIB API** | Gratuito, sin auth, formato LRC estándar. |

### 2.2 Dependencias externas del sistema

El usuario (yo mismo) debe tener instalados:
- **yt-dlp** — en PATH o bundled según decisión de distribución.
- **ffmpeg** — requerido por yt-dlp para merge de streams y por nosotros para metadata.

**Decisión tomada:** detectar y mostrar banner ([ADR-002 Accepted](DECISIONS.md#adr-002)). El comando `check_dependencies` corre al boot vía `which`; si falta yt-dlp o ffmpeg, el frontend muestra un `DependencyBanner`. El resto del player funciona igual.

### 2.3 Arquitectura Tauri — separación de responsabilidades

**Rust (backend Tauri) hace:**
- Ejecutar yt-dlp y ffmpeg como child processes.
- Stream de progreso de descarga → emit a frontend vía events.
- Filesystem: gestionar directorio de biblioteca, archivos de audio, cover art.
- Base de datos SQLite: queries, migraciones, CRUD de tracks/playlists/config.
- Extracción de metadata con `lofty-rs`.
- HTTP requests a APIs externas (LRCLIB para letras) — mejor desde Rust para evitar CORS.

**React (frontend) hace:**
- Toda la UI.
- Reproducción de audio (Web Audio API necesita correr en el browser context).
- Visualizador Butterchurn (WebGL, debe correr en browser context).
- Estado de UI, navegación, formularios.
- Invoca comandos Rust vía `invoke()` y escucha events vía `listen()`.

**Flujo crítico: el audio**
```
Archivo MP3 en disco
  ↓ (Tauri expone ruta como `asset://` o convert_file_src)
<audio> element en React
  ↓ (MediaElementAudioSourceNode)
Web Audio API: AudioContext → AnalyserNode → Destination
                                    ↓
                            Butterchurn visualizer
                                    ↓
                              <canvas> WebGL
```

---

## 3. Arquitectura de datos

### 3.1 Esquema SQLite (propuesta inicial)

```sql
-- Tracks de la biblioteca
CREATE TABLE tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,        -- ruta absoluta en disco
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration_ms INTEGER NOT NULL,
    track_number INTEGER,
    year INTEGER,
    genre TEXT,
    cover_art_path TEXT,                   -- ruta a imagen extraída
    source_url TEXT,                       -- URL original si vino de yt-dlp
    source_type TEXT NOT NULL,             -- 'local' | 'downloaded'
    bitrate INTEGER,
    sample_rate INTEGER,
    format TEXT,                           -- 'mp3' | 'flac' | 'opus' | etc
    play_count INTEGER DEFAULT 0,
    last_played_at DATETIME,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Playlists
CREATE TABLE playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlist_tracks (
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

-- Letras cacheadas (LRCLIB responses)
CREATE TABLE lyrics (
    track_id INTEGER PRIMARY KEY,
    synced_lyrics TEXT,                    -- formato LRC
    plain_lyrics TEXT,
    source TEXT,                           -- 'lrclib' | 'embedded' | 'manual'
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);

-- Descargas en progreso o históricas
CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    status TEXT NOT NULL,                  -- 'queued' | 'downloading' | 'completed' | 'failed'
    progress REAL DEFAULT 0,               -- 0.0 a 1.0
    error_message TEXT,
    track_id INTEGER,                      -- se llena cuando termina
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
);

-- Config key/value simple
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Índices
CREATE INDEX idx_tracks_artist ON tracks(artist);
CREATE INDEX idx_tracks_album ON tracks(album);
CREATE INDEX idx_tracks_added ON tracks(added_at DESC);
```

### 3.2 Layout del filesystem

```
~/Music/BrutalistPlayer/          (configurable)
├── library/
│   ├── <artist>/
│   │   └── <album>/
│   │       ├── track1.mp3
│   │       └── cover.jpg
│   └── _uncategorized/           (cuando yt-dlp no puede inferir metadata)
├── cache/
│   ├── thumbnails/               (thumbnails de Butterchurn, previews, etc)
│   └── lyrics/                   (backup de LRC files)
└── player.db                     (SQLite)
```

### 3.3 Manejo de metadata desde yt-dlp

yt-dlp puede escribir metadata rica con flags:
```bash
yt-dlp \
  --extract-audio --audio-format mp3 --audio-quality 0 \
  --embed-metadata --embed-thumbnail \
  --write-info-json \
  -o "%(uploader)s/%(title)s.%(ext)s" \
  <URL>
```

Post-descarga, usar `lofty-rs` en Rust para leer los tags embebidos y poblar la tabla `tracks`. El `.info.json` que escribe yt-dlp tiene metadata adicional (descripción, fecha de upload, views) que podemos guardar como JSON en un campo extra si nos interesa más adelante.

---

## 4. Diseño visual: Brutalist

### 4.1 Principios de diseño

1. **El visualizador es el protagonista.** La UI debe salirse del camino cuando la música está sonando. Modo fullscreen del visualizador por defecto clickeando el canvas.
2. **Tipografía sobre decoración.** La información se jerarquiza con tamaño y peso tipográfico, no con colores ni iconos.
3. **Grid visible.** Las líneas del layout no se ocultan — se exhiben con bordes duros.
4. **Cero border-radius.** Todo cuadrado. Es una decisión de identidad.
5. **Contrastes duros.** Blanco puro, negro puro, un color acento. No gradients, no shadows blur.
6. **Espaciado con intención.** O mucho aire, o nada. Nada intermedio.
7. **Estados bruscos.** Hover/active on-off, sin transiciones suaves (o transiciones muy cortas, 50-80ms).

### 4.2 Design tokens (propuesta inicial, ajustar en implementación)

```css
:root {
  /* Colores */
  --bg: #FFFFFF;              /* blanco puro */
  --fg: #000000;              /* negro puro */
  --accent: #FF3B00;          /* naranja-rojo ácido (referencia: Winamp naranja) */
  --muted: #888888;           /* gris para metadata secundaria */
  --border: #000000;          /* bordes = foreground, no un gris lavado */

  /* Dark mode (invertido, no "soft dark") */
  --bg-dark: #000000;
  --fg-dark: #FFFFFF;

  /* Tipografía */
  --font-display: 'Space Grotesk', 'Inter', sans-serif;  /* o 'Archivo Black' para más agresivo */
  --font-mono: 'JetBrains Mono', 'IBM Plex Mono', monospace;

  /* Espaciado: escala de 8px pero con saltos grandes */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 32px;
  --space-xl: 64px;

  /* Bordes */
  --border-thin: 1px solid var(--border);
  --border-thick: 2px solid var(--border);
  --border-extra-thick: 4px solid var(--border);

  /* Sombras — SOLO sombras duras, nunca blur */
  --shadow-hard: 4px 4px 0 var(--border);
  --shadow-hard-lg: 8px 8px 0 var(--border);
}
```

### 4.3 Referencias visuales a revisar

- **Gumroad** (post-2021 rediseño) — brutalismo comercial.
- **Are.na** — minimal brutalist.
- **brutalistwebsites.com** — galería curada.
- **Figma Config** (sitios de evento) — brutalismo playful.
- **Bloomberg Businessweek web** — brutalismo editorial.

### 4.4 Layouts principales

**Vista 1 — Biblioteca (default al abrir la app):**
```
┌─────────────────────────────────────────────────────────┐
│ BRUTALIST // PLAYER                         [_][□][X]   │  ← titlebar custom
├─────────────────────────────────────────────────────────┤
│ LIBRARY │ DOWNLOADS │ VISUALIZER │ SETTINGS             │  ← nav sin iconos, solo texto mayúscula
├─────────┬───────────────────────────────────────────────┤
│         │ SEARCH: [______________________]              │
│ ARTISTS │─────────────────────────────────────────────  │
│ ALBUMS  │ # │ TITLE           │ ARTIST     │ DURATION   │
│ TRACKS  │ 01│ Black Hole Sun  │ Soundgard. │ 05:18      │
│ PLAYLIS │ 02│ Come As You Are │ Nirvana    │ 03:39      │
│         │ ...                                           │
├─────────┴───────────────────────────────────────────────┤
│ [NOW PLAYING] Come As You Are — Nirvana    ▶ ━━●━━━━    │  ← player bar fija
└─────────────────────────────────────────────────────────┘
```

**Vista 2 — Visualizer fullscreen:**
```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│                                                         │
│          [CANVAS WEBGL — BUTTERCHURN FULLSCREEN]        │
│                                                         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ NIRVANA — COME AS YOU ARE                        03:39  │  ← overlay minimal
│ ━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  01:42  │
└─────────────────────────────────────────────────────────┘
     (la overlay desaparece tras 3s sin mover el mouse)
```

**Vista 3 — Downloads:**
```
┌─────────────────────────────────────────────────────────┐
│ DOWNLOADS                                               │
├─────────────────────────────────────────────────────────┤
│ PASTE URL: [___________________________________]  [GO]  │
├─────────────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░  72%  Nirvana - Come As You Are   │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100%  ✓ Soundgarden - Black Hole  │
│ ░░░░░░░░░░░░░░░░░░░░   0%  QUEUED: Pearl Jam - Alive   │
└─────────────────────────────────────────────────────────┘
```

---

## 5. Features detalladas

### 5.1 Downloader (yt-dlp integration)

**Flujo:**
1. Usuario pega URL en input.
2. Frontend → `invoke('download_track', { url })` → Rust.
3. Rust inserta row en `downloads` tabla con status `queued`.
4. Rust spawnea proceso yt-dlp con flags:
   - `--newline` + `--progress-template` para progress parseable.
   - `--print-json` después para metadata.
   - Output a `library/_pending/<uuid>.%(ext)s`.
5. Rust parsea stdout línea a línea → emit `download-progress` event con `{ download_id, progress, eta }`.
6. Al terminar: mover archivo a `library/<artist>/<album>/`, correr `lofty-rs` para metadata, insertar en `tracks`, actualizar `downloads.status = completed`.
7. Si falla: capturar stderr, status `failed`, mostrar error legible.
8. En paralelo, fetch de letras a LRCLIB (best-effort, no bloquea).

**Consideraciones:**
- Queue de descargas serializado (una a la vez) o limitado a 2-3 paralelas (configurable).
- Detección temprana de `yt-dlp not found` → guiar al usuario.
- Detección de URL inválida antes de invocar el proceso.
- Validar tamaño de descarga pre-ejecución con `--dump-json` sin descargar, para advertir si es gigante.

### 5.2 Reproductor

**Controles:**
- Play / Pause / Next / Previous.
- Seek bar interactiva.
- Volume slider (con mute toggle).
- Shuffle, Repeat (off / repeat-one / repeat-all).
- Queue visible (próximas N canciones).
- Keyboard shortcuts: Space (play/pause), ←/→ (seek 5s), ↑/↓ (volume), N (next), P (prev).
- Media keys del sistema (vía `tauri-plugin-global-shortcut` o MPRIS en Linux).

**Crossfade:**
- Configurable: off / 3s / 6s / 12s.
- Implementación: al llegar a `(duration - crossfade)`, empezar a cargar el siguiente track en un segundo `<audio>` element + `GainNode`, fade-out del actual con otro `GainNode`, fade-in del nuevo, al terminar swap las refs.

### 5.3 Visualizador (Butterchurn)

- Canvas WebGL ocupa todo el área principal cuando se activa vista Visualizer.
- Presets de `butterchurn-presets` (viene con ~100+, hay packs adicionales con miles).
- Controles overlay:
  - Next preset / Previous preset.
  - Random preset.
  - Lock preset (no auto-switch).
  - Preset list searchable.
- Auto-switch preset cada N segundos (configurable, default 30s) con blend suave (Butterchurn soporta transition).
- Fullscreen toggle (F11 o doble click en canvas).

### 5.4 Letras sincronizadas

- Al entrar a un track, si no hay lyrics en DB, fetch a LRCLIB:
  - `GET https://lrclib.net/api/get?artist_name=...&track_name=...&duration=...`
- LRCLIB devuelve LRC sincronizado (con timestamps `[mm:ss.xx]`) cuando está disponible.
- Parsear LRC → array de `{ time_ms, text }`.
- En la UI, panel lateral que muestra línea actual destacada en acento, líneas anteriores/siguientes en foreground tenue.
- Click en una línea → seek a ese timestamp.
- Si no hay sincronizadas pero sí plain → mostrar plain sin highlight.
- Si no hay nada → panel muestra "NO LYRICS AVAILABLE" en mono grande.

### 5.5 Extracción automática de metadata + cover art

- Al agregar archivos locales (no descargados): scanner que recorre un directorio, lee tags con `lofty-rs`, inserta en DB.
- Para cada track: si tiene cover art embebido, extraer a `cache/thumbnails/<track_id>.jpg`.
- Si no tiene cover art embebido, buscar `cover.jpg`/`folder.jpg` en el mismo directorio.
- Si no hay nada, placeholder brutalist (cuadrado negro con tipografía del álbum/artista).
- Feature opcional futura: fallback a MusicBrainz API para completar metadata faltante.

---

## 6. Roadmap por fases

### Fase 0 — Setup ✓
- [x] Inicializar proyecto Tauri 2 con React + TS + Vite + Tailwind v4.
- [x] Setup de Rust: estructura de módulos (`db`, `audio`, `downloader`, `lyrics`, `commands`, `errors`).
- [x] Migración inicial SQLite con schema base ([§3.1](#31-esquema-sqlite-propuesta-inicial)).
- [x] Repo Git con README + disclaimer legal.
- [x] Design tokens brutalist en `src/styles/tokens.css`.
- [ ] ESLint + Prettier — pendiente, no bloquea.
- [x] Smoke test del pipeline de audio (`convertFileSrc` + Web Audio + Butterchurn tap).

### Fase 1 — MVP funcional ✓ (cerrada 2026-05-02)
- [x] **Reproductor básico**: play/pause/seek, volumen vía `GainNode`, mute, prev/next, shuffle con historial (cap 64).
- [x] **Biblioteca**: importar directorio, scan recursivo con `lofty-rs`, idempotente vía `UNIQUE(file_path)` + `ON CONFLICT DO NOTHING`, search por tokens (AND).
- [x] **Downloader**: paste URL → yt-dlp con progreso en tiempo real + fase CONVERTING, idempotente (`--no-overwrites`).
- [x] **Visualizador**: Butterchurn conectado al `MediaElementAudioSourceNode`, vista side-by-side con la library (split arrastrable + persistido), auto-cycle de presets random cada 5–10s, fullscreen vía `F`. **Persistent mount** (no re-creación al cambiar tabs) ([ADR-014](DECISIONS.md#adr-014)).
- [x] **Toggle visualizer ↔ lyrics** dentro del split, persistido en `playerPaneMode`.
- [x] **Metadata + cover art**: extracción de embedded picture (`lofty`) con fallback a `cover.jpg`/`folder.jpg` siblings + cleanup heurístico post-yt-dlp ([ADR-016](DECISIONS.md#adr-016)).
- [x] **UI brutalist**: 3 layouts + design tokens + `<Button variant>` + `usePressFlash` para tap-to-click.
- [x] **Keyboard shortcuts**: Space, ←/→, ↑/↓, M, N, P, S, V, F.
- [x] **Persistencia** (Zustand `persist`): volume, muted, shuffle, crossfadeMs, presetIndex, visualizerSplit, autoCycle, playerPaneMode.
- [x] **Persistencia último track + posición** (localStorage, restore sin auto-play).
- [x] **Crossfade** (off/3/6/12s) — dual audio elements + channelGain ramps ([ADR-012](DECISIONS.md#adr-012)).
- [x] **Fade in/out al play/pause** ([ADR-013](DECISIONS.md#adr-013)).
- [x] **Media keys** (F7/F8/F9 + AirPods + lock screen) — MediaSession API. Testeado macOS, pendiente Windows.
- [x] **Letras** (LRCLIB + USLT embebido) con panel sincronizado, click-to-seek, offset adjustable. Cleanup heurístico de metadata + LRCLIB search fallback. Indicador `L` en library. Auto-fetch on track change ([ADR-015](DECISIONS.md#adr-015), [ADR-017](DECISIONS.md#adr-017)).

### Fase 2 — Refinamiento
- [ ] Playlists (crear, editar, reordenar, eliminar).
- [ ] Equalizer básico (BiquadFilterNode chain — 10 bandas).
- [ ] Smart playlists / auto-queue basado en género, año, o recientemente agregado.
- [ ] Drag & drop de archivos para agregar a biblioteca.
- [ ] MPRIS en Linux para integración con panel del sistema.
- [ ] Exportar playlists a M3U.
- [ ] **Lyrics Fase 2**: Genius (último recurso plain), manual paste, refetch botón, drift correction (`speedRatio`), tabla `lyrics_search_attempts` con TTL — ver [LYRICS.md](LYRICS.md).
- [ ] History persistente de descargas (chunk 2 — ADR-011).
- [x] ~~Búsqueda rápida en biblioteca~~ — implementada en Fase 1 (token AND match).
- [x] ~~Media keys integration~~ — implementada en Fase 1 (MediaSession API).

### Fase 3 — Nice to haves / exploratorio
- [ ] **AcoustID + Chromaprint** — identificación canónica del audio vía fingerprinting → MBID de MusicBrainz → match exacto contra LRCLIB. Elimina los problemas de metadata sucia + drift por versiones distintas que combatimos con heurísticas en Fase 1. Sub-sistema con su propio doc (`IDENTIFICATION.md` futuro). Ver [LYRICS.md Fase 3](LYRICS.md).
- [ ] Grabación del visualizador como video (WebCodecs API).
- [ ] Modo DJ: mezcla manual entre dos decks (BPM detection, sync).
- [ ] Scrobbling local (historial propio, no last.fm).
- [ ] Tema adicional: "Terminal Mode" (todo mono, verde sobre negro).
- [ ] Integración con controladores MIDI.
- [ ] Modo "radio" aleatorio por mood/género.
- [ ] Plugin system para nuevos visualizadores (más allá de Butterchurn).

---

## 7. Riesgos y decisiones abiertas

### 7.1 Riesgos técnicos — estado

| Riesgo | Impacto | Estado |
|---|---|---|
| Butterchurn con presets pesados baja FPS | Medio | No observado en práctica con los ~100 presets base. Si aparece, degradar `pixelRatio`/`textureRatio` (ya parametrizado en `createVisualizer`). |
| Tauri v2 tiene menos recursos/docs que Electron | Bajo-Medio | Mitigado — Tauri 2 estable, no nos topamos con bloqueos serios. |
| Detección de metadata de yt-dlp inconsistente | Medio | **Mitigado**: post-descarga, `lofty` re-lee tags del archivo final como fuente de verdad. yt-dlp embebe el thumbnail con `--embed-thumbnail`; el extractor de cover art lo recoge igual que con archivos locales. |
| `<audio>` + Web Audio + archivos locales (CORS) | Alto | **Mitigado**: `convertFileSrc()` + `<audio crossOrigin="anonymous">` + `protocol-asset` feature en `Cargo.toml`. Documentado en ARCHITECTURE §2. |
| Aprender Rust mientras se construye | Medio | Mitigado iterando: queries directas con `sqlx::query_as::<_, T>`, sin macros; funciones libres en vez de traits; un solo `AppError` enum. |
| Tailwind v4: utilities de color en orden alfabético rompen overrides | Alto (descubierto durante Fase 1) | **Mitigado**: `<Button variant>` switchea el set entero, no concatena utilidades. Documentado en CLAUDE.md gotcha #1. |
| `audio.volume` bypassed cuando hay `MediaElementAudioSourceNode` | Alto (descubierto durante Fase 1) | **Mitigado**: volumen via `GainNode`. Ver [ADR-008](DECISIONS.md#adr-008). |
| `:active` CSS no se ve con tap-to-click de macOS | Medio (UX) | **Mitigado**: `usePressFlash` mantiene flash 150ms via JS. [ADR-009](DECISIONS.md#adr-009). |
| Butterchurn 2.6.7 no aplica `opts.width`/`height` al canvas | Alto (descubierto durante Fase 1) | **Mitigado**: `setRendererSize(w, h)` explícito + ResizeObserver sobre el contenedor padre. ARCHITECTURE §8. |
| yt-dlp progress invisible (Python block-buffering + stderr) | Alto (descubierto durante Fase 1) | **Mitigado**: `PYTHONUNBUFFERED=1` + fan-in de stdout+stderr a un mpsc + parser del formato default. ARCHITECTURE §7. |

### 7.2 Decisiones tomadas durante la implementación

Resueltas en [DECISIONS.md](DECISIONS.md):

- **SQLx vs alternativas** → SQLx 0.8 sin macros checked ([ADR-001 Accepted](DECISIONS.md#adr-001)).
- **Bundlear yt-dlp/ffmpeg** → detectar y banner ([ADR-002 Accepted](DECISIONS.md#adr-002)).
- **Acento color** → naranja `#FF3B00` ([ADR-004 Accepted](DECISIONS.md#adr-004)).
- **Generación de tipos Rust↔TS** → manual mientras la superficie sea chica ([ADR-007 Accepted](DECISIONS.md#adr-007)).
- **Singleton de audio** → fuera del JSX, en module scope ([ADR-008 Accepted](DECISIONS.md#adr-008)).
- **Press feedback** → JS hook (no `:active` CSS) ([ADR-009 Accepted](DECISIONS.md#adr-009)).
- **Idempotencia de scan/download** → `UNIQUE(file_path)` + `ON CONFLICT DO NOTHING` + `--no-overwrites` ([ADR-010 Accepted](DECISIONS.md#adr-010)).
- **History de descargas** → memoria-only por ahora ([ADR-011 Accepted](DECISIONS.md#adr-011)).

Pendientes:
- **Font definitiva** ([ADR-003 Proposed](DECISIONS.md#adr-003)) — la app actual usa system font; cargar webfonts en polish visual.
- **Windows titlebar** ([ADR-005 Proposed](DECISIONS.md#adr-005)) — titlebar nativa por ahora; custom cuando entremos en polish y querramos Windows.

### 7.3 Preguntas pendientes que Claude Code debería abordar

1. ¿Cómo manejar la primera instalación si yt-dlp/ffmpeg no están? Wizard visual paso a paso.
2. ¿Qué estrategia para migraciones SQLite? (probablemente `sqlx migrate` o `refinery`).
3. ¿Cómo estructurar el estado global en React? (Zustand es liviano y encaja).
4. ¿Cómo hacer el AudioContext singleton robusto entre vistas? (context provider al root).
5. ¿Cómo testear el proceso de descarga end-to-end sin depender de YouTube? (URLs de test en dominio propio o video de Creative Commons conocido).

---

## 8. Estructura inicial del repo propuesta

```
brutalist-player/
├── src/                           # Frontend (React)
│   ├── components/
│   │   ├── player/               # PlayerBar, Controls, SeekBar, VolumeSlider
│   │   ├── library/              # LibraryTable, ArtistList, AlbumGrid
│   │   ├── downloader/           # DownloadForm, DownloadQueue, ProgressBar
│   │   ├── visualizer/           # VisualizerCanvas, PresetSelector
│   │   └── ui/                   # primitivos brutalist (Button, Input, Card)
│   ├── hooks/                    # useAudioContext, usePlayerState, useLibrary
│   ├── stores/                   # Zustand stores
│   ├── services/                 # wrappers sobre invoke() de Tauri
│   ├── styles/
│   │   └── tokens.css            # design tokens brutalist
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/                     # Backend (Rust)
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/             # comandos expuestos a JS
│   │   │   ├── library.rs
│   │   │   ├── downloader.rs
│   │   │   ├── playback.rs
│   │   │   └── lyrics.rs
│   │   ├── db/                   # SQLite + migraciones
│   │   ├── audio/                # metadata extraction (lofty)
│   │   ├── downloader/           # yt-dlp wrapper
│   │   └── errors.rs
│   ├── migrations/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── public/
├── docs/
│   ├── PLAN.md                   # este documento
│   ├── DESIGN.md                 # decisiones visuales ampliadas
│   └── ARCHITECTURE.md           # deep dive técnico (se escribe durante Fase 1)
├── .gitignore
├── README.md
├── package.json
└── tsconfig.json
```

---

## 9. Recursos y referencias

### Librerías clave
- **Tauri 2**: https://v2.tauri.app/
- **Butterchurn**: https://github.com/jberg/butterchurn
- **Butterchurn Presets**: https://github.com/jberg/butterchurn-presets
- **Webamp** (referencia de integración): https://github.com/captbaritone/webamp
- **yt-dlp**: https://github.com/yt-dlp/yt-dlp
- **lofty-rs**: https://github.com/Serial-ATA/lofty-rs
- **LRCLIB**: https://lrclib.net/docs

### Inspiración visual
- Brutalist Websites: https://brutalistwebsites.com/
- Are.na: https://www.are.na/
- Gumroad: https://gumroad.com/

### Docs relevantes
- Web Audio API (AnalyserNode): https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode
- Tauri v2 invoke/events: https://v2.tauri.app/develop/calling-rust/
- Tauri v2 asset protocol: https://v2.tauri.app/reference/config/#assetprotocolconfig

---

## 10. Criterios de "done" para el MVP (Fase 1) ✓

| # | Criterio | Estado |
|---|---|---|
| 1 | Abrir la app y ver biblioteca vacía sin errores. | ✓ |
| 2 | Pegar URL de YouTube → descarga con progreso en tiempo real. | ✓ |
| 3 | Canción descargada aparece con metadata + cover art. | ✓ |
| 4 | Click en canción → reproduce con controles funcionales. | ✓ |
| 5 | Vista Visualizer con Butterchurn reaccionando a la música. | ✓ |
| 6 | Crossfade al pasar de un track al siguiente. | ✓ |
| 7 | Letras sincronizadas vía LRCLIB cuando estén disponibles. | ✓ |
| 8 | UI brutalist consistente, no template genérico. | ✓ |
| 9 | Funciona al menos en macOS (daily del autor). Linux/Windows bonus. | ✓ macOS validado, Windows pendiente test |
| 10 | Repo con README explicando setup + disclaimer legal. | ✓ |

**Fase 1 cerrada al 100% el 2026-05-02.** Próximo: AcoustID + Chromaprint (Fase 3) para identificación canónica del audio.

---

*Documento vivo. Se actualiza a medida que avanza la implementación.*
*Próximo paso: pasar este documento por Claude Code y empezar la Fase 0.*
