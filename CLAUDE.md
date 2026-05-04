# CLAUDE.md

> Contexto operativo para Claude Code trabajando en este repo.
> Mantener corto. Las decisiones y los detalles técnicos viven en [docs/](./docs/).

---

## Qué es este proyecto

Reproductor de música local desktop con visualizador estilo MilkDrop (Butterchurn) y downloader integrado vía yt-dlp. Proyecto **personal + portfolio piece**, no producto comercial. Construido en Tauri 2 + Rust + React.

Documentos fuente de verdad:
- [docs/PLAN-reproductor-brutalist.md](./docs/PLAN-reproductor-brutalist.md) — visión, scope, roadmap.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — arquitectura técnica, contratos Tauri, pipeline de audio.
- [docs/DECISIONS.md](./docs/DECISIONS.md) — ADRs. Leer antes de proponer cambios técnicos importantes.
- [docs/LYRICS.md](./docs/LYRICS.md) — sub-sistema de letras (LRCLIB + USLT, drift correction, etc.).
- [docs/IDENTIFICATION.md](./docs/IDENTIFICATION.md) — sub-sistema de identificación (AcoustID + Chromaprint).
- [docs/KARAOKE.md](./docs/KARAOKE.md) — sub-sistema de karaoke (forced alignment + per-word timing + future fullscreen + vocal removal). No iniciado, doc-only.

---

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView).
- **Frontend:** React 19 + TypeScript + Vite + Tailwind v4.
- **Estado React:** Zustand 5 con `persist` middleware. Stores por dominio:
  `playerStore`, `libraryStore`, `uiStore`, `downloadStore`.
- **Backend:** Rust. SQLite vía `sqlx` 0.8 (runtime tokio).
- **Audio:** **dos** singletons `<audio>` (channel A y B, fuera de JSX, en
  `audio/element.ts`) para soportar crossfade. Pipeline:
  `audioA/B → sourceA/B → channelGainA/B → preMasterGain → masterGain → playPauseGain → destination`.
  Butterchurn tapea `preMasterGain` (mezcla de los dos canales). **El volumen
  real se controla con `masterGain`**, no con `audio.volume` (ver Gotcha #2).
  Fade in/out al play/pause via `playPauseGain` con `cancelAndHoldAtTime`.
- **Visualizer:** `butterchurn` 2.6 + `butterchurn-presets` 2.4 (~100 presets base).
  Mount **persistente** post-primer-visit (ver Gotcha #8).
- **Lyrics:** `lofty` (USLT embebido) + `LRCLIB` API. Parser LRC en frontend.
  Auto-fetch on track change para poblar el indicador `L` en la library.
- **Externos:** `yt-dlp` y `ffmpeg` como child processes (deps del sistema,
  no bundled). `lofty-rs` para tags + cover art + USLT. `reqwest` para HTTP
  con `rustls-tls` (sin OpenSSL).

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
│   ├── ui/                 Button, Tabs, MarqueeText (genéricos)
│   ├── library/            LibraryTable (con indicador L), LibrarySearchBar,
│   │                       LibraryToolbar (SCAN + CLEAN METADATA)
│   ├── player/             PlayerBar, Controls (con XFADE button), SeekBar,
│   │                       VolumeSlider, CoverArt
│   ├── visualizer/         VisualizerView (con toggle vis/lyrics + persistent
│   │                       mount), VisualizerCanvas, PresetSelector
│   ├── lyrics/             LyricsView (panel sincronizado)
│   └── downloads/          DownloadsView, DownloadForm, DownloadQueue, …
├── hooks/                  useAudioPlayer, useKeyboardShortcuts, usePressFlash,
│                           usePlaybackPersist, useMediaSession, useLyricsSync,
│                           useSyncedLyrics (rAF active-line tracking),
│                           useAutoCyclePresets, useDownloadEvents
├── stores/                 playerStore, libraryStore, uiStore, downloadStore,
│                           lyricsStore, identificationStore
├── hooks/                  useAudioPlayer, useDownloadEvents,
│                           useIdentificationEvents, …
├── lib/                    format.ts, search.ts, lrcParser.ts (puros)
├── styles/tokens.css       design tokens + range/marquee/progress CSS
└── types.ts                Track (con lyricsStatus + identificationStatus),
                            Download, Lyrics, IdentificationResult, …

src-tauri/src/
├── lib.rs                  Tauri builder + invoke_handler + reqwest::Client +
│                           BulkIdentifyState manage()
├── commands/               thin wrappers — library, downloader, system,
│                           lyrics, identification
├── db/                     sqlx queries por tabla (tracks, lyrics, settings)
├── audio/                  lofty: extract_metadata + extract_cover_art
│   └── cleanup.rs          heurísticas para limpiar metadata yt-dlp
│                           (Topic/VEVO/Official Video/Artist - Title prefix)
├── downloader/             yt-dlp child process + stdout/stderr fan-in
├── lyrics/                 fetch_lyrics cascade: embedded.rs (USLT) +
│                           lrclib.rs (get + search fallback)
├── identification/         fpcalc.rs (Chromaprint binary wrapper) +
│                           acoustid.rs (HTTP client) + mod.rs (cascade)
├── contracts.rs            tipos serializados a TS
└── errors.rs               AppError + AppResult
```

**Estado actual:**
- Fase 0 (setup) ✓
- Fase 1 (MVP) **100%** ✓ — los 10 criterios "done" cerrados.
  - Letras (LRCLIB + USLT): ✓ con cleanup heurístico de metadata + search
    fallback + indicador `L` en library + auto-fetch on track change.
  - Crossfade: ✓ (off/3/6/12s, dual audio elements + channelGain ramps).
  - Persistencia último track + posición: ✓ (localStorage, restore sin
    auto-play).
  - Media keys: ✓ (MediaSession API — testeado en macOS, pendiente Windows).
- **Identification AcoustID Fase 1 + Fase 2** ✓ (2026-05-02) — single-track
  IDENTIFY + bulk IDENTIFY ALL con throttle 2.85 rps. Pisa metadata sucia
  con canónica de MusicBrainz, feedea al cascade text-based de LRCLIB.
  **`[ID]` ⊥ `[L]`**: identificación y disponibilidad de letras son
  independientes (DJ sets + indie nicho son `[ID]` + `—`, esperado).
  Ver [docs/IDENTIFICATION.md](./docs/IDENTIFICATION.md).
- Próximo: **Lyrics Fase 2.a** — drift correction (`speedRatio`) + SET
  OFFSET HERE para YouTube intros grandes.

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
en macOS). La app verifica al boot vía `check_dependencies` y muestra
un banner si faltan.

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

---

## Disclaimer legal (recordatorio)

El uso de yt-dlp puede violar ToS de servicios como YouTube. Este proyecto es de uso personal. No distribuir binarios al público. Incluir disclaimer en el README cuando se escriba.
