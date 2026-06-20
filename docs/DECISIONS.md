# Decisions — Brutalist Music Player

> Registro vivo de decisiones técnicas y de producto. Formato ADR ligero.
> **Estados posibles:** `Proposed` · `Accepted` · `Rejected` · `Superseded by ADR-NNN`.
> Una decisión cambia de estado, no se borra. Si se revierte, se marca `Superseded` y se añade una nueva.

---

## Índice

| ID | Título | Estado |
|----|--------|--------|
| ADR-000 | Tauri 2 como shell desktop | Accepted |
| ADR-001 | ORM / driver para SQLite | Accepted |
| ADR-002 | Bundle vs detección de yt-dlp y ffmpeg | Accepted |
| ADR-003 | Font family definitiva | Proposed |
| ADR-004 | Color acento | Accepted |
| ADR-005 | Titlebar nativa vs custom | Proposed |
| ADR-006 | Zustand como store global de React | Accepted |
| ADR-007 | Generación de tipos Rust ↔ TypeScript | Accepted (manual) |
| ADR-008 | Singleton de audio fuera del JSX | Accepted |
| ADR-009 | Press feedback via JS (no `:active` CSS) | Accepted |
| ADR-010 | Idempotencia de scan/download via UNIQUE + ON CONFLICT | Accepted |
| ADR-011 | History de descargas en memoria (chunk 1) | Accepted |
| ADR-012 | Crossfade via dual `<audio>` + channelGain ramps | Accepted |
| ADR-013 | Fade in/out al play/pause via `playPauseGain` dedicado | Accepted |
| ADR-014 | Persistent visualizer mount + visibility-gated rAF | Accepted |
| ADR-015 | Lyrics Fase 1 sin trait abstraction | Accepted |
| ADR-016 | Cleanup heurístico de metadata post-yt-dlp | Accepted |
| ADR-017 | Auto-fetch de lyrics on track change para indicador library | Accepted |
| ADR-018 | WhisperX (no aeneas) para forced alignment | Accepted |
| ADR-019 | Forced alignment con bounds tight del LRC | Accepted |
| ADR-020 | Backup `original_synced_lyrics` para re-aligns idempotentes | Accepted |
| ADR-021 | A2 LRC extendido con trailing end marker | Accepted |
| ADR-022 | Cursor de lyrics usa `wordTimestampsMs[0]` con alignment | Accepted |
| ADR-023 | EQ insertado post-tap del visualizer | Accepted |
| ADR-024 | Descarga de listas (FULL PLAYLIST) + cookies del navegador | Accepted |
| ADR-025 | Dedup de descargas: por path + fingerprint exacto | Accepted |
| ADR-026 | Switch gapless en selección manual de track | Accepted |
| ADR-027 | Reorder de playlist via pointer events (no HTML5 DnD) | Accepted |
| ADR-028 | Cookies por archivo + éxito parcial en descarga de playlists | Accepted |
| ADR-029 | Musixmatch como tercer provider, LRCLIB-first | Superseded (ADR-030) |
| ADR-030 | NetEase como tercer provider (free, keyless) | Accepted |
| ADR-031 | History de descargas persistente + reconcile de huérfanas | Accepted |
| ADR-032 | Cancelar descarga conservando parciales | Accepted |
| ADR-033 | Import por drag & drop via drag-drop nativo de Tauri | Accepted |
| ADR-034 | Smart playlists: motor multi-regla con query builder dinámico | Accepted |
| ADR-035 | Identify extendido: MB metadata (genre + year + album) + Cover Art Archive | Accepted |
| ADR-036 | Smart playlists: picker cascadante + operador `in`/`not_in` | Accepted |
| ADR-037 | Pixi como gestor de dependencias ML/sistema | Proposed |

---

## ADR-000 — Tauri 2 como shell desktop

**Fecha:** 2026-04-20 · **Estado:** Accepted

### Contexto
Necesitamos un shell desktop que corra React + WebGL (Butterchurn) y que permita ejecutar procesos hijo (yt-dlp, ffmpeg) y acceder al filesystem.

### Opciones consideradas
1. **Electron** — maduro, mucha doc, pesado (~150MB), runtime Chromium bundled.
2. **Tauri 2** — ~10MB, backend Rust nativo, WebView del OS, DX en crecimiento.
3. **Wails** (Go backend) — descartado: menos relevante para skill tree del autor.

### Decisión
Tauri 2. El peso del binario y el hecho de que forzamos aprendizaje de Rust (objetivo personal del autor) inclinan la balanza.

### Consecuencias
- Binario pequeño, arranque rápido.
- Diferencias de renderizado entre WebView de cada OS (WebKit macOS, WebView2 Windows, WebKitGTK Linux) — validar visualizer en los tres si llega a haber distribución.
- Menos recursos de comunidad que Electron ante problemas raros.

---

## ADR-001 — ORM / driver para SQLite

**Fecha:** 2026-04-20 · **Aceptado:** 2026-04-21 · **Estado:** Accepted

### Contexto
Necesitamos acceder a SQLite desde Rust con migraciones y queries tipadas.

### Opciones
1. **`sqlx`** — async, macros check queries at compile-time, incluye `sqlx migrate`. Curva mayor.
2. **`rusqlite`** — sync, crudo, simplísimo, sin migraciones built-in (combinar con `refinery`).
3. **`diesel`** — schema-first, DSL, más opinionado, sync (o async con `diesel-async`).

### Decisión
**`sqlx` 0.8** con features `runtime-tokio, sqlite, migrate, macros`. Migraciones forward-only en `src-tauri/migrations/`, ejecutadas al boot antes de registrar comandos.

**Pero sin compile-time check de queries** (`query_as!`/`query!`). Usamos `sqlx::query_as::<_, T>("...")` runtime-checked + `#[derive(sqlx::FromRow)]` en los tipos compartidos. Razón: las macros checked requieren `DATABASE_URL` apuntando a una DB con schema aplicado en el entorno de build. Eso complicaría CI y `cargo check` de un clone limpio. La pérdida de tipado en compile-time es aceptable para el tamaño del proyecto: los errores de SQL aparecen al primer `cargo run`/test.

### Consecuencias
- Backend async end-to-end (Tauri ya lo es, `lofty` no — corre en `spawn_blocking`).
- Schema vive en SQL versionado, no en macros del compilador.
- Si en el futuro queremos compile-time check, agregar `cargo sqlx prepare` al flow de CI y bumpear a `query_as!`.

---

## ADR-002 — Bundle vs detección de yt-dlp y ffmpeg

**Fecha:** 2026-04-20 · **Aceptado:** 2026-04-30 · **Estado:** Accepted

### Contexto
La app depende de dos binarios externos. Hay que decidir cómo llegan a la máquina del usuario.

### Opciones
1. **Bundle** (binarios dentro del instalador): zero-setup, +40MB, problemas de licencia (ffmpeg LGPL/GPL según build), responsabilidad de mantener actualizados.
2. **Detectar + guiar:** peso mínimo, licencias limpias, fricción en primer arranque.
3. **Híbrido:** detectar primero, ofrecer descarga in-app si falta.

### Decisión
**Opción 2.** El comando `check_dependencies` (vía crate `which`) corre al boot; si falta yt-dlp o ffmpeg, el frontend muestra un `DependencyBanner` y el tab de descargas queda informativo. El resto del player funciona igual.

### Consecuencias
- Disclaimer legal limpio: no distribuimos yt-dlp.
- Setup wizard NO implementado — el banner alcanza para uso personal. Si en algún momento se distribuyera, agregar instrucciones por OS + botón "Re-check".
- Reconsiderar opción 3 si surge fricción real.

---

## ADR-003 — Font family definitiva

**Fecha:** 2026-04-20 · **Estado:** Proposed

### Contexto
La tipografía carga 80% del peso visual en brutalist. Tres candidatas en PLAN §7.2.

### Opciones
- **Space Grotesk** — geométrica, moderna, legible en texto corrido.
- **Archivo Black** — agresiva, solo para headers gigantes, no sirve para listas largas.
- **JetBrains Mono** — mono, ideal para metadata técnica y timestamps.

### Propuesta actual
Combinación: **Space Grotesk** para UI principal + **JetBrains Mono** para timestamps, bitrates, counts.
Evitar Archivo Black hasta tener un mockup que realmente la necesite.

### Pendiente
La app actual usa la system font + tracking-wider/uppercase para vibe brutalist. Cargar las webfonts cuando se haga el polish visual del MVP.

---

## ADR-004 — Color acento

**Fecha:** 2026-04-20 · **Aceptado:** 2026-04-21 · **Estado:** Accepted

### Contexto
Un solo color acento en toda la app (principio brutalist del PLAN).

### Decisión
**Naranja `#FF3B00`** (referencia Winamp), expuesto como `--accent` en [src/styles/tokens.css](../src/styles/tokens.css). Hover de botones default, color de progress bars, separadores activos.

### Consecuencias
- Cambiarlo es un find/replace de la variable. Si en el futuro queremos un toggle en settings, mover a CSS var dinámica.
- El estado "active" de toggles **NO** usa naranja — se distingue del hover usando blanco-sobre-negro (ver `<Button variant="active">`). Razón pragmática: con el mouse encima de un toggle on, el hover y el active sólo-naranja eran indistinguibles.

---

## ADR-005 — Titlebar nativa vs custom

**Fecha:** 2026-04-20 · **Estado:** Proposed

### Contexto
Tauri permite decorar la ventana con titlebar nativa o renderizar una propia.

### Opciones
1. **Nativa** — gratis, respeta convenciones OS, rompe estética brutalist en macOS (semáforo) y Windows (chrome redondeado).
2. **Custom** — control total, consistente cross-OS, requiere implementar drag-to-move + botones + maximize/minimize/close.

### Propuesta actual
Custom, pero **no bloquea el MVP**. La app actual corre con titlebar nativa por defecto. Se cambia a custom cuando entremos en polish visual.

---

## ADR-006 — Zustand como store global de React

**Fecha:** 2026-04-20 · **Estado:** Accepted

### Contexto
Necesitamos estado global para player, library, downloads, UI.

### Decisión
Zustand 5. Stores por dominio: `playerStore`, `libraryStore`, `uiStore`, `downloadStore`. Persistencia con `persist` middleware + `partialize` explícito (no persistir runtime state como `currentTime` o `tracks`).

### Consecuencias
- Sin DevTools de Redux por defecto — Zustand tiene plugin si lo necesitamos.
- Tests de stores son funciones puras (no implementados aún).
- **Footgun de HMR:** al editar un store, Vite hace HMR pero los `useEffect` ya corridos mantienen referencia al store viejo en sus closures. Síntoma: handlers actualizan el store viejo, la UI lee del nuevo, todo se desincroniza. Fix: kill + restart de `pnpm tauri dev`. En producción no aparece (no hay HMR). Documentado en CLAUDE.md gotcha #3.
- Cuando se cambia un default que ya está persistido en localStorage del usuario (ej: `visualizerSplit` 0.6 → 0.4), bumpear `version` del store. Sin eso los usuarios existentes se quedan con el valor viejo.

---

## ADR-007 — Generación de tipos Rust ↔ TypeScript

**Fecha:** 2026-04-20 · **Aceptado:** 2026-04-21 · **Estado:** Accepted (manual)

### Contexto
Los payloads de `invoke`/`emit` se definen en Rust y se consumen en TS. Mantener tipos sincronizados a mano es frágil cuando son muchos.

### Opciones
1. **`ts-rs`** — `#[derive(TS)]` genera `.ts` al correr tests.
2. **`specta` + `tauri-specta`** — diseñado para Tauri, genera cliente tipado completo.
3. **Manual** — escribir tipos dos veces, cero dependencias.

### Decisión
**Manual** — por ahora. Los tipos compartidos son ~5 (`Track`, `ScanReport`, `Download`, `DownloadStatus`, `DependencyStatus`). En Rust llevan `#[serde(rename_all = "camelCase")]` para que coincidan con la convención TS sin transformación adicional. Contrapartes en [src/types.ts](../src/types.ts).

### Razón
La superficie es chica. Agregar una dependencia de generación + un step en el build para 5 tipos era ratio costo/beneficio negativo. Si llegamos a >15 tipos compartidos o empezamos a olvidar sincronizarlos, switch a `tauri-specta`.

---

## ADR-008 — Singleton de audio fuera del JSX

**Fecha:** 2026-04-25 · **Estado:** Accepted

### Contexto
El `<audio>` element y el grafo Web Audio (`AudioContext` + `MediaElementAudioSourceNode` + `GainNode`) tienen restricciones duras:
- Sólo se puede crear **un** `MediaElementAudioSourceNode` por elemento `<audio>`.
- Butterchurn (en un subtree distinto, montado/desmontado al cambiar de vista) necesita tapearse al mismo source.

### Opciones
1. **Provider React** con context + ref al `<audio>` mounted en JSX.
2. **Singleton en module scope:** `getAudioElement()`, `getAudioContext()`, `getAudioSource()`, `getMasterGain()` en `src/audio/`.

### Decisión
Opción 2. El `<audio>` se crea con `new Audio()` en module scope ([src/audio/element.ts](../src/audio/element.ts)). El AudioContext + source + masterGain se crean lazy en el primer `getAudioContext()` ([src/audio/context.ts](../src/audio/context.ts)).

### Razón
Cualquier subtree (PlayerBar, VisualizerCanvas) puede importar y usar el mismo source sin ref-passing ni provider hell. El bootstrap del AudioContext se dispara en el primer `playTrack()` — momento en el que tenemos user gesture activo y nace en estado `running`.

### Consecuencias
- El volumen real **no** se controla con `audio.volume` — Chromium lo bypassea cuando hay un `MediaElementAudioSourceNode` conectado. `setVolume` y `toggleMute` escriben a `masterGain.gain.value` (gotcha #2 en CLAUDE.md).
- HMR puede dejar el AudioContext de la sesión vieja vivo. En la práctica casi nunca importa porque el module scope sobrevive al reload del módulo, pero ojo si alguna vez se ven dos contexts.

---

## ADR-009 — Press feedback via JS (no `:active` CSS)

**Fecha:** 2026-05-01 · **Estado:** Accepted

### Contexto
En MacBook con tap-to-click activado, un toque del trackpad dispara `:active` por ~5ms — demasiado corto para que el usuario lo perciba. CSS transitions no ayudan: `transition` no extiende el tiempo en el estado, solo interpola al entrar/salir.

### Decisión
Hook `usePressFlash()` ([src/hooks/usePressFlash.ts](../src/hooks/usePressFlash.ts)) que mantiene `pressed: boolean` por 150ms via `setTimeout`. Disparado en `onPointerDown`. El componente `<Button>` y `<Tabs>` usan este flag para renderizar el feedback.

### Razón
Garantiza visibilidad sin presión real del trackpad. 150ms es lo suficientemente corto para no parecer lag y lo suficientemente largo para que el ojo registre.

### Consecuencias
- Cualquier botón nuevo que necesite feedback de press debe usar `<Button>` o copiar el patrón. No usar `:active` directo.
- Re-clicks rápidos resetean el timer (no se cortan a la mitad) — el flash se ve continuo.

---

## ADR-010 — Idempotencia de scan / download via UNIQUE + ON CONFLICT

**Fecha:** 2026-04-25 · **Estado:** Accepted

### Contexto
- Re-escanear el mismo directorio no debe duplicar tracks.
- Re-descargar la misma URL no debe re-bajar el archivo ni duplicar la fila en `tracks`.

### Decisión
Tres mecanismos cooperando:
1. `tracks.file_path` es `UNIQUE` en el schema.
2. `db::tracks::insert_from_metadata` usa `INSERT ... ON CONFLICT (file_path) DO NOTHING` y devuelve `Ok(Option<i64>)` — `Some(id)` si insertó, `None` si ya existía.
3. yt-dlp corre con `--no-overwrites`, así que un re-download es no-op a nivel filesystem; el `insert_from_metadata` que sigue es no-op a nivel DB; el frontend ve `DownloadStatus::Skipped` en vez de `Completed`.

### Razón
Cero state-tracking en la app. La fuente de verdad es la combinación archivo-en-disco + fila-en-DB; mientras `file_path` matchee, todo es no-op.

### Consecuencias
- Si el usuario mueve un archivo manualmente fuera del scanner, el path viejo queda huérfano en DB. No hay garbage collection automático aún.
- Si dos tracks distintos tienen el mismo `file_path` (imposible mientras el filesystem sea sano), `ON CONFLICT` esconde el conflicto en silencio. Aceptable.

---

## ADR-011 — History de descargas en memoria (chunk 1)

**Fecha:** 2026-04-30 · **Estado:** Accepted · **Chunk 2 (persistente) implementado en [ADR-031](#adr-031--history-de-descargas-persistente--reconcile-de-huérfanas) (2026-06-18)**

### Contexto
La tabla `downloads` existe en el schema desde la primera migración, pero el código del downloader no la toca. El ID de descarga es un `AtomicI64` en memoria.

### Decisión (chunk 1 = MVP del downloader)
**No persistir** el estado de las descargas. Cada session empieza con la lista vacía. El frontend ve los `download-*` events en tiempo real; cuando se reinicia la app, el queue UI se vacía pero los archivos descargados ya están indexados como tracks (vía `tracks.source_type = 'downloaded'` y `source_url = <url>`).

### Razón
Acelerar el MVP del downloader. La feature crítica era ver progreso en tiempo real, no recordar qué se bajó la sesión pasada — esa info ya está en la library.

### Consecuencias
- Cuando se quiera "Downloads History" persistente: agregar inserts a `downloads` desde `commands::downloader::download_track`, leerlos al boot, hidratar el store. El schema ya está listo.
- Reintentos / cancelación posteriores al cierre de la app no son posibles. Si se cierra la app durante una descarga, `kill_on_drop(true)` mata el child y queda un `_pending/` huérfano.

---

## ADR-012 — Crossfade via dual `<audio>` + channelGain ramps

**Fecha:** 2026-05-02 · **Estado:** Accepted

### Contexto
PLAN §5.2 pedía crossfade configurable (off/3/6/12s) entre tracks consecutivos. Un solo `<audio>` no permite overlap real — sólo puede reproducir una source a la vez. Necesitamos dos audios reproduciendo simultáneamente durante la transición.

### Decisión
Dos singletons `<audio>` (channel A y B) en module scope. Web Audio graph:
```
audioA → sourceA → channelGainA ─┐
                                 ├─→ preMasterGain → masterGain → playPauseGain → destination
audioB → sourceB → channelGainB ─┘
```
- `channelGainA/B`: 1 = canal activo (audible), 0 = canal inactivo (silencio).
- Trigger: `_onTimeUpdate` chequea `duration - currentTime <= crossfadeMs/1000`. Si hay próximo track y no hay crossfade en curso, dispara `startCrossfade`.
- Crossfade: precarga próximo en canal inactivo, schedule de `linearRampToValueAtTime` sobre los dos `gain.gain` (reloj AudioContext), swap del `activeId`. Después de `crossfadeMs` (setTimeout en wall-clock), pausa el viejo y limpia su src.
- Cancelación: cualquier acción manual (playTrack, prev) llama `cancelCrossfade` que snappea a (active=1, inactive=0) hard.

### Razón
- `linearRampToValueAtTime` corre en AudioContext clock — no se desincroniza con frame drops del rendering.
- `preMasterGain` como junction node: el visualizer tapea ahí, ve la mezcla de los dos canales durante el fade.
- ChannelGain separado del masterGain (volumen) y playPauseGain (fade play/pause): cada control opera independiente sin interferirse.

### Consecuencias
- `useAudioPlayer` listenea eventos en **ambos** audios y filtra por `audio === getAudioElement()` (el activo). Sin el filtro, `timeupdate`/`ended` del canal viejo durante un fade pisarían el state del nuevo.
- Pausar durante crossfade: pausamos los dos audios. Los gain ramps siguen corriendo en AudioContext clock incluso si el audio está pausado — al reanudar el fade puede haber "saltado". UX aceptable.
- Track demasiado corto (<crossfadeMs): skip crossfade, dejamos terminar natural.

---

## ADR-013 — Fade in/out al play/pause via `playPauseGain` dedicado

**Fecha:** 2026-05-02 · **Estado:** Accepted

### Contexto
Click en PAUSE cortaba el audio abruptamente — clic audible. El usuario pidió un fade gradual. El `masterGain` no sirve porque también lo usa el slider de volumen y `toggleMute`; mezclar ambos roles produce conflictos cuando el usuario ajusta volumen durante un fade.

### Decisión
`GainNode` dedicado `playPauseGain` después de `masterGain` y antes de `destination`:
```
masterGain (volume + mute) → playPauseGain (play/pause fade) → destination
```
- `togglePlay` en branch "play": `audio.play()` + `fadeInPlayPause()` ramp 0→1 over 200ms.
- `togglePlay` en branch "pause": `fadeOutPlayPause(onFadeOut)` ramp current→0 over 150ms, después callback llama `audio.pause()`.
- togglePlay branchea sobre `isPlaying` del store (no `audio.paused`) y hace **eager update** del flag — así doble click rápido durante un fade-out no entra dos veces al branch de pause.
- Para empezar un ramp limpio desde el valor actual, usamos `cancelAndHoldAtTime(t)` en lugar de `cancelScheduledValues + setValueAtTime(g.value, t)`. Razón: `g.value` lee el valor INTRÍNSECO del AudioParam, no el computado del ramp en curso → con un fade-out a la mitad y click play, el snap a 0 era audible. `cancelAndHoldAtTime` inserta un `setValueAtTime` implícito con el valor computado actual.

### Razón
- Asimétrico (play más largo que pause) era counterintuitive para el usuario; fades simétricos a 200/150ms son ambos perceptibles y se sienten naturales.
- Visualizer tapea `preMasterGain` (upstream del fade), así que el visualizer no se silencia durante el fade — sigue reaccionando como si el audio estuviera saliendo full volume.

### Consecuencias
- `playPauseGain` arranca en 0 al inicializar el grafo. Primer `audio.play()` dispara `fadeInPlayPause` que ramp 0→1 — la app "cobra vida" gradualmente al primer playback. Sin esto, primer track entraría a volumen full instantáneo.
- Auto-advance entre tracks (track A termina → next() → track B): el ramp no afecta porque `playPauseGain` ya está en 1; el ramp 1→1 es no-op. Crossfade (si activo) maneja la transición vía channelGains.

---

## ADR-014 — Persistent visualizer mount + visibility-gated rAF

**Fecha:** 2026-05-02 · **Estado:** Accepted

### Contexto
Cada vez que el usuario navegaba a la tab VISUALIZER (o toggleaba paneMode entre visualizer/lyrics), Butterchurn re-creaba el WebGL context y recompilaba shaders del preset actual. Costo: ~100-300ms de freeze del main thread. Inaceptable como UX cuando el usuario alterna entre vistas seguido.

### Decisión
**Mount lazy + persist** del `VisualizerView`:
1. `App.tsx` mantiene flag `visualizerVisited`. Primera entrada a la tab visualizer lo flippea a true; ahí se monta el componente.
2. Una vez montado, queda montado hasta cerrar la app. Se "oculta" via CSS (`absolute inset-0 invisible pointer-events-none`) cuando `view !== "visualizer"`.
3. El rAF loop dentro de `VisualizerCanvas` se separa del init effect y se gate-ea por `visible` (`view === "visualizer" && paneMode === "visualizer"`). Cuando false, cancela rAF — el canvas queda con el último frame estático, sin quemar CPU/GPU.
4. Auto-cycle de presets también se gate-ea por `visible` (sino cambiaría `presetIndex` en background y dispararía `loadPreset` → recompilación de shaders → freeze invisible).
5. ResizeObserver skipea cuando `clientWidth/Height === 0` (caso `display: none` en padre).

### Razón
- WebGL context creation + shader compilation son irrecuperables cada vez que se desmontan. Mount persistente paga el costo una vez.
- Memoria: ~50MB combinados (GPU buffers + JS state). En Apple Silicon (memoria unificada) es ~0.3% del total — despreciable.
- `visibility: hidden` + `pointer-events: none` preserva las dimensiones del layout — ResizeObserver no fluctúa entre 0 y full size, los framebuffers internos no se re-allocan al volver.

### Consecuencias
- Primera visita: paga el freeze (~100-300ms). Subsecuentes navegaciones: instantáneas.
- El canvas debe renderizarse en `absolute inset-0` dentro de un padre `relative` para que coexista con LibraryTable/DownloadsView en el mismo slot del layout principal.
- Trade-off: en sesiones donde el usuario nunca abre el visualizer, no paga el costo (lazy). Sólo paga al primer visit.

---

## ADR-015 — Lyrics Fase 1 sin trait abstraction

**Fecha:** 2026-05-02 · **Estado:** Accepted

### Contexto
Una investigación inicial proponía un sistema de letras con trait `LyricsProvider` + `LyricsResolver` cascade, soportando 4 providers (Embedded, LRCLIB, Musixmatch, Genius). CLAUDE.md dice "preferir patrones simples sobre abstracciones prematuras" — el plan era over-engineered para Fase 1.

### Decisión
Slim Fase 1 con dos providers como **funciones libres**, sin trait:
- `embedded.rs`: `try_embedded(file_path)` lee USLT vía lofty.
- `lrclib.rs`: `try_lrclib(query)` con field fallback (con/sin album) + search fallback (`/api/search` después de `/api/get`).
- `mod.rs::fetch_lyrics`: cascade Embedded → LRCLIB → mark_not_found, política híbrida (preferir synced, retener mejor plain como fallback).

Schema aditivo a la tabla `lyrics` existente (no rename). Comandos: `lyrics_fetch` (cache-first), `lyrics_set_offset`. Parser LRC en frontend (TS) — el backend sólo guarda el blob raw.

Plan documentado en [LYRICS.md](./LYRICS.md) con Fases 2 y 3.

### Razón
Dos providers no justifican el costo de una abstracción dyn-dispatch. Si en Fase 2 sumamos Genius (3er provider), refactorizamos al trait — momento donde el patrón paga su costo.

### Consecuencias
- Code path explícito y debuggeable.
- Fase 2 (Genius, manual paste, refetch) requiere refactor cuando se sume el provider; pero lo haremos con el contexto de un sistema funcionando, no a ciegas.
- Fase 3 (AcoustID) cambia el game completo — el match rate sube tanto que muchos features de Fase 2 (manual paste, drift correction) pierden urgencia. Por eso Fase 2 queda diferida.

---

## ADR-016 — Cleanup heurístico de metadata post-yt-dlp

**Fecha:** 2026-05-02 · **Estado:** Accepted

### Contexto
yt-dlp escribe metadata desde campos de YouTube que vienen ruidosos: `artist="Avicii - Topic"` (canales auto-generados), `artist="AviciiOfficialVEVO"` (canales VEVO sin espacios), `title="Avicii - The Nights (Official Video)"` con prefijo redundante de artista + sufijos de tipo de video. LRCLIB hace match exacto contra (artist, title) — un sufijo de más basta para 404 aunque el track esté indexado.

### Decisión
[`audio/cleanup.rs`](../src-tauri/src/audio/cleanup.rs) con heurísticas conservadoras aplicadas en dos puntos:
1. **Post-download**: en `commands/downloader.rs` después de `extract_metadata`, antes de INSERT.
2. **Backfill manual**: comando `library_backfill_metadata` + botón "CLEAN METADATA" en LibraryToolbar para limpiar tracks ya en DB.

Heurísticas:
- Strip de sufijos de artist: `OfficialVEVO`, `OfficialChannel`, `- Topic`, ` VEVO`, ` Vevo`, `VEVO`, `Vevo`, ` Official`. Orden por longitud — `OfficialVEVO` antes de `VEVO`.
- Strip de patrones parentizados/bracketed en title: `(Official Music Video)`, `(Lyric Video)`, `(Audio)`, `[HD]`, `[NCS Release]`, `[Free Download]`, etc.
- Si artist está vacío y title contiene ` - `: split en el primer separador.
- Si artist seteado y title empieza con `<artist> - ` (case-insensitive): strip prefix.
- Defensive `.trim()` al inicio (whitespace/BOM invisible de yt-dlp).
- Backfill invalida lyrics cache (`DELETE FROM lyrics WHERE track_id = ?`) cuando cambia metadata — sino el `not_found` cacheado contra la metadata vieja sigue válido.

23 unit tests cubriendo casos típicos + idempotencia + preservación de paréntesis legítimos (`(feat. X)`, `(cover)`).

### Razón
**Conservador por elección**: preferir falsos negativos (no limpiar) sobre falsos positivos (borrar contenido legítimo). El caso `Hello (cover)` o `Levitating (feat. DaBaby)` sería catastrófico si lo strip-eáramos.

### Consecuencias
- El cleanup resuelve los casos típicos pero no todos. Casos como `artist="VisibleNoiseRecords" title="LOSTPROPHETS - Rooftops"` (uploader = sello, no artista canónico) están fuera del alcance de heurísticas text-based.
- La solución correcta para casos remanentes es **AcoustID** (Fase 3) — fingerprint del audio te da MBID canónico, sin heurística.
- El backfill procesa **todos** los tracks (no sólo `source_type='downloaded'`) — tracks descargados manualmente con yt-dlp CLI y luego scaneados quedaban como `'local'` y la metadata noisy escapaba.

---

## ADR-017 — Auto-fetch de lyrics on track change para indicador library

**Fecha:** 2026-05-02 · **Estado:** Accepted

### Contexto
La library tiene una columna `L` con indicador del estado de lyrics (`[L]` synced, `·` plain, `♪` instrumental, `—` not_found, vacío = no fetcheado). Para que el indicador sirva, necesitamos saber el estado de cada track. La opción "fetchear toda la library al boot" es agresiva (potencialmente cientos de requests a LRCLIB de una). La opción "fetchear sólo cuando se abre la pane" deja la library siempre vacía de indicadores hasta que el usuario explore manualmente.

### Decisión
Auto-fetch en cada `currentTrackId` change, sin importar la vista actual. Implementado en [`useLyricsSync`](../src/hooks/useLyricsSync.ts):
```ts
useEffect(() => {
  if (trackId === null) { useLyricsStore.getState().clear(); return; }
  void fetchAndRefreshLibrary(trackId);
}, [trackId]);
```
Después del fetch, recargamos la library (`loadTracks`) para que el SQL JOIN con `lyrics` devuelva el `lyricsStatus` actualizado y la UI re-renderice con el indicador.

### Razón
- La library se va poblando **gradualmente con el uso natural**: a medida que el usuario reproduce tracks, los indicadores aparecen.
- Cache en DB previene requests duplicados — segunda reproducción del mismo track es no-op de red.
- Costo: 1 request a LRCLIB por track nuevo. Para 200 tracks reproducidos en un mes → 200 requests totales. Trivial.

### Consecuencias
- `loadTracks` se llama después de cada fetch — incluye una query SQL al backend. Para libraries grandes (>1000 tracks) podría notarse; optimización con dirty-flag postergada hasta que sea necesario.
- Tracks que el usuario nunca reproduce nunca tienen indicador. Aceptable — si no los escucha, probablemente no le interesa el estado de letras.
- El `lyricsStatus` en SQL se computa via CASE en `list_all` — los 5 estados (synced/plain/instrumental/not_found/null) salen de un solo LEFT JOIN sin segunda query.

---

## ADR-018 — WhisperX (no aeneas) para forced alignment

**Fecha:** 2026-05-04 · **Estado:** Accepted

### Contexto
Para resolver per-word timing real (Fase 2.b lyrics / Fase A karaoke) necesitábamos un tool de forced alignment. El plan original (KARAOKE.md draft inicial) era usar `aeneas` — proyecto OSS dedicado a forced alignment con eSpeak + DTW, ~50MB, Python.

Al intentar instalar aeneas con `pipx install aeneas` con Python 3.13 y luego con 3.11, el build wheel falló con `ERROR: Failed to build 'aeneas' when getting requirements to build wheel`. El `setup.py` de aeneas usa setuptools APIs deprecadas que no existen en setuptools modernas. Aeneas no se mantiene desde 2018.

### Decisión
Pivotar a **WhisperX** (Python + PyTorch + Whisper + wav2vec2). Activamente mantenido. Modo `align-only` via Python API.

### Razón
- aeneas: liviano (~50MB) pero abandonado; la incompatibilidad va a empeorar.
- whisper.cpp: blind transcription only — wrong tool para "ya tengo el texto, alíneamelo".
- WhisperX: 1.5-2GB (PyTorch + modelos) pero forced alignment via wav2vec2 con calidad ~95%. Mantenibilidad gana al peso.

Trade-off explícito: para portfolio + uso personal, mantenibilidad gana. Si en 1 año WhisperX rompe, podemos volver a evaluar.

### Consecuencias
- Setup más pesado: `pipx install --python python3.11 whisperx` + ~150MB-2GB de modelos descargados al primer run.
- Doc de install explícito en README (parte de "OPTIONAL DEPENDENCIES").
- Detección con fallback path (`~/.local/bin/`, etc.) porque PATH no se hereda al proceso Tauri en macOS — ver [`commands::system::resolve_binary`](../src-tauri/src/commands/system.rs).

---

## ADR-019 — Forced alignment con bounds tight del LRC (no whole-track ni buffered)

**Fecha:** 2026-05-04 · **Estado:** Accepted

### Contexto
Al implementar karaoke alignment, probamos cuatro enfoques de bounds para el segmento que le pasamos a `whisperx.align()`:

1. **Bounds tight per-line** = `[line[i].start, line[i+1].start]` directo del LRC.
2. **Bounds whole-track** = `[0, audio_duration]` con todo el texto combinado.
3. **Bounds con buffer ±3s** = expand cada line bound con tolerance.
4. **Blind transcribe + distribución proporcional** = whisperx blind primero, después distribuir palabras LRC proporcional a duración de cada whisperx segment.

Cada uno fallaba de manera distinta (ver [KARAOKE.md §13.2](./KARAOKE.md#132-el-journey-de-los-segment-bounds)):

| Approach | Falla |
|---|---|
| Whole-track | CTC greedy desde t=0; "There's" salió a 0.08s |
| Buffer ±3s | Whisperx aprovechó el buffer; "There's" a 17.86s en vez de 20.00s |
| Blind transcribe + proporcional | "downfall" salió a 2:36 cuando audio canta a 3:19 — densidad de palabras no es uniforme |
| Tight LRC | Bueno cuando LRC es accurate; falla cuando LRC tiene drift |

### Decisión
**Tight LRC bounds.** Approach más simple y predecible.

### Razón
- Predecibilidad > flexibilidad. Tight bounds dan resultados que dependen lineal de la calidad del LRC.
- Cuando LRC está bien, el alignment es excelente. Cuando LRC tiene drift, el error queda **confinado a la línea afectada** — no se propaga al resto del track.
- Las otras opciones tenían modos de falla peores: errores que se acumulan a lo largo del track.

### Consecuencias
- Aceptamos que para tracks con LRC malo (LRCLIB community-curated con errores), el alignment será limitado. **Honest disclaimer en KARAOKE.md §13.9.**
- Path forward para esos casos: lyrics Fase 2.c — UI manual edit + alternative providers. Mejor LRC = mejor alignment automático.

---

## ADR-020 — Backup `original_synced_lyrics` para re-aligns idempotentes

**Fecha:** 2026-05-04 · **Estado:** Accepted

### Contexto
Bug descubierto durante validación: `RE-ALIGN` siempre operaba sobre el `synced_lyrics` actual de la DB. Pero después del primer alignment, `synced_lyrics` ya tenía formato A2 con timestamps de whisperx. El parser extraía esos timestamps como bounds de línea para mandar al siguiente whisperx — perpetuando errores.

Resultado: cada re-align generaba datos peores que el anterior. Vicious cycle.

### Decisión
Nueva columna `lyrics.original_synced_lyrics TEXT` que guarda el LRC raw como vino de LRCLIB la primera vez. `karaoke::align_track` siempre lee de ahí, no de `synced_lyrics`.

### Razón
- Mismo patrón que `tracks.original_title` / `original_artist` (ADR para identification).
- Cleanest fix: mantener una fuente de verdad inmutable.
- Alternative considerada (refetch desde LRCLIB cada vez): network IO + dependencia en LRCLIB no-flaky. Worse.

### Consecuencias
- Migración aditiva: `20260504000001_lyrics_original_synced.sql`.
- Upsert con `COALESCE(lyrics.original_synced_lyrics, excluded.original_synced_lyrics)` — set on first insert, preserve on update.
- Rows pre-fix tienen `original_synced_lyrics = NULL`. Cascade hace fallback a `synced_lyrics` con eprintln warning. El usuario puede recuperar con `DELETE FROM lyrics WHERE track_id = N` y dejar que el next play re-fetchee.

---

## ADR-021 — A2 LRC extendido con trailing end marker

**Fecha:** 2026-05-04 · **Estado:** Accepted

### Contexto
A2 LRC estándar tiene markers de START por palabra: `[mm:ss.xx]<mm:ss.xx>word1 <mm:ss.xx>word2`. No hay marker de END por palabra; el end de cada palabra se infiere del start de la siguiente.

Para la **última palabra de cada línea**, no hay siguiente palabra. Inicialmente fallback a `nextLineEff` (start de la próxima línea LRC). Resultado: la última palabra se rellenaba progresivamente durante el silencio entre líneas — visible al usuario como "letra avanza durante espacio vacío".

### Decisión
Extender A2 con un trailing marker `<endTs>` después de la última palabra de cada línea. Ejemplo:
```
[00:25.43]<00:25.43>Once <00:25.85>upon <00:26.10>year<00:26.78>
                                                     ↑
                                      trailing marker = end real de "year"
```

### Razón
- WhisperX nos da `end` por palabra; era info que estábamos descartando.
- Backward compat: parsers que no entienden A2 ignoran tanto los `<...>word` como el trailing.
- A2 strict-spec parsers podrían parsear el trailing como un marker sin palabra después; aceptamos como nuestra extensión local.

### Consecuencias
- `LrcLine` tiene un campo nuevo `lastWordEndMs?: number` (frontend) / `wt.end` por palabra (backend).
- `useSyncedLyrics` usa `lastWordEndMs` como bound right de la última palabra. Si no está (LRC pre-fix), fallback a `nextLineEff` (comportamiento viejo).
- Migración no es necesaria — el formato A2 vive en `synced_lyrics` ya existente.

---

## ADR-022 — Cursor de lyrics usa `wordTimestampsMs[0]` cuando hay alignment

**Fecha:** 2026-05-04 · **Estado:** Accepted

### Contexto
El cursor del rAF loop en `useSyncedLyrics` decide qué línea es activa basándose en `effectiveOf(line) <= currentMs`. Originalmente `effectiveOf` usaba `line.timestampMs` (el `[mm:ss.xx]` del LRC original).

Para tracks sin alignment, eso es lo correcto. Para tracks con alignment, `line.timestampMs` viene del LRC original que puede tener drift respecto al audio del usuario; `wordTimestampsMs[0]` (el start de la primera palabra real, vía whisperx) es la verdad.

### Decisión
`effectiveOf(line) = (line.wordTimestampsMs?.[0] ?? line.timestampMs + lrcOffset) * speedRatio + userOffset`.

Aplicado a todos los lugares donde la línea tiene un "tiempo de inicio efectivo":
- Cursor del rAF.
- `effectiveTimestampMs` helper (usado por click-to-seek).
- ALIGN button "set offset here" handler.

### Razón
- Si confiamos en wordTimestampsMs para el fill (ya hacemos eso), también deberíamos confiarlo para el cursor. Consistencia.
- El LRC line marker queda preservado en la string A2 para backward compat con otros players que no entienden A2.

### Consecuencias
- Para tracks con LRC drifty + alignment ejecutado, la línea se vuelve "active" cuando arranca su primera palabra real (no cuando dice el LRC). UX correcto.
- Auto-reset de offset/speed al alinear (`save_aligned`) — los ajustes manuales eran para compensar drift que ahora resolvió whisperx.

---

## ADR-023 — EQ insertado post-tap del visualizer

**Fecha:** 2026-06-14 · **Estado:** Accepted

### Contexto
El EQ de 10 bandas (Fase 2 PLAN §6.2 #3) necesita un punto de inserción en el grafo Web Audio. Las dos opciones razonables:

1. **Pre-tap** — entre `channelGain` y `preMasterGain`. El visualizer (que tapea `preMasterGain`) vería el audio post-EQ.
2. **Post-tap** — entre `preMasterGain` y `masterGain`. El visualizer ve el audio pre-EQ.

### Decisión
**Post-tap.** Pipeline final:
```
audioA/B → sourceA/B → channelGainA/B → preMasterGain → eqBands[0..9] → masterGain → playPauseGain → destination
                                              ↓
                                   Butterchurn tap (independiente del EQ)
```

### Razón
- El visualizer es **lectura objetiva del track**, no del listening del usuario. Si subís +12dB en 60Hz, querés escuchar más bass — pero el visualizer explotando en bass como artefacto del slider es confuso: el usuario lo lee como "el track tiene más bass" cuando es la EQ.
- Mantiene la semántica establecida en ADR-013 (Butterchurn tapea `preMasterGain` para reaccionar al audio "real", aún con mute o pause-fade activo). El EQ es el siguiente layer de "ajuste personal" después de mute, en la misma categoría.
- Si en algún momento queremos "el visualizer reacciona a lo que estoy oyendo", se puede agregar como toggle en `settings` ("tie visualizer to EQ"). No es la default.

### Consecuencias
- **Pro:** comportamiento del visualizer es determinista y predecible — depende del audio source, no de los sliders del usuario.
- **Pro:** el usuario puede experimentar con EQ extremas sin "romper" el visualizer.
- **Contra:** no hay way de hacer un demo de "mirá cómo cambia el visualizer cuando muevo el EQ" sin re-wirear el grafo. Aceptable — no es un use case real.
- **Contra:** bypassear el EQ con `gain=0` en todas las bandas (vs disconnect/reconnect) deja los nodos procesando flat. Overhead despreciable (10 BiquadFilters a 0dB es transparente; CPU < 0.1%). Trade-off explícito por simplicidad de implementación.

### Detalles de implementación
- 10 bandas ISO: 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz.
- Band 0 = lowshelf, band 9 = highshelf, bands 1-8 = peaking con Q=1.0.
- Setter usa `setTargetAtTime(target, t, 0.005)` (5ms time-constant) para evitar zipper noise al arrastrar sliders rápido.
- `eqEnabled=false` no desconecta el chain — todas las bandas se ponen a 0dB. Preserva el preset del usuario sin perder el flag.

## ADR-024 — Descarga de listas (FULL PLAYLIST) + cookies del navegador

**Fecha:** 2026-06-16 · **Estado:** Accepted

### Contexto
El downloader bajaba un video por vez (`--no-playlist`). Pedido: bajar listas completas. Además, listas privadas y videos age-restricted/members-only requieren autenticación — yt-dlp anónimo devuelve `"The playlist does not exist"` en una lista privada.

### Decisión
- Toggle **FULL PLAYLIST** en el DownloadForm. Default **OFF** = `--no-playlist` (un solo video aunque la URL traiga `list=`); ON = `--yes-playlist`.
- `run_yt_dlp` devuelve `Vec<DownloadedEntry>` (multi-file) con `playlist_title`/`playlist_index` parseados de un `--print` tab-delimited. Si fue lista, los tracks van a "all tracks" **y** a una playlist creada/reusada por nombre (`get_or_create_id`).
- **Cookies**: select de navegador (`cookiesBrowser` persistido) → `--cookies-from-browser <b>`.

### Razón
- Toggle explícito (no auto-detect por `list=`) evita el footgun de que una URL `watch?v=X&list=Y` baje 200 videos sin querer.
- `get_or_create_id` por nombre + `add_track` idempotente → re-bajar la misma lista no duplica ni la playlist ni sus tracks.
- Cookies del navegador es la vía estándar de yt-dlp para contenido privado; reutiliza la sesión del usuario sin pedirle credenciales.

### Consecuencias
- **Pro:** una lista entera entra de un click y queda como playlist navegable.
- **Contra:** progreso es agregado (`item N/M` + barra del archivo actual), no una fila por track. Aceptable para uso personal.
- **Contra:** si yt-dlp no expone título de lista, la playlist se llama `"Imported playlist"`.
- **Contra:** `--cookies-from-browser` en macOS puede disparar prompt de Keychain (Chrome cifra las cookies). Documentado.

## ADR-025 — Dedup de descargas: por path + fingerprint exacto (conservador)

**Fecha:** 2026-06-16 · **Estado:** Accepted

### Contexto
La misma canción puede estar en varias playlists. Al bajarlas, no queremos archivos ni filas duplicadas.

### Decisión
Dos niveles, sólo en el path de descarga (`persist_downloaded_file`):
1. **Por path** — `tracks.file_path UNIQUE` + `--no-overwrites`. Cubre el mismo video (mismo `<uploader>/<title>.mp3`).
2. **Por contenido** — fingerprint Chromaprint con match **EXACTO** (`find_id_by_fingerprint`). Si ya existe un track con ese fingerprint, se borra la copia recién bajada y se reusa el track existente (que igual se suma a la playlist).

### Razón
- Match exacto = **alta precisión, cero falsos positivos**. Un re-encode con master distinto produce otro fingerprint y NO matchea — y eso es **intencional**: preferimos dejar un duplicado antes que borrar por error una versión/remaster legítimamente distinta (mismo principio que el cleanup heurístico, Gotcha #11).
- No hacemos comparación *fuzzy* de fingerprints (bit-error-rate) porque es compleja de implementar bien y arriesga falsos positivos destructivos.

### Consecuencias
- **Pro:** misma grabación traída de otro upload se detecta y no duplica.
- **Contra:** sólo dedupea contra tracks con `acoustid_fingerprint` cacheado (download nuevo lo guarda, o un IDENTIFY previo). Los tracks pre-feature con fingerprint NULL no son candidatos hasta identificarlos.
- **Contra:** requiere `fpcalc`; sin él degrada a dedup por-path solamente (sin error).
- **No aplica al SCAN** — ahí no borramos archivos del usuario.

## ADR-026 — Switch gapless en selección manual de track

**Fecha:** 2026-06-16 · **Estado:** Accepted

### Contexto
Al clickear un track con algo sonando, `loadAndPlay` hacía `audio.src = nuevo; audio.play()` sobre el canal activo — cortaba el actual al instante y el nuevo recién sonaba tras cargar/decodificar (latencia del asset protocol) → gap de silencio audible. El crossfade automático **no** tiene este gap porque precarga el próximo track ~6s antes.

### Decisión
Al clickear (o NEXT/PREV) **con algo sonando**, cargar el track nuevo en el **canal inactivo** y mantener el actual sonando hasta que el nuevo dispare `playing`; recién ahí hacer el swap (gains instantáneos + cambio de canal activo + `currentTrackId`). Carga directa (`loadAndPlay`) cuando está pausado o es el primer play (no hay nada que enmascarar).

### Razón
- Lleva la idea del crossfade (precargar en el canal inactivo) al click manual, pero con **swap instantáneo gateado por readiness** en vez de un ramp temporal.
- Reusa el modelo dual-channel existente sin tocar el crossfade.

### Consecuencias
- **Pro:** el cambio manual se siente inmediato, sin gap.
- **Contra:** el highlight de la fila + el seekbar cambian recién en el swap (lag = tiempo de carga, chico para archivos locales). Consistente con cómo el crossfade actualiza `currentTrackId`.
- Cancela el swap pendiente en play/pause, crossfade automático, clicks rápidos y resume al boot — para que su `onReady` no corra tarde y pise el estado.

## ADR-027 — Reorder de playlist via pointer events (no HTML5 DnD)

**Fecha:** 2026-06-16 · **Estado:** Accepted

### Contexto
El reorder de tracks pide drag & drop. El primer intento usó la API nativa HTML5 (`draggable` + `onDragStart/Over/Drop`). En el webview de macOS (WKWebView) el evento `drop` **no dispara** — aun seteando `dataTransfer.setData()` en dragstart y `preventDefault()` en dragover **y** dragenter. El drag se ve, pero soltar no hace nada.

### Decisión
Implementar el drag **a mano con pointer events**: `pointerdown` en un handle `≡` → listeners de `pointermove`/`pointerup` en `window` → `document.elementFromPoint()` resuelve la fila destino (vía `data-row-index`). Sin la API nativa de DnD.

### Razón
- HTML5 DnD es inconfiable en WKWebView (ver Gotcha #17). Pointer events funcionan siempre en webviews.
- Iniciar el drag sólo desde el handle evita reorders accidentales al clickear una fila para reproducir.

### Consecuencias
- **Pro:** reorder confiable en el webview.
- **Contra:** sin auto-scroll cuando arrastrás al borde de una lista larga (pendiente de polish).
- Sólo activo en vista de playlist sin search (reordenar una vista filtrada es ambiguo).

## ADR-028 — Cookies por archivo + éxito parcial en descarga de playlists

**Fecha:** 2026-06-17 · **Estado:** Accepted

### Contexto
Dos problemas surgieron al bajar una playlist privada de YouTube en Windows con cookies:

1. **`--cookies-from-browser` falla con Chromium en Windows.** Con Brave/Edge/Chrome **abiertos**, yt-dlp tira `Could not copy Chrome cookie database` (issue #7271). Causa: Chromium mantiene su base SQLite de cookies con un lock **obligatorio** (mandatory) a nivel filesystem en Windows; el SO le niega la copia a yt-dlp. En macOS/Linux los locks son **cooperativos** (advisory) → no pasa, por eso en macOS andaba. Firefox no sufre el problema en ninguna plataforma.

2. **Una playlist con un item fallido se reportaba como falla total.** Si un video de la lista está borrado/privado/region-locked, yt-dlp baja el resto pero sale con exit ≠ 0. `run_yt_dlp` trataba *cualquier* exit ≠ 0 como falla → descartaba todos los entries buenos y mostraba FAILED con la última línea de stderr (que suele ser `Finished downloading playlist: <name>`, un mensaje de éxito → confuso; el `ERROR:` del item ya scrolleó fuera del buffer de 64 líneas).

### Decisión
1. **Segunda fuente de cookies por archivo.** El `DownloadForm` ofrece, además del select de navegador, un botón **COOKIES FILE** que elige un `cookies.txt` (formato Netscape, exportado con una extensión tipo "Get cookies.txt LOCALLY"). Si está seteado, el backend usa `--cookies <archivo>` con **prioridad** sobre `--cookies-from-browser` (`cookies_file` antes que `cookies_browser` en el match de `run_yt_dlp`). El archivo no toca la SQLite del navegador → funciona con el navegador abierto. Persistido como `cookiesFile` en downloadStore.

2. **Éxito parcial.** `run_yt_dlp` chequea `entries` **antes** que `status.success()`: si capturó ≥1 archivo, devuelve `Ok(entries)` (éxito parcial) sin importar el exit code. Sólo es falla real (`NonZeroExit` / `NoFilepath`) cuando no se materializó nada.

### Razón
- No copiar la DB de cookies nosotros: choca con el mismo lock, y la App-Bound Encryption de Chromium reciente lo complica más → frágil. El cookies.txt es la solución estándar de la comunidad yt-dlp.
- Prioridad archivo > navegador: si el usuario se tomó el trabajo de exportar, es la intención explícita.
- Éxito parcial: bajar 49 de 50 tracks y reportar FAILED es peor que quedarse con los 49. yt-dlp ya separó lo bueno de lo malo; nosotros sólo lo estábamos tirando.

### Consecuencias
- **Pro:** descarga viable con Chromium en Windows sin cerrar el navegador; playlists con items rotos ya no fallan enteras.
- **Contra:** el cookies.txt caduca (semanas) → re-exportar manualmente. El éxito parcial **silencia** qué items fallaron (no se reporta cuáles) — trade-off aceptado; el usuario compara N tracks en la playlist vs el total de la lista si quiere chequear.
- Recomendación de UX en el form: Firefox anda con el navegador abierto; Chromium requiere cerrarlo o usar el archivo. Ver Gotcha #18 + #19.

## ADR-029 — Musixmatch como tercer provider, LRCLIB-first

**Fecha:** 2026-06-17 · **Estado:** ~~Accepted~~ **Superseded por [ADR-030](#adr-030--netease-como-tercer-provider-free-keyless)** (2026-06-18)

> **Superseded:** al implementarlo se descubrió que el plan free de Musixmatch
> es **preview-only** (devuelve un fragmento truncado, nunca la letra completa
> ni synced) — letras completas requieren licencia comercial paga. No sirve
> para un reproductor. Pivoteamos a **NetEase** (free, keyless) como el tercer
> provider synced. El diseño de cascade LRCLIB-first de este ADR se conserva;
> sólo cambia el provider concreto. Ver ADR-030.

### Contexto
LRCLIB es gratuito pero su cobertura de letras synced en pop/rock comercial tiene huecos y calidad variable (community-curated). Musixmatch tiene la mayor base de letras sincronizadas comercialmente curada. Se necesita decidir: (1) si agregar Musixmatch al cascade, (2) en qué orden, (3) si refactorizar a trait `LyricsProvider`.

### Opciones consideradas
1. **Musixmatch primero, LRCLIB fallback.** Mejor calidad por defecto, pero gasta ~1 call/track incluso cuando LRCLIB ya tiene synced.
2. **LRCLIB primero, Musixmatch si LRCLIB no tiene synced.** Ahorra calls de Musixmatch (plan free = ~2000/día). LRCLIB cubre la mayoría de tracks mainstream; Musixmatch complementa los huecos.
3. **Musixmatch en paralelo** con LRCLIB, comparar resultados. Complejidad sin beneficio claro — el usuario no va a notar la diferencia en calidad si LRCLIB ya tiene synced.

### Decisión
**Opción 2 — LRCLIB first, Musixmatch second.** El cascade queda: Embedded → LRCLIB → Musixmatch → not_found. Musixmatch sólo se intenta cuando (a) LRCLIB no devolvió synced, y (b) el usuario configuró su API key en settings.

### Razón
- Ahorra calls de la cuota free de Musixmatch para los tracks que realmente lo necesitan.
- Sin API key, el cascade se comporta exactamente como antes (zero-impact default).
- API key del usuario en `settings` table — nunca bundleada. Misma decisión que AcoustID ([ADR-015](DECISIONS.md#adr-015)).
- Sin trait refactor: se mantienen funciones libres (`try_embedded`, `try_lrclib`, `try_musixmatch`). El trait `LyricsProvider` se justifica con el 4to provider (Genius), no antes. CLAUDE.md: "preferir patrones simples sobre abstracciones prematuras".

### Consecuencias
- **Pro:** cobertura synced significativamente mejor para pop/rock comercial; el usuario que no ponga API key no nota ningún cambio.
- **Pro:** sin migración de DB — `settings` y `lyrics` table ya soportan todo.
- **Contra:** Musixmatch no devuelve la duración del track matcheado, así que no podemos calcular confidence por duration delta (se usa fija 0.9) ni auto-baseline de speedRatio.
- **Contra:** Musixmatch devuelve synced en formato JSON subtitle (no LRC) → requiere conversión `subtitle_to_lrc()`.
- Cross-ref: [LYRICS.md §15](LYRICS.md#15-musixmatch-fase-2c3) para implementación detallada.

## ADR-030 — NetEase como tercer provider (free, keyless)

**Fecha:** 2026-06-18 · **Estado:** Accepted · Reemplaza [ADR-029](#adr-029--musixmatch-como-tercer-provider-lrclib-first)

### Contexto
ADR-029 eligió Musixmatch como tercer provider synced. Al implementarlo se confirmó (verificando docs + pricing) que su **plan free es preview-only**: devuelve sólo un fragmento de la letra, nunca el texto completo ni el synced. Las letras completas/sincronizadas requieren **licencia comercial paga** (Professional/Enterprise). Para un reproductor personal eso no sirve. Se necesita un provider synced **gratis** que cierre la brecha de cobertura de LRCLIB.

### Opciones consideradas
1. **NetEase Cloud Music (music.163.com).** API comunitaria, sin key. Devuelve la letra **directamente en formato LRC** vía `/api/song/lyric`. Endpoints no oficiales (riesgo de cambio/geo-block).
2. **Musixmatch reverse-engineered** (token de la app, estilo lib `syncedlyrics`). Mejor cobertura pero zona gris de ToS más profunda + token frágil.
3. **Mantener Musixmatch oficial** detrás de key paga opcional. No cumple el objetivo de "mejor synced gratis".

### Decisión
**Opción 1 — NetEase.** Cascade: Embedded → LRCLIB → **NetEase** → not_found. Se intenta siempre que no haya synced aún y haya artist; **sin key ni configuración** (a diferencia de Musixmatch). Validado contra la API real (keyless permite probarla): `/api/search/get/` (JSON plano; `get/web` viene eapi-encriptado) + `/api/song/lyric` con header `Referer: https://music.163.com`.

### Razón
- **Gratis y sin fricción** — cumple el objetivo de la Bandera de UX (mejor synced sin que el usuario configure nada). Sin key = sin modal, sin settings, sin plumbing.
- NetEase devuelve **LRC directo** (con fracciones de 3 dígitos `[mm:ss.xxx]` que el parser frontend ya soporta) — sin conversión `subtitle_to_lrc` que requería Musixmatch.
- Matching **conservador** por duración (±8s) — preferimos no mostrar letras a mostrar las de otra versión (mismo principio que LRCLIB / Gotcha #11).
- Sin trait refactor (igual que ADR-029/ADR-015): se mantienen funciones libres.

### Consecuencias
- **Pro:** cobertura synced extra gratis; cero config para el usuario.
- **Contra:** endpoint comunitario/no documentado → puede cambiar o estar geo-restringido. Todos los fallos degradan a `Ok(None)` (cascade sigue a not_found, no rompe nada).
- **Contra:** cobertura sesgada al catálogo de NetEase (fuerte en pop asiático, decente en mainstream occidental). Complementa LRCLIB, no lo reemplaza.
- Sin migración de DB — `lyrics.source` guarda `"netease"`.
- Botón **REFETCH** en la vista not_found (reusa el flag `force` de `lyrics_fetch`) para re-correr el cascade sobre tracks marcados `not_found` antes de que NetEase existiera. Cierra el TODO de "Search again" del backlog de LYRICS.md §0.
- Cross-ref: [LYRICS.md §15](LYRICS.md#15-netease-fase-2c3).

## ADR-031 — History de descargas persistente + reconcile de huérfanas

**Fecha:** 2026-06-18 · **Estado:** Accepted · Implementa el chunk 2 de [ADR-011](#adr-011--history-de-descargas-en-memoria-chunk-1)

### Contexto
La cola de descargas vivía en memoria (un contador `AtomicI64` para el `download_id`) y se perdía al cerrar la app (ADR-011 chunk 1). La tabla `downloads` existía desde Fase 0 pero no se usaba. Se pidió historial persistente entre sesiones.

### Decisión
Persistir el ciclo de vida en la tabla `downloads`:
- **insert** al arrancar (status `downloading`) → el **id de la fila ES el `download_id`** de los eventos (elimina el contador en memoria).
- **finish** al terminar: estado terminal + `title`/`error`/`track_id`/`playlist_id` + `completed_at`.
- **list_recent** carga el historial al boot.
- **Reconcile al boot** (en `db::init`): filas en estado no-terminal (`downloading`/`postprocessing`/`queued`) de una sesión previa → `failed` ("interrumpido"). El proceso yt-dlp ya no existe y el estado no se puede reanudar, así que sin esto quedarían "pegadas" en `downloading` para siempre.
- **Limpieza de `_pending` al boot**: borra los temporales (`.part`) huérfanos de descargas canceladas/interrumpidas; al boot no hay descargas corriendo, así que es seguro.

### Razón
- El id de DB como `download_id` evita mantener un contador paralelo y vincula evento↔fila naturalmente.
- El progreso en vivo NO se persiste (es efímero, vive en el frontend) — sólo el registro durable (url, título, estado, track, fecha). Escribir cada tick de progreso a la DB sería ruido inútil.
- El reconcile es la pieza clave de UX: sin él, una app cerrada a mitad deja una fila zombie visible en cada boot.

### Consecuencias
- **Pro:** historial entre sesiones; descargas de lista expandibles (guardan `playlist_id` → lazy-load de tracks); fecha por fila.
- **Contra:** migraciones aditivas (`downloads.title`, `downloads.playlist_id`).
- **Contra:** una descarga interrumpida se marca `failed` (no hay status "interrupted" dedicado) — el mensaje lo aclara.
- Cross-ref: [LYRICS.md] N/A. Detalle en `db/downloads.rs` + `commands/downloader.rs`.

## ADR-032 — Cancelar descarga conservando parciales

**Fecha:** 2026-06-18 · **Estado:** Accepted

### Contexto
Una descarga de lista larga no se podía detener — no había forma de cancelar el yt-dlp en curso.

### Opciones consideradas
1. **Cancelar y descartar todo lo parcial.** Simple, pero perder los N tracks ya bajados de una lista larga es frustrante.
2. **Cancelar conservando los parciales.** Los tracks que ya terminaron quedan en la library + la playlist.

### Decisión
**Opción 2.** Un canal `oneshot` por `download_id` (estado `DownloadCancels` manejado por Tauri) + comando `download_cancel`. `run_yt_dlp` hace `tokio::select!` entre las líneas de yt-dlp y la señal; al cancelar, mata el proceso (`child.start_kill()`) y drena lo que quede. Los entries que ya emitieron `done` se persisten (reusa la lógica de éxito parcial) → la descarga termina como `Cancelled` con sus parciales; si era lista, la playlist se crea con lo bajado.

### Razón
- Conservar lo bajado respeta el trabajo ya hecho; **re-descargar la misma lista reanuda** (el dedup por path + fingerprint saltea lo ya presente).
- `select!` requiere habilitar el feature `macros` de `tokio` (era `process`+`io-util`).

### Consecuencias
- **Pro:** cancelación inmediata sin perder lo descargado.
- **Contra:** el track a-medio-bajar deja temporales en `_pending` (limpiados al boot, ver ADR-031).
- Nuevo status `Cancelled` en el contrato `Download` (UI: "CANCELLED").

## ADR-033 — Import por drag & drop via drag-drop nativo de Tauri

**Fecha:** 2026-06-18 · **Estado:** Accepted

### Contexto
Quick win: importar archivos arrastrándolos a la ventana, sin pasar por SCAN DIRECTORY. Hay **tres mecanismos de "arrastre"** posibles y conviene dejar claro cuál se usa para qué (porque ya pagamos el de HTML5).

### Decisión
Usar el **drag-drop nativo de Tauri** (`getCurrentWebview().onDragDropEvent`), que entrega los **paths reales del filesystem** en el evento `drop`. `dragDropEnabled` queda en `true` (default de Tauri). Nuevo comando `library_import_paths(paths)` que reusa `import_one_file` (mismo insert idempotente que el scan: archivos directo, carpetas recursivo). Overlay brutalist "DROP TO IMPORT" mientras se arrastra.

### Los tres "drags" del proyecto (coexisten)
1. **HTML5 DnD del webview** (`draggable` + `onDrop`): **NO funciona** en WKWebView (ver Gotcha #17 / [ADR-027](#adr-027--reorder-de-playlist-via-pointer-events-no-html5-dnd)). No se usa.
2. **Pointer events** (`pointerdown`/`move`/`up`): el **reorder de playlist** (ADR-027). Manual, dentro del DOM.
3. **Drag-drop nativo de Tauri**: drop de **archivos del SO** → da paths. Es el de este ADR. No choca con (1)/(2): con `dragDropEnabled=true` el HTML5 drop del webview se desactiva, pero igual no lo usábamos.

### Consecuencias
- **Pro:** cero fricción para sumar música; idempotente (re-soltar = SKIPPED, no duplica); funciona desde cualquier tab.
- **Contra:** el `ScanReport` (FOUND/NEW) sólo es visible en el toolbar de LIBRARY; un drop desde otra tab importa "en silencio" (el overlay confirma el drop).
- Requiere `core:default` en capabilities (ya estaba) para los eventos del webview.

## ADR-034 — Smart playlists: motor multi-regla con query builder dinámico

**Fecha:** 2026-06-18 · **Estado:** Accepted

### Contexto
Las smart playlists (último quick win de playlists) muestran tracks que matchean criterios en vez de una lista manual. Decisión de alcance acordada con Bryan: **motor multi-regla (AND/OR)**, no presets fijos ni una sola condición. Hay que (a) modelar y persistir reglas arbitrarias, (b) traducirlas a SQL sin abrir superficie de inyección, (c) integrarlas con la infra de playlists existente (sidebar, queue, export M3U) sin duplicar todo.

### Decisión
- **Schema:** dos columnas en `playlists` — `is_smart INTEGER DEFAULT 0` + `rules TEXT` (JSON). Una smart playlist **no tiene filas en `playlist_tracks`**; su membresía se recalcula corriendo una query cada vez. (Vs una tabla `smart_playlists` aparte: reusa todo lo de `playlists` — sidebar, rename, delete, `playlist_get_tracks`, export M3U — con un branch mínimo.)
- **Shape de reglas:** `{"match":"all"|"any","conditions":[{"field","op","value"}]}`. Campos: `title/artist/album/genre` (text), `year/play_count` (numérico), `added_within_days/played_within_days` (fecha relativa).
- **Query builder ([db/smart.rs](../src-tauri/src/db/smart.rs)):** `sqlx::QueryBuilder` arma el WHERE dinámico. **Whitelist estricta**: el nombre de columna sale de un `match` contra literales conocidos; los valores del usuario **siempre** van por `push_bind` (`?`), nunca interpolados. Una condición con field/op no soportado o número no parseable se **descarta**; si no queda ninguna válida, la query devuelve `WHERE 1=0` (0 filas, no toda la library).
- **Integración:** `list_tracks` ramifica — si `is_smart`, evalúa reglas; si no, el JOIN manual de siempre. `getQueue()` (NEXT/PREV/shuffle) y `playlist_export_m3u` pasan por `list_tracks` → funcionan en smart sin cambios. El count del sidebar evalúa las reglas (N+1 queries, aceptable en una library personal).
- **UI:** botón `+ SMART ⚡` en el sidebar abre `SmartPlaylistModal` (editor de condiciones: match all/any + filas field·op·value). Marcador ⚡ + acción EDIT en las filas smart. `LibraryTable` deshabilita reorder y la columna +/− (membresía read-only); el popover "add to playlist" filtra las smart.

### Razón
- Reusar `playlists` minimiza el código nuevo y mantiene una sola noción de "playlist" en el resto de la app.
- Whitelist + binds: aunque el JSON venga del usuario (y mañana de un import), no hay inyección posible. Cubierto con unit tests del SQL generado (sin tocar la DB).
- Descartar condiciones inválidas en vez de fallar evita que una regla rota tumbe toda la playlist.

### Consecuencias
- **Pro:** filtros potentes y siempre actualizados; export M3U y navegación de cola gratis.
- **Contra:** el count del sidebar hace una query por smart playlist (no escala a cientos, pero no es el caso de uso); el editor es funcional-brutalist, no drag-and-drop de reglas.
- Migración `20260618000003_smart_playlists.sql` aditiva (las playlists existentes quedan `is_smart=0`).

### Caveat de datos (hallazgos 2026-06-18, al probar el feature)
El motor anda; la utilidad de cada campo depende de cuán poblado esté en la
library. Dos campos hoy **no son útiles** en una library bajada de YouTube:
- **`genre`**: yt-dlp escribe la *categoría* de YT ("Music", "People & Blogs"),
  no el género musical → casi todo queda `genre="Music"`. Una regla
  `genre is Electronic` matchea 0 tracks (correctamente). **Resuelto parcial
  (2026-06-18) en [ADR-035](#adr-035--identify-extendido-mb-metadata-genre--year--album--cover-art-archive)**:
  para tracks identificados (con MBID), MB BACKFILL pega a MusicBrainz y
  trae genre real desde tags + genres curados. Tracks no-identificados
  siguen necesitando tagging manual. Ver Gotcha #11.
- **`play_count` / `last_played_at`**: **nunca se incrementan** — reproducir un
  track no hace el `UPDATE` correspondiente (gap pendiente, ver PLAN). Hasta que
  se implemente, las reglas `play_count` y `played_within_days` quedan muertas
  (todo en 0). Es lo que habilitaría un "Most Played" real.

Los campos que **sí** funcionan con datos de YT: `artist`, `title`, `year`
(viene del upload date / metadata) y `added_within_days` (lo seteamos nosotros
al importar).

---

## ADR-035 — Identify extendido: MB metadata (genre + year + album) + Cover Art Archive

**Fecha:** 2026-06-18 · **Estado:** Accepted

### Contexto
El identify cascade (AcoustID → fingerprint → MBID) traía sólo title + artist canónicos. El resto de metadata (`genre`, `year`, `album`, `cover_art_path`) seguía contaminado de yt-dlp:
- `genre` = categoría de YouTube ("Music", "People & Blogs") — inútil para smart playlists ([ADR-034 caveat](#adr-034--smart-playlists-motor-multi-regla-con-query-builder-dinámico)).
- `year` = upload date del video, no fecha de release.
- `album` = vacío en la mayoría de descargas yt-dlp.
- `cover_art_path` = embedded del archivo (a veces es el thumbnail del video, no la portada del álbum) o NULL.

AcoustID/MusicBrainz tienen toda esta data. AcoustID expone `meta=tags` pero los tags via AcoustID son sparse; **MusicBrainz directo** (con el MBID que ya tenemos) tiene tags + genres curados + releases + release-groups en una sola request.

### Decisión
Después de AcoustID, hacer **un segundo request a MusicBrainz** (`GET /ws/2/recording/{mbid}?inc=tags+genres+releases+release-groups&fmt=json`) que devuelve genre + year + album + release_group_mbid en un solo round-trip. Si el track no tiene cover, hacer un **tercer request a Cover Art Archive** (`GET https://coverartarchive.org/release-group/{mbid}/front`) para descargar la portada frontal canónica.

Estructura nueva: `MbRecordingMetadata { genre, year, album, release_group_mbid }` en [musicbrainz.rs](../src-tauri/src/identification/musicbrainz.rs); módulo aparte [coverartarchive.rs](../src-tauri/src/identification/coverartarchive.rs) para CAA.

### Lógica de selección del release-group "canónico"
Un recording suele estar en N releases (singles, álbum, compilados, soundtracks, ediciones especiales). Conservador:
1. Filtrar release-groups con `primary-type = "Album"`.
2. Si hay → el de `first-release-date` más temprano gana.
3. Si no hay (track que sólo existió como single) → caer al earliest de cualquier tipo.
4. Dedup por release-group id antes de elegir (mismo álbum reaparece en N releases).
5. Year = primer 4 chars del `first-release-date` con sanity `1900..=2100`.

### Lógica de selección de género
1. Preferir `genres` curados de MB (post-2018, lista limpia).
2. Caer a `tags` (folksonomic) filtrando stopwords (`favorite`, `lol`, `memories`...) + décadas (`90s`, `1990s`...).
3. Top por `count`, lowercase.

### Throttle conjunto MB + CAA
MusicBrainz anonymous = 1 req/seg estricto. CAA no documenta cap pero pide no agredir. El backfill **hace MB + CAA dentro del mismo intervalo de 1.05s** — no duplicamos el rate. Bulk de 100 tracks ≈ 1m45s.

### Backfill: criterio amplio
`list_for_mb_backfill` filtra tracks con MBID set Y al menos uno de:
- `genre` NULL / vacío / `'Music'`
- `year` NULL
- `album` NULL / vacío
- `cover_art_path` NULL

Tracks con TODO ya bien populado se omiten — re-runs son rápidos. set_mb_metadata respeta los campos que el usuario tenía (CASE WHEN != ''): si MB devuelve None/empty, dejamos el valor existente.

### Razón
- Una sola request MB cubre tres campos vs hacer una por campo.
- CAA aprovecha el `release_group_mbid` ganador para portada canónica sin esfuerzo extra de selección.
- Throttle conjunto evita over-engineering de doble pool con cap distinto.
- Conservador: si MB no tiene el dato, no pisamos lo que estaba (importante para tracks taggeados a mano).

### Consecuencias
- **Pro:** `genre` empieza a funcionar para smart playlists; `year` real (release vs upload); `album` poblado; covers canónicos donde el embedded era el thumbnail YT.
- **Pro:** 9 tests unitarios en [musicbrainz.rs](../src-tauri/src/identification/musicbrainz.rs) cubren las branches de la selección.
- **Contra:** cada identify ahora hace ~2 requests extra (MB + CAA). Para single-track es invisible; para bulk añade ~1s/track adicional (el cap MB es lo dominante de todas formas).
- **Contra:** cobertura desigual — covers CAA ~50-60% (depende de uploads voluntarios), genre ~70-80% para mainstream, album ~80-90%. No es solución 100%.
- Botón GENRE BACKFILL → renombrado a **MB BACKFILL**; eventos `genre-backfill-*` → `mb-backfill-*`.

### Edge cases manejados
- MB 404 (recording mergeada/borrada) → `MbRecordingMetadata::default()`, identify principal no se cae.
- CAA 404 (sin portada en archive) → silencioso, métrica `no_data`.
- Release sin `first-release-date` → year=None, album sigue persistiéndose si hay título.
- Recording sin releases (raro pero MB lo permite) → genre puede venir igual, año/álbum quedan None.
- Cover Content-Type → `.png` si PNG, `.jpg` para todo lo demás (default conservador).

---

## ADR-036 — Smart playlists: picker cascadante + operador `in`/`not_in`

**Fecha:** 2026-06-18 · **Estado:** Accepted

### Contexto
El editor de smart playlists ([ADR-034](#adr-034--smart-playlists-motor-multi-regla-con-query-builder-dinámico)) usaba inputs de texto libre. Problemas observados:
- El usuario tenía que **escribir literal** el valor — "Electronica" vs "electronic" rompe el match aunque visualmente parezca lo mismo.
- No había forma de seleccionar **múltiples valores** sin armar N reglas (`artist=A OR artist=B OR artist=C` requería 3 condiciones, cada una con su sin/conjunción).
- Sin descubrimiento de qué valores **realmente existen** en la library — el usuario adivinaba.

Una típica intención del usuario era **componer por niveles**: "tracks con genre `electronica` o `dance` Y artist en {Daft Punk, Justice}". Hoy era engorroso; armaba 5 reglas y rezaba.

### Decisión
1. **Operador nuevo `in` / `not_in`** en el smart engine. El value es JSON array (`["grunge","electronic"]` para text, `[1990, 2000]` para numérico). SQL: `t.{col} IN (?, ?, ?)` con `push_bind` por valor. `1=0` cuando array vacío.

2. **Componente `MultiSelectPicker`** brutalist: search input + scrollable checkboxes + counter "X / Y SELECTED" + CLEAR. Sin `<input type="checkbox">` nativo — cuadrado 12×12 con borde (consistencia visual).

3. **Comando `playlist_smart_distinct_values(field, prefilter_rules_json)`**: devuelve los valores únicos de un campo, opcionalmente filtrados por reglas previas (cascade). Excluye condiciones del mismo `field` (el usuario está editando ESE field, no querés auto-restringir).

4. **Cascade en modo `all` (AND)**: el picker de la condición N hace prefilter con las condiciones `0..N-1`. En modo `any` (OR), no hay prefilter (cada regla es independiente — restringir sería incorrecto semánticamente). Hint visible en el header cuando aplica.

5. **Default `op = in`** para text y numeric fields. Operadores libres (`contains`, `is`, `gt`, etc.) siguen disponibles cambiando el select — útil para substring match o valores no listados (genre raros, typos intencionales).

### Razón
- Picker > input libre por **descoverabilidad**: el usuario ve qué hay sin tener que recordar.
- Cascade aprovecha la naturaleza de `AND`: si ya filtraste por género, el picker de artist te muestra **solo los artistas relevantes a esos géneros** → workflow natural "first I pick the area, then I refine".
- `in` operator evita N reglas para "uno de varios" — semántica más clara que `OR` anidado.
- Conservar text-libre da escape hatch: para `title contains "remix"` o casos edge.

### Whitelist + binds: ¿sigue seguro?
Sí. El nuevo `in` op usa `push_bind` por cada elemento del array, igual que el resto del engine. La whitelist de campos no cambió. JSON inválido en `value` → 0 elementos → `1=0`. Imposible inyectar SQL.

### Consecuencias
- **Pro:** smart playlists complejas son fáciles ahora — el flujo del modal acompaña el pensamiento del usuario.
- **Pro:** el picker poblado con datos reales sirve también de **explorador de la library**: si tu picker de `artist` muestra 200 nombres, podés ver la diversidad. Si solo muestra 5, sabés que tu library es chica en ese ángulo.
- **Pro:** el cascade es coherente con la semántica AND/OR — sin sorpresas.
- **Contra:** el picker hace un request por cada condición que abre. Con N condiciones tipo `in`, son N requests al modal abrir. Cacheado por `(field + prefilter_json)` en frontend → cambiar una sola condición invalida solo lo que comparte el prefilter.
- **Contra:** orphan values (valor seleccionado que ya no aparece en el prefilter actual) se renderizan al tope con marker `?` — para que el usuario los vea y pueda destildarlos. Sin esto, valores "ocultos" silenciosamente arruinaban la intuición.

### Compatibilidad con smart playlists existentes
Editar una playlist creada con el formato viejo (`op=is`, value escalar) sigue funcionando. El modal arranca con la condición tal cual quedó persistida; el usuario puede cambiarla a `in` si quiere expandir.

---

## ADR-037 — Pixi como gestor de dependencias ML/sistema

**Estado: `Proposed`** · 2026-06-19

### Contexto
La app tiene 9+ dependencias del sistema repartidas en tres categorías:
- **Core downloader**: yt-dlp, ffmpeg, node ≥22
- **Identification**: fpcalc (Chromaprint)
- **ML/karaoke**: whisperx, faster-whisper, phonemizer, espeak-ng, PyTorch

Hoy cada dep se instala manualmente (`brew`, `pip`, `pipx`, instalador .exe)
y la app detecta su presencia con `which` + fallback paths. El onboarding es
pesado: un usuario nuevo necesita ~7 comandos en terminal para tener todo
funcionando. La detección de deps es inconsistente (3 patrones distintos:
banner, `alert()`, botones invisibles).

### Opciones evaluadas

| | Setup script | Conda/Miniforge | Pixi | Docker |
|---|---|---|---|---|
| Aislamiento | Ninguno | Env virtual | Env virtual | Container |
| Peso base | 0 | ~100MB | ~30MB (binario) | ~4GB Docker Desktop |
| Cross-platform | 2 scripts (ps1/sh) | 1 `environment.yml` | 1 `pixi.toml` | 1 Dockerfile |
| Instala deps sistema | Asume admin/brew/choco | Sí (conda-forge) | Sí (conda-forge) | Sí (dentro container) |
| Curva usuario | Baja pero frágil | Media | Baja (1 binario, 1 comando) | Alta |
| Redistribuible | N/A | Sí (BSD) | Sí (BSD 3-Clause) | Sí |

### Decisión propuesta
**Pixi** (prefix.dev) como gestor de dependencias, invocado como sidecar
desde Tauri. Binario único (~30MB comprimido, BSD 3-Clause), mismos paquetes
de conda-forge que conda/mamba pero sin instalación base.

Flujo propuesto para el usuario:
1. Instala la app (MSI/DMG normal).
2. First-run: la app detecta que no tiene el environment ML.
3. Botón "SETUP ML FEATURES" (o wizard automático).
4. Internamente: `pixi install` con el `pixi.toml` del proyecto.
5. Descarga PyTorch + whisperx + deps (~2-4GB, una sola vez).
6. Scripts corren vía `pixi run python script.py`.

### Investigación: disponibilidad en conda-forge

| Paquete | conda-forge | PyPI | Sección en pixi.toml |
|---------|-------------|------|----------------------|
| pytorch | ✅ (CPU) | ✅ | `[dependencies]` |
| ffmpeg | ✅ | — | `[dependencies]` |
| nodejs ≥22 | ✅ | — | `[dependencies]` |
| libchromaprint (fpcalc) | ✅ | — | `[dependencies]` |
| yt-dlp | ✅ | ✅ | `[dependencies]` |
| whisperx | ❌ | ✅ | `[pypi-dependencies]` |
| faster-whisper | ❌ | ✅ | `[pypi-dependencies]` |
| phonemizer | Parcial (fork) | ✅ | `[pypi-dependencies]` |
| **espeak-ng** | **❌** | **—** | **⚠️ NO CUBIERTO** |

### pixi.toml borrador (con environments selectivos)

El usuario elige qué features instalar. Pixi soporta environments múltiples
en el mismo `pixi.toml` — cada uno baja solo lo necesario.

```toml
[project]
name = "media-player-deps"
version = "0.1.0"
description = "ML and system dependencies for Brutalist Music Player"

[feature.core.dependencies]
ffmpeg = "*"
yt-dlp = "*"
nodejs = ">=22"
libchromaprint = "*"
# ~200MB — descarga, identificación, playback

[feature.ml.dependencies]
python = ">=3.11,<3.13"
pytorch-cpu = "*"
[feature.ml.pypi-dependencies]
whisperx = { git = "https://github.com/m-bain/whisperx.git" }
faster-whisper = "*"
phonemizer = "*"
# ~2-4GB — karaoke, auto-align, mismatch detection

[environments]
core = ["core"]
full = ["core", "ml"]
```

### Wizard de first-run propuesto

La app no mete texto en el instalador (MSI/DMG). El setup ocurre dentro de
la app en un wizard de first-run:

```
SETUP FEATURES

[x] CORE (required)              ~200MB
    Downloads, identification, playback
    yt-dlp, ffmpeg, node, fpcalc

[ ] ML / KARAOKE (optional)      ~2-4GB
    Auto-align, quality check, mismatch detection
    whisperx, PyTorch, phonemizer

         [INSTALL SELECTED]
```

El usuario elige, Pixi baja solo lo seleccionado. Si después quiere ML,
vuelve al wizard (Settings o similar) y lo agrega incrementalmente.

### Pixi como "Docker light"

Pixi NO es un container — no virtualiza OS ni filesystem. Crea un ambiente
aislado (carpeta `.pixi/`) con binarios nativos y ajusta PATH para que los
scripts los encuentren. Sin overhead de virtualización, sin Docker Desktop.
Borrar `.pixi/` desinstala todo limpio.

### Banderas rojas

1. **espeak-ng NO está en conda-forge ni en PyPI.** Es una librería C/C++
   que necesita instalación a nivel sistema. Opciones:
   - El wizard de la app guía al usuario para instalarlo (link al installer).
   - Fallback: CHECK QUALITY cae a comparación de texto raw (ya funciona).
   - Investigar si se puede compilar como recurso bundleado (espeak-ng es
     ~2MB compilado).

2. **whisperx no está en conda-forge** — hay que usar `[pypi-dependencies]`
   con git URL, lo cual mezcla resolución conda + pip. Pixi lo soporta
   (resuelve conda primero, luego pip), pero es un punto de fricción
   potencial.

3. **Pixi es 0.x** (v0.70.2 a junio 2026). Estable y production-ready
   según los autores, pero sin garantía formal de estabilidad de API.
   Cambios de formato del lockfile son posibles.

4. **Peso del environment**: PyTorch CPU + whisperx + deps = ~2-4GB. Esto
   es ineludible con cualquier solución (Docker, conda, pixi, pip). El
   usuario necesita saberlo antes del download.

5. **pixi-pack** (alternativa): puede crear archives auto-extraíbles con
   todo pre-resuelto. Evita el download de 2-4GB en la máquina del usuario
   si nosotros lo pre-empaquetamos. Trade-off: el archive pesa ~2-4GB y
   hay que generarlo por plataforma (win/mac/linux × x86/arm).

### Integración con Tauri

El binario de pixi se redistribuye como sidecar o resource de Tauri. La
invocación cambia de:
```rust
// Antes
let python = find_python_for_whisperx()?;
Command::new(python).arg(script_path)...
```
a:
```rust
// Después
let pixi = resolve_pixi_binary()?;
Command::new(pixi)
    .args(["run", "python", script_path.to_str().unwrap()])
    .current_dir(pixi_project_dir)...
```

`resolve_binary` para yt-dlp/ffmpeg/fpcalc/node también puede apuntar al
environment de pixi, unificando la resolución de deps.

### Consecuencias
- **Pro:** onboarding de 7 comandos manuales → 1 click en la app.
- **Pro:** aislamiento total — no contamina el Python del sistema.
- **Pro:** cross-platform con un solo `pixi.toml`.
- **Pro:** licencia BSD 3-Clause permite redistribuir el binario.
- **Contra:** espeak-ng queda fuera — necesita solución aparte.
- **Contra:** ~30MB extra en el bundle del instalador (el binario de pixi).
- **Contra:** environment pesa ~2-4GB (ineludible, pero hay que comunicarlo).
- **Contra:** Pixi es 0.x — riesgo bajo pero no nulo de breaking changes.

### Resolución de banderas rojas

**espeak-ng (no en conda-forge ni PyPI)** — dos acciones en paralelo:
1. **Corto plazo: bundlear como resource de Tauri.** espeak-ng compilado
   pesa ~2-3MB. Se shipea con la app directamente, sin pasar por pixi.
   El script `mismatch_detect.py` ya tiene fallback: si espeak-ng no está,
   cae a comparación de texto raw. Con el bundle, siempre está disponible.
2. **Contribución comunitaria: crear feedstock para conda-forge.** PR a
   `conda-forge/staged-recipes` con `meta.yaml` para compilar espeak-ng.
   Trabajo inicial ~2-4h, después conda-forge mantiene builds automáticos
   por plataforma. Beneficia a toda la comunidad (phonemizer, TTS, etc.).
   Una vez aceptado, se agrega a `[dependencies]` del `pixi.toml` y se
   elimina el bundle manual.

**whisperx no en conda-forge** — se usa `[pypi-dependencies]` con git URL.
Pixi resuelve conda primero (PyTorch, ffmpeg) y luego pip (whisperx). Esto
funciona pero es un punto de fricción: pip puede intentar reinstalar PyTorch
desde PyPI (CPU-only wheel) si las versiones no coinciden con lo que conda
instaló. Mitigación: pinear `torch` en `[dependencies]` de conda para que
pip lo vea como ya satisfecho.

**Pixi 0.x** — v0.70.2 a junio 2026, production-ready según autores pero
sin 1.0 formal. Riesgo bajo: el formato `pixi.toml` es estable, los
lockfiles son versionados, y la comunidad (QuantCo, varios corporates) ya
lo usa en producción. Mantener lockfile en git para reproducibilidad.

### TODO antes de aceptar
- [ ] Validar que `pixi install` con el `pixi.toml` borrador funcione en
      Windows y macOS (crear el toml, correrlo, verificar que whisperx
      importa y los scripts ejecutan).
- [ ] Medir tiempo de `pixi install` cold (primera vez) y warm (cache).
- [ ] Probar `pixi run python mismatch_detect.py` end-to-end.
- [ ] Bundlear espeak-ng como resource de Tauri (libespeak-ng.dll /
      libespeak-ng.dylib / libespeak-ng.so + data files).
- [ ] Crear feedstock espeak-ng para conda-forge (PR a staged-recipes).
- [ ] Evaluar pixi-pack como alternativa al download on-demand.
- [ ] Verificar que pip no reinstale PyTorch dentro del env de pixi
      (conflicto conda vs pip).
- [ ] Medir overhead de `pixi run` por invocación (vs llamar python
      directo). Si >1s, evaluar activar el env una vez y cachear el path.
- [ ] Diseñar wizard de first-run con estimación de tamaño visible,
      progress bar, y posibilidad de cancelar.
- [ ] Probar environments selectivos (`core` vs `full`) — que instalar
      `core` no baje PyTorch.

