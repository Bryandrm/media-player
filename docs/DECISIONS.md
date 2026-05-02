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
