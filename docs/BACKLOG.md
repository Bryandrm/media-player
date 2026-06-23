# BACKLOG

> Tareas de desarrollo formalizadas. Vista única para revisar y priorizar.
> Los detalles técnicos profundos viven en los docs de dominio
> ([LYRICS](./LYRICS.md), [KARAOKE](./KARAOKE.md),
> [IDENTIFICATION](./IDENTIFICATION.md), [DECISIONS](./DECISIONS.md)); acá va el
> **qué + por qué + scope**, con link a la bandera de origen.
>
> Convención de estado: `[ ]` no iniciada · `[~]` en progreso · `[x]` cerrada.

---

## Priorización acordada (2026-06-23)

Orden sugerido, pesando las banderas (a aplicar **más adelante**, primero se
cierra la documentación):

1. **T1 — Módulo de edición de lyrics** (cierra la bandera de UX más arrastrada;
   mucha de la data ya existe → buen leverage/esfuerzo).
2. **Karaoke Fase B** (fullscreen) — el siguiente gran hito, lucible para
   portfolio. Vive en [KARAOKE.md §Fase B](./KARAOKE.md).

El resto se intercala según aparezca la necesidad real.

---

## Lyrics

### [ ] T1 — Módulo dedicado de edición de lyrics  ⭐ (bandera #1)

**Origen:** [LYRICS.md §Bandera de UX](./LYRICS.md) — "actuar automáticamente
sobre mismatches". Bryan quiere unificar todo el journey de edición/corrección
de letras en **un módulo específico** en vez de la "escalera de emergencia"
actual (el modal de manual-edit de 2.c.1).

**Por qué es una sola tarea grande:** hoy las piezas están dispersas (modal de
edición, CHECK QUALITY que detecta líneas malas, AUTO-ALIGN, offset/speed,
RE-ALIGN). El usuario las opera sueltas. Esta tarea las junta en un flujo
coherente de "editar y arreglar la letra de este track".

**Scope (a refinar antes de arrancar):**
- **Flag visual de líneas malas** en el panel de lyrics — reusa
  `lyrics.mismatch_score` + el score per-línea que ya persiste CHECK QUALITY
  (migración `20260621000001`). Marcar las líneas con score bajo (<50%) para que
  el usuario sepa qué editar sin adivinar.
- **Auto-refetch** de otro provider cuando la confidence/score es baja (cerrar
  el loop del smart cascade 2.c.4a: hoy detecta, falta actuar).
- **Editor línea-por-línea** con timestamps (más allá del textarea synced/plain
  actual): editar texto + ajustar el timestamp de una línea puntual, re-align
  selectivo de un rango.
- **Integración con "Contribute to LRCLIB"** (ver T2) como paso final del flujo.

**Estado:** definida, no iniciada. Es la recomendación #1 de priorización.

---

### [ ] T2 — "Contribute to LRCLIB"  (bandera #2)

**Origen:** [LYRICS.md §Bandera de UX, punto 5](./LYRICS.md).

Tras un AUTO-ALIGN / edición manual exitosa, ofrecer un botón
**"Contribute to LRCLIB"** que suba el LRC corregido a la comunidad (LRCLIB
tiene endpoint de publish con challenge token). Cero esfuerzo extra para el
usuario, beneficio compuesto: el fix beneficia a la comunidad y mejora la
cobertura futura.

**Scope:** comando Rust `lyrics_contribute(track_id)` → resuelve el challenge de
publish de LRCLIB → POST del LRC. Botón en el panel (o en el módulo de edición
T1). Manejo de errores graceful (no romper si LRCLIB rechaza).

**Estado:** definida, no iniciada. Candidata a vivir dentro de T1.

---

### [ ] T3 — Genius provider + refactor a trait `LyricsProvider`  (bandera #3)

**Origen:** [LYRICS.md §Roadmap 2.c](./LYRICS.md) — "Genius + refactor a trait
`LyricsProvider` siguen pendientes".

Hoy el cascade de providers son **funciones sueltas** (`embedded.rs`,
`lrclib.rs`, NetEase en `lyrics/mod.rs`). Para sumar un 4º provider sin que el
cascade se vuelva spaghetti, refactorizar a un **trait `LyricsProvider`**
(método tipo `async fn fetch(&self, hint) -> Result<Option<LyricsHit>>`), y
después sumar **Genius** (plain-only; no tiene synced, pero amplía cobertura de
letra plana para tracks sin synced en ningún provider).

**Por qué el refactor primero:** es deuda técnica acumulada; meter Genius sin el
trait empeora el cascade. El trait es prerequisito.

**Scope:** trait + adaptar los 3 providers existentes + sumar Genius. Respetar
el principio de simpleza (el autor aprende Rust — un trait simple, sin
abstracción de más).

**Estado:** definida, no iniciada.

---

## Polish

### [ ] T4 — Auto-scroll en reorder por drag  (bandera #4)

**Origen:** [DECISIONS.md ADR-027](./DECISIONS.md#adr-027) — "Contra: sin
auto-scroll cuando arrastrás al borde de una lista larga (pendiente de polish)".

El reorder de playlists usa pointer-events (no HTML5 DnD, roto en WKWebView —
Gotcha #17). Funciona, pero al arrastrar una fila al **borde superior/inferior**
de una lista larga, la vista **no scrollea** → no podés mover un track más allá
de lo visible sin soltarlo y re-agarrarlo.

**Scope:** detectar cuando el puntero está cerca del borde del contenedor
scrolleable durante el drag y hacer auto-scroll (rAF + velocidad proporcional a
la cercanía al borde). Acotado al modo reorder de
[LibraryTable](../src/components/library/LibraryTable.tsx).

**Estado:** definida (polish), no iniciada.

---

## Bugs

### [ ] B1 — Desconexión de audífonos: el player va a altavoces en vez de pausar

**Origen:** [CLAUDE.md Gotcha #23](../CLAUDE.md) (handoff de AirPods), ampliado
2026-06-23.

**Síntomas:**
1. **AirPods Pro multipoint Mac↔iPhone:** al empezar audio en el iPhone, el
   handoff entrecorta el audio en vez de "Mac pausa + iPhone arranca".
2. **(NUEVO) Sony XM6:** al **desconectar** los audífonos, el reproductor
   **transiciona a los altavoces** y sigue sonando, en vez de **pausar**.

**Comportamiento esperado:** al perder el output device (desconexión de
audífonos), **pausar** la reproducción — comportamiento estándar de
reproductores (evita que la música salga de golpe por los parlantes).

**Camino de investigación (hipótesis #2 del Gotcha #23):** escuchar
`navigator.mediaDevices.ondevicechange` / detectar el cambio de output device →
auto-pausar el `<audio>`. Verificar también si MediaSession recibe `pause` al
perder foco (hipótesis #1). Detalle completo + hipótesis ordenadas en el
Gotcha #23.

**Estado:** bug abierto, sin investigar.

---

## Features grandes (roadmap — tocar después de documentar)

No se re-listan acá en detalle: viven en sus docs de dominio. Punteros:

- **Karaoke Fase B–E** — fullscreen UI, vocal removal, mic input, pitch scoring.
  Ver [KARAOKE.md §0](./KARAOKE.md). **Fase B es el siguiente gran hito.**
- **Identification Fase 3** — auto-identify + resolución de ambigüedad. No
  iniciada, se evalúa por uso real. Ver [IDENTIFICATION.md §0](./IDENTIFICATION.md).
- **MediaSession test en Windows** — TODO en
  [useMediaSession.ts](../src/hooks/useMediaSession.ts).
