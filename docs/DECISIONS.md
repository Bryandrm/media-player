# Decisions — Brutalist Music Player

> Registro vivo de decisiones técnicas y de producto. Formato ADR ligero.
> **Estados posibles:** `Proposed` · `Accepted` · `Rejected` · `Superseded by ADR-NNN`.
> Una decisión cambia de estado, no se borra. Si se revierte, se marca `Superseded` y se añade una nueva.

---

## Índice

| ID | Título | Estado |
|----|--------|--------|
| ADR-000 | Tauri 2 como shell desktop | Accepted |
| ADR-001 | ORM / driver para SQLite | Proposed |
| ADR-002 | Bundle vs detección de yt-dlp y ffmpeg | Proposed |
| ADR-003 | Font family definitiva | Proposed |
| ADR-004 | Color acento | Proposed |
| ADR-005 | Titlebar nativa vs custom | Proposed |
| ADR-006 | Zustand como store global de React | Accepted |
| ADR-007 | Generación de tipos Rust ↔ TypeScript | Proposed |

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
- Diferencias de renderizado entre WebView de cada OS (WebKit macOS, WebView2 Windows, WebKitGTK Linux) — validar visualizer en los tres.
- Menos recursos de comunidad que Electron ante problemas raros.

---

## ADR-001 — ORM / driver para SQLite

**Fecha:** 2026-04-20 · **Estado:** Proposed

### Contexto
Necesitamos acceder a SQLite desde Rust con migraciones y queries tipadas.

### Opciones
1. **`sqlx`** — async, macros check queries at compile-time, incluye `sqlx migrate`. Curva mayor.
2. **`rusqlite`** — sync, crudo, simplísimo, sin migraciones built-in (combinar con `refinery`).
3. **`diesel`** — schema-first, DSL, más opinionado, sync (o async con `diesel-async`).

### Criterios
- Simpleza en fase de aprendizaje de Rust.
- Soporte nativo de migraciones.
- No obligarnos a escribir DSL custom.

### Propuesta actual
`sqlx` — balance de tipado, migraciones integradas, comunidad grande. Revisar en Fase 0 tras escribir las primeras 3-4 queries. Si la verificación en tiempo de compilación se vuelve fricción, degradar a `rusqlite` + `refinery`.

### Consecuencias si se acepta
- Requiere `DATABASE_URL` en entorno de build para compile-time checks (o usar `query!` con modo offline: `cargo sqlx prepare`).
- Async en todo el backend — Tauri ya es async-friendly.

---

## ADR-002 — Bundle vs detección de yt-dlp y ffmpeg

**Fecha:** 2026-04-20 · **Estado:** Proposed

### Contexto
La app depende de dos binarios externos. Hay que decidir cómo llegan a la máquina del usuario.

### Opciones
1. **Bundle** (binarios dentro del instalador):
   - Pro: zero-setup para el usuario.
   - Contra: peso (+40MB), licencias (ffmpeg es LGPL/GPL según build), mantener actualizaciones.
2. **Detectar + guiar**:
   - Pro: peso mínimo, licencias limpias, siempre binarios actualizados.
   - Contra: fricción en primer arranque, imposible en ambientes sin admin rights.
3. **Híbrido**: detectar primero, ofrecer descarga dentro de la app si no existe.

### Propuesta actual
Opción 2 para Fase 1 — wizard al primer arranque que corre `system_check_dependencies` y muestra instrucciones por OS con botón "Re-check".
Reconsiderar opción 3 en Fase 2 si hay señales de que el setup wizard es demasiada fricción.

### Consecuencias
- El disclaimer legal es más limpio (no distribuimos yt-dlp).
- El primer arranque no es "plug and play". Aceptable para portfolio piece.

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
Evitar Archivo Black hasta tener un mockup que realmente la necesite — tiende a sabotear legibilidad cuando se abusa.

### Pendiente
Validar en mockup real con tracks listados antes de cerrar.

---

## ADR-004 — Color acento

**Fecha:** 2026-04-20 · **Estado:** Proposed

### Contexto
Un solo color acento en toda la app (principio brutalist del PLAN).

### Opciones
- Naranja `#FF3B00` (referencia Winamp).
- Amarillo ácido `#FFFF00`.
- Verde terminal `#00FF41`.

### Consideraciones
- El naranja tiene narrativa (Winamp = legado del visualizador).
- El amarillo sobre blanco tiene contraste pésimo — descartar para light mode.
- El verde empuja la identidad a "hacker aesthetic" que puede colisionar con audio.

### Propuesta actual
Naranja `#FF3B00` como default, con una variable CSS para que sea cambiable en `settings` (feature menor, Fase 2).

---

## ADR-005 — Titlebar nativa vs custom

**Fecha:** 2026-04-20 · **Estado:** Proposed

### Contexto
Tauri permite decorar la ventana con titlebar nativa o renderizar una propia.

### Opciones
1. **Nativa** — gratis, respeta convenciones OS, pero rompe la estética brutalist en macOS (tráfico semáforo) y Windows (chrome redondeado).
2. **Custom** — control total, consistente cross-OS, requiere implementar drag-to-move, botones de ventana y manejo de maximizar/minimizar/cerrar.

### Propuesta actual
Custom. La coherencia visual es parte central de la identidad del proyecto. Implementar en Fase 1 tardío — no bloquea el MVP funcional.

### Consecuencias
- Más trabajo de UI. Vigilar regresiones en Windows (focus handling, snap layouts).
- Posibilidad de bug que deje la ventana "atrapada" fuera de pantalla — añadir hotkey de reset.

---

## ADR-006 — Zustand como store global de React

**Fecha:** 2026-04-20 · **Estado:** Accepted

### Contexto
Necesitamos estado global para player, library, downloads, UI.

### Opciones
- **Redux Toolkit** — boilerplate, ecosistema, overkill para este tamaño.
- **Zustand** — ~1KB, API minimal, selectors nativos, sin providers.
- **Context + useReducer** — funciona pero re-renderiza agresivamente.

### Decisión
Zustand. Liviano, sin provider hell, permite slices por dominio.

### Consecuencias
- Sin DevTools de Redux — Zustand tiene un plugin para Redux DevTools, usarlo.
- Tests de stores triviales (son funciones puras).

---

## ADR-007 — Generación de tipos Rust ↔ TypeScript

**Fecha:** 2026-04-20 · **Estado:** Proposed

### Contexto
Los payloads de `invoke`/`emit` se definen en Rust y se consumen en TS. Mantener tipos sincronizados a mano es frágil.

### Opciones
1. **`ts-rs`** — deriva `#[derive(TS)]` genera `.ts` al correr tests.
2. **`specta` + `tauri-specta`** — diseñado para Tauri, genera cliente tipado completo.
3. **Manual** — escribir tipos dos veces, cero dependencias.

### Propuesta actual
`tauri-specta`. Elimina el riesgo de drift y genera wrappers tipados sobre `invoke`.

### Pendiente
Probarlo en Fase 0 con 2-3 comandos reales. Si la generación introduce fricción, fallback a `ts-rs` (menos mágico).
