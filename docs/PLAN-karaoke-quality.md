# Plan: Mejora de calidad del karaoke per-word

> **Estado (2026-06-21):**
> - **Mejora 1 (hybrid fill por confianza) — ✓ IMPLEMENTADA.** Frontend hecho
>   con **interpolación por anchors** (corridas de palabras de baja confianza
>   repartidas entre las confiables vecinas), más robusta que el sketch
>   per-palabra de §1.3.
> - **Mejora 2 (auto-fix de LRC desde transcripción) — ✗ DESCARTADA.** Decisión
>   de Bryan: no reemplazar letra humana curada con la transcripción de whisper
>   (transcribir canto es menos confiable; degradaría líneas correctas). La
>   corrección de letras sigue siendo manual vía EDIT.
>
> Detalle en [docs/KARAOKE.md §14](./KARAOKE.md#14-mejoras-de-calidad-plan-karaoke-quality-2026-06-21).
> Este doc se conserva como registro del diseño original.

> Dos mejoras independientes para el sistema de karaoke Fase A existente.
> Contexto: AUTO-ALIGN (WhisperX forced alignment) y CHECK QUALITY
> (mismatch detection) ya funcionan. El problema es que los alignment
> scores son bajos y el fill per-word a veces es impreciso.

---

## Estado actual (punto de partida)

### Qué ya existe

1. **AUTO-ALIGN** — botón en LyricsView. Invoca `karaoke_align.py`
   (WhisperX en align-only mode). Genera LRC formato A2 con per-word
   timestamps (`wordTimestampsMs`) + trailing end marker (`lastWordEndMs`).
   Persiste en `lyrics.synced_lyrics` + `lyrics.alignment_score`.

2. **CHECK QUALITY** — botón en LyricsView. Invoca `mismatch_detect.py`
   (faster-whisper transcribe + phonemizer IPA + Levenshtein). Devuelve
   `MismatchResult { overall_score, lines: [{ index, lrc_text,
   transcribed_text, score }] }`. Muestra panel con líneas mismatched
   (score < 0.5).

3. **Modo A2 en frontend** — `useSyncedLyrics.ts` líneas 87-118. Cuando
   `line.wordTimestampsMs` existe, usa timestamps reales por palabra.
   Bound end = próxima palabra, o `lastWordEndMs`, o próxima línea.

4. **Modo linear en frontend** — `useSyncedLyrics.ts` líneas 119-155.
   Sin `wordTimestampsMs`, distribuye el fill uniformemente por caracteres
   a lo largo de toda la duración de la línea.

5. **EDIT modal** — permite al usuario corregir el LRC manualmente.
   Guarda en `original_synced_lyrics` (preserva edición a través de
   RE-ALIGNs).

### Problemas a resolver

- **Alignment scores bajos** — wav2vec2 está entrenado en speech, no en
  canto. Palabras con score bajo (< 0.3) tienen timestamps poco
  confiables que degradan el fill visual.
- **CHECK QUALITY detecta pero no corrige** — el usuario tiene que leer
  las líneas malas, abrir EDIT, corregir manualmente, y después
  RE-ALIGN. Proceso tedioso y técnico.
- **El fill sigue avanzando en palabras con timing malo** — no hay
  distinción visual entre una palabra bien alineada (score 0.95) y una
  mal alineada (score 0.10).

---

## Mejora 1: Hybrid fill por confianza de palabra

### Objetivo

Palabras con score de alignment bajo caen automáticamente a
interpolación lineal dentro de su segmento, en vez de usar el timestamp
(probablemente incorrecto) de WhisperX. El resultado es un fill que
"fluye" suavemente en vez de saltar erráticamente.

### Qué cambiar

#### 1.1 Backend: propagar word scores al A2 LRC

**Archivo:** `src-tauri/src/karaoke/mod.rs` → `build_a2_lrc()`

Actualmente el A2 LRC solo tiene timestamps por palabra:
```
[00:27.10]<00:27.10>Once <00:27.50>upon<00:27.80>
```

Necesitamos propagar el `score` de cada `WordTiming` para que el
frontend pueda decidir. Dos opciones:

**Opción A (recomendada): metadata en el A2 LRC**
Extender el formato A2 con un score opcional:
```
[00:27.10]<00:27.10|0.92>Once <00:27.50|0.85>upon<00:27.80>
```
- Pro: self-contained en el LRC string, no requiere columna extra.
- Con: formato custom (ningún otro player lo entiende — pero ya somos
  custom con el trailing marker).

**Opción B: columna separada en DB**
Agregar `lyrics.word_scores TEXT` (JSON array de scores). El frontend
lo parsea y lo cruza con `wordTimestampsMs` por índice.
- Pro: no toca el formato LRC.
- Con: columna nueva + migración + sincronización entre dos arrays.

**Decisión sugerida: Opción A.** El formato A2 ya es custom nuestro
(trailing marker). Agregar `|score` al marker es mínimo y mantiene
toda la info en un solo string.

#### 1.2 Frontend: parser de scores

**Archivo:** `src/lib/lrcParser.ts` → `parseA2Markers()`

Extender el regex para capturar el score opcional:
```
<mm:ss.xx>          → timestamp sin score (backwards compat)
<mm:ss.xx|0.85>     → timestamp con score
```

Agregar campo a `LrcLine`:
```ts
wordScores?: number[];  // parallel a wordTimestampsMs, 0..1
```

#### 1.3 Frontend: hybrid fill

**Archivo:** `src/hooks/useSyncedLyrics.ts` → `updateProgress()`

En el modo A2 (líneas 87-118), para cada palabra:
```ts
const SCORE_THRESHOLD = 0.3;
const score = line.wordScores?.[i] ?? 1.0;

if (score < SCORE_THRESHOLD) {
  // Interpolación lineal dentro del segmento [startEff, endEff]
  // en vez de usar el timestamp directo.
  // El segmento ya está definido, solo cambiamos cómo se calcula
  // el progreso interno: distribuir uniformemente por caracteres
  // dentro de este span temporal.
  // Efecto: la palabra se llena suavemente en vez de saltar.
}
```

El threshold `0.3` es el punto de partida. Se puede ajustar con uso
real. Palabras con score >= 0.3 usan el timestamp real (comportamiento
actual). Palabras con score < 0.3 caen a fill lineal dentro de su
ventana temporal — visualmente suave, sin saltos.

#### 1.4 Testing

- Cargo test: verificar que `build_a2_lrc` con scores genera el formato
  `<mm:ss.xx|score>` correctamente.
- Verificar backwards compat: A2 LRC sin scores (generados antes del
  cambio) sigue parseando bien (`wordScores` queda `undefined`).
- Manual: AUTO-ALIGN un track con score bajo, verificar que las
  palabras de baja confianza se llenan suavemente.

---

## Mejora 2: Auto-corrección de LRC desde transcripción

### Objetivo

Usar la transcripción de CHECK QUALITY para reemplazar automáticamente
las líneas con mismatch alto en el LRC, y después re-alinear con el
texto corregido. Elimina el paso manual de EDIT para líneas donde la
transcripción es mejor que el LRC.

### Qué cambiar

#### 2.1 Backend: nuevo comando `karaoke_auto_fix`

**Archivo:** `src-tauri/src/commands/karaoke.rs`

Nuevo comando Tauri que orquesta el flujo completo:
1. Ejecutar `detect_mismatch()` → `MismatchResult`.
2. Para cada línea con `score < FIX_THRESHOLD` (sugerido: 0.5):
   - Reemplazar el texto de esa línea en `original_synced_lyrics` con
     `transcribed_text` de la detección.
   - Preservar el timestamp original de la línea (solo cambia el texto).
3. Persistir el LRC corregido en `original_synced_lyrics` (esto es
   importante: la corrección se vuelve la nueva "fuente de verdad"
   para futuros RE-ALIGNs).
4. Ejecutar `align_track()` sobre el LRC corregido.
5. Devolver `{ lines_fixed: usize, alignment_score: f64 }`.

**Archivo:** `src-tauri/src/karaoke/mod.rs`

Nueva función `auto_fix_lyrics()`:
```rust
pub struct AutoFixResult {
    pub lines_fixed: usize,
    pub alignment_score: f64,
    pub mismatch_before: f64,
}

pub async fn auto_fix_lyrics(
    pool: &SqlitePool,
    track_id: i64,
    language: &str,
    align_script: &Path,
    mismatch_script: &Path,
) -> AppResult<AutoFixResult> {
    // 1. detect_mismatch
    // 2. fix lines with score < 0.5
    // 3. persist fixed LRC as original_synced_lyrics
    // 4. align_track
    // 5. return result
}
```

#### 2.2 Backend: función de reemplazo de líneas

**Archivo:** `src-tauri/src/karaoke/mod.rs`

Nueva función que toma el LRC original + MismatchResult y produce un
LRC corregido:
```rust
fn apply_fixes(
    original_lrc: &str,
    mismatches: &[MismatchLine],
    threshold: f64,
) -> String {
    // Para cada línea del LRC:
    //   - Si tiene un MismatchLine correspondiente (por index) con
    //     score < threshold Y transcribed_text no está vacío:
    //     reemplazar el texto de esa línea con transcribed_text.
    //   - Preservar el timestamp [mm:ss.xx] original.
    //   - Si la línea no matchea o score >= threshold: dejar intacta.
}
```

**Consideraciones:**
- Solo reemplazar si `transcribed_text` no está vacío (whisper a veces
  no transcribe nada en secciones instrumentales).
- Normalizar whitespace del texto transcrito.
- NO tocar líneas que están bien (score >= threshold) — principio de
  mínima intervención.

#### 2.3 Frontend: botón AUTO-FIX en LyricsView

**Archivo:** `src/components/lyrics/LyricsView.tsx`

Agregar botón **AUTO-FIX** que aparece cuando hay `mismatchResult` con
líneas por debajo del threshold. El botón:
1. Invoca `karaoke_auto_fix`.
2. Muestra feedback: "FIXED N LINES · SCORE: X.XX → Y.YY".
3. Refresca las lyrics en el store.

**Ubicación sugerida:** al lado de CHECK QUALITY, o como acción
sugerida en el panel de resultados de mismatch (donde ahora dice
"USE EDIT TO FIX BAD LINES, THEN RE-ALIGN").

El texto actual "USE EDIT TO FIX BAD LINES, THEN RE-ALIGN" se
reemplaza por el botón AUTO-FIX + un texto alternativo "OR EDIT
MANUALLY" para quien prefiera control total.

#### 2.4 Flujo del usuario (antes vs después)

**Antes:**
1. AUTO-ALIGN → score bajo
2. CHECK QUALITY → ve líneas malas
3. EDIT → corrige manualmente cada línea
4. RE-ALIGN → score mejor
5. Repetir 2-4 si quedan líneas malas

**Después:**
1. AUTO-ALIGN → score bajo
2. CHECK QUALITY → ve líneas malas
3. **AUTO-FIX** (un click) → corrige + re-alinea automáticamente
4. Opcionalmente: EDIT manual para refinar lo que AUTO-FIX no resolvió

#### 2.5 Testing

- Cargo test: `apply_fixes` con LRC de ejemplo + MismatchResult →
  verificar que solo las líneas con score bajo se reemplazan.
- Cargo test: líneas con `transcribed_text` vacío NO se reemplazan.
- Manual: track con CHECK QUALITY mostrando mismatches → AUTO-FIX →
  verificar que el score sube y el fill mejora.

---

## Orden de implementación sugerido

1. **Mejora 1 primero** (hybrid fill) — es independiente, cambios
   pequeños, mejora inmediata sin re-procesar nada.
2. **Mejora 2 después** (auto-fix) — depende de probar que la
   transcripción de faster-whisper es suficientemente buena como
   reemplazo del LRC.

### Estimación de esfuerzo

| Mejora | Backend | Frontend | Tests |
|--------|---------|----------|-------|
| 1. Hybrid fill | `build_a2_lrc` + formato score (~30 líneas) | parser + `updateProgress` (~40 líneas) | 2-3 tests Rust + manual |
| 2. Auto-fix | `auto_fix_lyrics` + `apply_fixes` + comando (~100 líneas) | botón + feedback (~30 líneas) | 2-3 tests Rust + manual |

---

## Archivos que se tocan

### Mejora 1
- `src-tauri/src/karaoke/mod.rs` — `build_a2_lrc()` agrega `|score`
- `src/lib/lrcParser.ts` — `parseA2Markers()` parsea `|score`, nuevo campo `wordScores`
- `src/types.ts` — `LrcLine.wordScores?: number[]` (si el tipo vive acá)
- `src/hooks/useSyncedLyrics.ts` — `updateProgress()` hybrid fill
- `src/styles/tokens.css` — (opcional) estilo visual distinto para palabras degradadas

### Mejora 2
- `src-tauri/src/karaoke/mod.rs` — `auto_fix_lyrics()`, `apply_fixes()`
- `src-tauri/src/commands/karaoke.rs` — comando `karaoke_auto_fix`
- `src/components/lyrics/LyricsView.tsx` — botón AUTO-FIX + feedback
- `src-tauri/src/db/lyrics.rs` — (posiblemente) update de `original_synced_lyrics`

### No se tocan
- Scripts Python (`karaoke_align.py`, `mismatch_detect.py`) — reutilizamos tal cual.
- `lyrics/mod.rs` — el cascade no cambia.
- `whisperx.rs` — la invocación no cambia.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Score `\|` en el marker A2 rompe parsers de terceros | Ya somos custom (trailing marker). Documentar en KARAOKE.md. |
| Transcripción de whisper tiene hallucinations (palabras inventadas en secciones instrumentales) | Solo reemplazar si `transcribed_text` no está vacío y `score < threshold`. No tocar líneas que están bien. |
| Auto-fix empeora líneas que estaban "casi bien" (score 0.45) | Threshold conservador (0.5). El usuario siempre puede EDIT manual después. |
| Re-align después del fix sigue dando score bajo | Posible si el audio tiene instrumentación muy pesada. No es un bug — es un límite del modelo. El hybrid fill (Mejora 1) suaviza el impacto visual. |
| `original_synced_lyrics` se sobreescribe con texto auto-corregido | Es intencional — la corrección pasa a ser la nueva fuente de verdad. Si el usuario quiere volver al original, puede REFETCH. |
