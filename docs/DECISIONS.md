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

**Fecha:** 2026-04-30 · **Estado:** Accepted

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
