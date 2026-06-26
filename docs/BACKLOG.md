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

**Scope (incrementos):**
- **[x] inc.1 — Flag visual inline de líneas malas** (2026-06-23). Las líneas
  con score < 50% de la última corrida de CHECK QUALITY se marcan **dentro** del
  panel synced (borde accent + badge `⚠NN%` + `audio: "<transcripción>"`), en vez
  de la lista separada de abajo (que se reemplazó por una guía corta). Match por
  texto normalizado (robusto a A2-align que mueve timestamps). En
  [LyricsView.tsx](../src/components/lyrics/LyricsView.tsx).
- **[x] inc.2 — Edición inline por línea** (2026-06-24): botón **FIX** en las
  líneas marcadas → la línea se vuelve un input en el lugar, con **USE AUDIO**
  (rellena con la transcripción de whisperx) + SAVE/CANCEL (Enter/Esc). Helper
  puro `replaceLrcLineText` ([lrcParser.ts](../src/lib/lrcParser.ts)) reemplaza
  sólo esa línea del LRC crudo (match por texto, preserva timestamps y el resto),
  y persiste vía `saveManualEdit` (resetea aligned_at + quality — correcto: el
  texto cambió). Sólo líneas marcadas; editar cualquier línea sigue por el modal
  EDIT. **Trade-off:** invalida el alignment de todo el track (re-align selectivo
  por línea = inc.4).
- **[ ] inc.3 — Auto-refetch** de otro provider cuando la confidence/score es
  baja (cerrar el loop del smart cascade 2.c.4a: hoy detecta, falta actuar).
- **[ ] inc.4 — Editor línea-por-línea con timestamps**: ajustar el timestamp de
  una línea puntual, re-align selectivo de un rango.
- **[ ] inc.5 — Integración con "Contribute to LRCLIB"** (ver T2) como paso
  final del flujo.

**Estado:** en progreso — inc.1 shipped + persistencia (pendiente verificación
visual), inc.2-5 pendientes.

**inc.1b — persistencia + track-refresh + RE-CHECK QUALITY** (2026-06-23):
- Los scores **per-línea ahora se persisten** (`lyrics.mismatch_lines` JSON,
  migración `20260623000001`) → los flags sobreviven reinicios y cambios de
  track (antes vivían sólo en memoria).
- Se **invalidan cuando el LRC cambia** (refetch / manual edit resetean
  `mismatch_lines` junto con score/checked_at).
- **Fix de track-change:** se eliminó el estado en memoria `mismatchResult` (que
  quedaba pegado de la canción anterior y, vía el guard `!mismatchResult`,
  ocultaba TODO el panel de indicadores ALIGNED/QUALITY en el track nuevo).
  Ahora la única fuente es `current` (persistido), que se recarga por track → los
  indicadores de aligned/quality y los flags se actualizan solos al cambiar de
  canción.
- Botón **RE-CHECK QUALITY** cuando ya se chequeó (espeja RE-ALIGN).

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

### [~] T6 — Editor de lyrics con waveform (mini-DAW de timing)  ⭐ GRANDE

**Origen:** charla 2026-06-24. La edición actual (modal de textareas + FIX
inline de inc.2) es rústica para el **timing**. Visión: un editor donde cada
palabra es un segmento sobre la **onda de audio**, con cotas de inicio/fin
arrastrables. Subsume/evoluciona T1 (la edición de texto se integra acá).

**Decisiones tomadas:** onda con **canvas custom** (no librería — más control,
brutalist, las interacciones son custom igual). Construir **por fases**, MVP
primero.

**Interacciones objetivo (visión completa):**
- Arrastrar una **cota** (handle) → cambia cuánto dura la palabra (start o end).
- Arrastrar el **segmento entero** → mueve la palabra en el tiempo manteniendo
  su duración (palabra de 1.4s en seg 30 → arrastro a seg 35, sigue durando 1.4s).
- **Push en colisión:** si una cota choca con la palabra vecina, la empuja.
- Vista por **línea** + **global**.

**Fases:**
- **[x] Fase 1 (MVP)** (2026-06-24): onda del track (decode vía `convertFileSrc`
  + `fetch` + `decodeAudioData`, peaks en canvas) + **playhead** + **click-seek**
  + coloreo de progreso (reproducido en accent).
- **[x] Fase 2** (2026-06-24): layout **overview + detalle**. Overview = canción
  completa con marcador de ventana; detalle = zoom a la línea seleccionada
  (nav ◂▸) con las **palabras como cajas** sobre la onda (derivadas del A2).
  Peaks por rango de samples para el zoom.
- **[x] Fase 3** (2026-06-24): **drag** en las cajas del detalle (pointer-events):
  cuerpo = **mover** (mantiene duración), cotas = **resize** start/end, con
  feedback de cursor + clamp a la ventana y MIN_DUR. **Local, NO persistido
  todavía** (el guardado + A2 extendido es Fase 4). Sin push de colisión aún.
- **[~] Fase 4:** en progreso:
  - **[x] 4a — GUARDAR** (2026-06-24): A2 extendido a **start+end por palabra**
    (`<s>word<e>`) → parser (`wordEndTimestampsMs`) + serializer (`serializeA2Line`)
    + renderer del karaoke (gaps) + `replaceLrcLine`. Botón **SAVE LINE** en el
    editor → comando `lyrics_save_word_timing` (DB) que persiste el A2 re-editado
    **sin** resetear texto/offset/speed/quality (sólo `synced_lyrics` +
    `aligned_at`). Round-trip OK (reabrir muestra el timing guardado).
  - **[x] 4b — push en colisión** (2026-06-24): ripple `rippleForward`/
    `rippleBackward` — arrastrar una cota/cuerpo contra la vecina la empuja
    (manteniendo duración, cascada, corta en la primera sin colisión).
  - **[~] 4c — navegación/timeline + playback aids** (2026-06-24):
    - **[x] FOLLOW** (el detalle sigue la línea que suena) + **LOOP LINE**
      (repite la ventana de la línea) — toggles mutuamente excluyentes.
    - **[x] Overview = timeline de líneas**: ticks por línea, hover highlight +
      **tooltip con la letra**, click = seleccionar la línea (+ seek).
    - **[x] Fix de freeze al abrir**: stride en `computePeaks` (no recorrer
      millones de samples síncronos).
    - **[x] Mover línea** (2026-06-24, corregido 2026-06-25): arrastrar la
      región de la línea en el overview = **mover** (traslada TODAS las palabras
      por el mismo delta, **mantienen duración y distribución** — NO se escalan;
      el escalado proporcional fue un bug). Clamp a las vecinas. → `editSegs` →
      **SAVE LINE**.
    - **[x] Zoom + navegación del overview** (2026-06-25): **click = seek**
      (navegar la timeline, ya no zoomea); **doble-click = zoom in** centrado en
      el punto (**shift = zoom out**); **rueda = zoom in/out** centrado en el
      cursor; **shift+rueda o arrastrar = pan** horizontal (sólo con zoom).
      Botón **FULL VIEW** + **indicador de % de zoom** (100% = canción completa).
      La ventana visible vive en un **ref** (`viewRef`), no en state → pan/zoom
      no re-renderizan React. La onda se dibuja **remuestreando** picos de toda
      la canción (≈1 bucket/ms, `resampleInto`) en el rAF → cualquier nivel de
      zoom sin re-leer el AudioBuffer.
    - **[x] Pan lateral del detalle** (2026-06-25): arrastrar zona vacía o rueda
      = mover la ventana de la línea lateralmente (sin zoom — el detalle siempre
      muestra una línea + contexto). Clamp a `[0, fin de canción]`, reset al
      cambiar de línea. El detalle también remuestrea `fullPeaks` → pan barato.
      Bonus: **zoom del overview suavizado** para trackpad (`exp(dy·k)` con `dy`
      capeado + `normalizeWheelY` por `deltaMode`) — saltaba 100%→1000% de un toque.
    - **[ ] (parqueado) Expandir la DURACIÓN de la línea** (3s→5s/2s, "si las
      palabras lo permiten"): contenedor de línea con inicio/fin propios (cola de
      highlight más allá de las palabras). Necesita extender el A2 + el renderer.

**Trabajo de fondo (cross-cutting):** el A2 actual guarda sólo START por palabra
+ un END de línea. La visión necesita START y END por palabra (con gaps).
whisperx ya da start+end por palabra — falta **persistirlo** (extender el A2 con
end por palabra) + ajustar parser/serializer/renderer del karaoke. Se encara
junto con la Fase 3/4.

**Interacciones por pointer-events** (no HTML5 DnD — roto en WKWebView,
Gotcha #17), mismo patrón que el reorder de playlists.

**Estado:** en progreso — Fase 1 (MVP) arrancada.

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

### [ ] T5 — Silenciar errores WebGL de mount del visualizer

**Origen:** logs de consola (2026-06-23). Butterchurn emite, al montar, algunos
errores transitorios:
`WebGL: Cannot generate mipmaps for a zero-size texture` /
`Framebuffer is incomplete: Attachment has zero size`.

El visualizer se ve bien — es un frame que renderiza con el canvas/framebuffer
en **tamaño cero** antes de dimensionar (territorio Gotchas #5 `setRendererSize`
y #8 mount persistente). Ruido benigno, pero ensucia la consola.

**Scope:** gatear el primer render hasta que el canvas tenga tamaño > 0 (o
llamar `setRendererSize` antes del primer frame). Bajo impacto, bajo riesgo.

**Estado:** definida (polish, baja prioridad), no iniciada.

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

**Relacionado:** [B2](#-b2--reproduccion-muda-el-audiocontext-queda-suspendido) —
misma raíz parcial (no reaccionamos a cambios de output device / suspend del
ctx). Si B2 termina escuchando `devicechange`, B1 puede colgarse del mismo
listener para decidir *pausar* (disconnect) vs *resumir* (volver el foco).

---

### [x] B2 — Reproducción muda: el AudioContext queda suspendido

**Reportado/arreglado 2026-06-23.** Dejar el player abierto un rato y volver:
la canción **avanza pero no sale sonido**. Causa: macOS/WKWebView suspende el
`AudioContext` (sleep / idle / cambio de output device); como el audio se rutea
por `createMediaElementSource` (Gotcha #2), el `<audio>` corre su timeline pero
el grafo dormido no produce sonido. No había `resume()` salvo en el path
paused→play del toggle ([playerStore.ts](../src/stores/playerStore.ts)), así que
si el ctx se suspendía con `isPlaying=true` nada lo despertaba.

**Fix (shipped, en observación):**
1. `ensureAudioContextRunning()` en [audio/context.ts](../src/audio/context.ts)
   + llamado desde `fadeInPlayPause()` → **todo** play (playTrack, crossfade,
   toggle) reanuda el ctx.
2. Hook [useAudioContextResume](../src/hooks/useAudioContextResume.ts) (montado
   en App) → al volver foco/visibilidad **o cambiar el set de output devices
   (`devicechange`)**, si `isPlaying`, reanuda el ctx solo.

**Resultado (2026-06-23):** mejoró el caso `suspended` simple. **Reapareció
(2026-06-26)** con dos matices nuevos en los logs → **Fix v2**:

3. **Reconexión de fuentes.** Apareció el estado **`interrupted`** (WebKit, por
   interrupción de la audio session al cambiar de output device BT). Tras él,
   WebKit deja el `MediaElementSource` **desconectado del output aunque el ctx
   vuelva a `running`** → resume solo no alcanza. Ahora `reconnectChannelSources()`
   (`source.disconnect()` + `source.connect(gain)`) corre al volver a `running`
   tras suspended/interrupted (listener `statechange`) **y** dentro de
   `recoverAudioRouting()`.
4. **`recoverAudioRouting()` (resume + reconnect)** reemplaza al resume-solo en
   los triggers del hook → reconecta **aunque el ctx nunca haya dejado
   `running`** (otro caso visto: running pero mudo, sin state change).
5. **Priming de `devicechange`.** WKWebView no emite `devicechange` hasta llamar
   `enumerateDevices()` una vez → el hook lo primea al montar. Sin esto el evento
   nunca disparaba (no había línea `devicechange` en los logs). Bonus: `focus`/
   `visibility` ahora reconectan → **escape hatch manual** (click afuera y volver
   a la ventana recupera el audio).

**Pendiente:** confirmar en hardware (BT reconnect) que Fix v2 recupera el audio.
**Plan B si reconectar no alcanza:** recrear el AudioContext entero al cambio de
device (rearmar grafo + tap del visualizer). Logs `[audio-debug]` temporales
siguen en consola para captar el estado si recurre.

**Nota:** la pausa de los XM6 al quitarlos solapa con [B1](#-b1--desconexión-de-audífonos-el-player-va-a-altavoces-en-vez-de-pausar)
para ese modelo, pero B1 sigue abierto para audífonos sin sensor de uso /
desconexión total de BT.

---

## Features grandes (roadmap — tocar después de documentar)

No se re-listan acá en detalle: viven en sus docs de dominio. Punteros:

- **Karaoke Fase B** ✓ MVP (2026-06-25) — modo fullscreen `KaraokeView`
  (overlay global): línea activa gigante con sweep per-word, pasada/próxima,
  countdown en gaps instrumentales, progress bar. Trigger botón KARAOKE / tecla
  `K`. Ver [KARAOKE.md §8](./KARAOKE.md). Ideas pendientes: más contexto,
  fondo con visualizer, tamaño configurable.
- **Karaoke Fase C–E** — vocal removal, mic input, pitch scoring. Sin compromiso.
  Ver [KARAOKE.md §0](./KARAOKE.md).
- **Identification Fase 3** — auto-identify + resolución de ambigüedad. No
  iniciada, se evalúa por uso real. Ver [IDENTIFICATION.md §0](./IDENTIFICATION.md).
- **MediaSession test en Windows** — TODO en
  [useMediaSession.ts](../src/hooks/useMediaSession.ts).

---

## Ideas futuras (panorama — fuera de scope, NO comprometido)

Análisis parqueado para no re-derivarlo. **No es una tarea**; contradice la
identidad local-first del proyecto. Capturado acá sólo para tener el panorama
disponible entre PCs (vía git).

### Sync de lyrics / karaoke / quality entre varias PCs

**¿Posible?** Sí, y el proyecto está bien posicionado: el dato valioso (LRC, A2
con marcas de karaoke, alignment/mismatch scores) es **derivado de una grabación**
y ya calculamos un **fingerprint de Chromaprint + MBID** por track. Esa es la
clave de sync machine-independent — **nunca sincronizar por `file_path`** (ruta
absoluta, distinta por OS/PC); siempre keyear por fingerprint/MBID y re-resolver
el path local.

**Tres caminos (menor → mayor scope):**
- **A) File-sync (Syncthing/Dropbox/iCloud):** rápido pero frágil — SQLite sobre
  Dropbox se corrompe (WAL/locks) y las rutas absolutas rompen entre OSes. No
  recomendado para la DB.
- **B) Export/import por fingerprint (sweet spot):** comando que exporta
  lyrics+karaoke+quality a un archivo portable keyed por fingerprint/MBID; se
  importa en la otra PC matcheando local. Robusto, sin servidor, encaja con el
  ethos local-first. Es una extensión del export M3U existente.
- **C) Sync backend real (otro producto):** servidor + auth + estado de sync +
  resolución de conflictos. Lo pesado **no es la red** (ya hacemos HTTP con
  reqwest/rustls por todos lados) sino el protocolo stateful + conflictos + infra.
  Punto medio moderno: Turso/libSQL embedded replicas.

**Gotchas no-obvios:**
- **El karaoke (A2) está acoplado al audio EXACTO** — se alineó contra esa
  waveform. La letra de texto viaja libre; los timestamps sólo son 100% válidos
  si la otra PC tiene el mismo master/encoding (el dedup por fingerprint es
  exacto, Gotcha #11). El karaoke es el dato "pegajoso".
- **Conflictos:** editás en PC A, re-alineás en B → LWW por timestamp
  (`aligned_at`/`mismatch_checked_at`/`fetched_at` ya existen) o merge.
- **Casi todo es re-derivable** (letras de LRCLIB/NetEase, karaoke de whisperx) →
  sync sería una *optimización* (no recomputar whisperx por máquina), no una
  necesidad de correctitud.

**Recomendación si algún día se encara:** approach **B**, arrancando por el
contrato de export. El audio queda fuera del scope de la app (Syncthing o
re-descarga por URL).
