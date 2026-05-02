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

---

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView).
- **Frontend:** React 19 + TypeScript + Vite + Tailwind v4.
- **Estado React:** Zustand 5 con `persist` middleware. Stores por dominio:
  `playerStore`, `libraryStore`, `uiStore`, `downloadStore`.
- **Backend:** Rust. SQLite vía `sqlx` 0.8 (runtime tokio).
- **Audio:** singleton `<audio>` (no en JSX, `new Audio()` en `audio/element.ts`)
  → `MediaElementAudioSourceNode` → `GainNode` → destination. Butterchurn
  tapea el source. **El volumen real se controla con el `GainNode`**, no
  con `audio.volume` (ver Gotchas).
- **Visualizer:** `butterchurn` 2.6 + `butterchurn-presets` 2.4 (~100 presets base).
- **Externos:** `yt-dlp` y `ffmpeg` como child processes (deps del sistema,
  no bundled). `lofty-rs` para tags + cover art. `LRCLIB` API para letras
  (pendiente).

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
│   ├── element.ts          singleton <audio>
│   └── context.ts          singleton AudioContext + source + masterGain
├── components/
│   ├── ui/                 Button, Tabs, MarqueeText (genéricos)
│   ├── library/            LibraryTable, LibrarySearchBar, LibraryToolbar
│   ├── player/             PlayerBar, Controls, SeekBar, VolumeSlider, CoverArt
│   ├── visualizer/         VisualizerView, VisualizerCanvas, PresetSelector
│   └── downloads/          DownloadsView, DownloadForm, DownloadQueue, ...
├── hooks/                  useAudioPlayer, useKeyboardShortcuts, usePressFlash, …
├── stores/                 playerStore, libraryStore, uiStore, downloadStore
├── lib/                    format.ts, search.ts (puros, sin React)
├── styles/tokens.css       design tokens + range/marquee/progress CSS
└── types.ts                Track, Download, DependencyStatus, etc.

src-tauri/src/
├── lib.rs                  Tauri builder + invoke_handler
├── commands/               thin wrappers — library, downloader, system
├── db/                     sqlx queries por tabla (tracks, …)
├── audio/                  lofty: extract_metadata + extract_cover_art
├── downloader/             yt-dlp child process + stdout/stderr fan-in
├── contracts.rs            tipos serializados a TS
└── errors.rs               AppError + AppResult
```

**Estado actual:**
- Fase 0 (setup) ✓
- Fase 1 (MVP) ~90%: player + library + downloads + visualizer + cover art +
  search ✓. Pendientes: letras (LRCLIB), crossfade, persistencia de
  último track, polish.

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

---

## Disclaimer legal (recordatorio)

El uso de yt-dlp puede violar ToS de servicios como YouTube. Este proyecto es de uso personal. No distribuir binarios al público. Incluir disclaimer en el README cuando se escriba.
