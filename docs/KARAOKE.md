# KARAOKE.md — Sub-sistema de karaoke

> Modo karaoke con per-word timing real (vía forced alignment), pantalla completa, y posible vocal removal + mic input. Pensado para uso personal + fiestas familiares (caso de uso del autor + amigos).
>
> Cross-refs: [LYRICS.md](./LYRICS.md), [IDENTIFICATION.md](./IDENTIFICATION.md), [PLAN-reproductor-brutalist.md](./PLAN-reproductor-brutalist.md), [CLAUDE.md](../CLAUDE.md).

## Estado

- **Fase A** — en progreso. Forced alignment via **WhisperX** (pivote desde aeneas — ver §3.0) + parser A2 + UI `AUTO-ALIGN`.
- **Fase B–E** — futuro. Karaoke mode UI, vocal removal, mic input, pitch scoring.

---

## 0. Plan por fases

### Fase A — Forced alignment (per-word timing real)

Resuelve la limitación documentada en [LYRICS.md Fase 3](./LYRICS.md#fase-3--avanzado): el LRC estándar sólo da timestamps por línea, lo cual asume tempo uniforme dentro de cada línea. Falla en rap, screams, secciones rítmicamente irregulares — el karaoke fill se desfasa visiblemente.

- **Tooling:** `whisperx` (Python + PyTorch + Whisper + wav2vec2) como dep del sistema. Mismo patrón conceptual que yt-dlp/ffmpeg/fpcalc, pero **más pesado** (~2GB en disco después del primer download de modelos).
- **Modo de uso:** `align-only` — pasamos la letra que ya tenemos de LRCLIB a `whisperx.align()` Python API. **No** transcribimos el audio (whisperx blind transcription es flojo en canto). Sólo le pedimos "ubicame en tiempo cada palabra de este texto".
- **Backend:** módulo `src-tauri/src/karaoke/whisperx.rs` que spawnea un wrapper Python (shipped con la app) y consume su JSON output. El wrapper script usa la Python API de whisperx (la CLI no tiene flag para "skip transcription").
- **Persistencia:** sobreescribimos `lyrics.synced_lyrics` con la versión A2 (timestamps por palabra). A2 es backward-compatible: parsers que no lo soporten leen sólo los timestamps de línea.
- **Parser:** extender `src/lib/lrcParser.ts` para detectar sintaxis A2 (`[mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word2...`) y agregar `wordTimestampsMs?: number[]` a `LrcLine`. Backward compatible — cuando A2 no está, parser comporta idéntico.
- **UI:** botón `AUTO-ALIGN` en la barra de controles de `LyricsView`. Visible sólo si `whisperx` está en PATH **y** hay synced_lyrics actuales. Click → loading state ~30s-2min (según CPU/GPU) → letras quedan con per-word timing real.
- **Karaoke fill:** cuando A2 está disponible, cada palabra usa su timestamp real para `--word-fill-pct`. Cuando no, fallback al comportamiento linear actual (interpolación dentro de la línea con `--char-offset`).

### Fase B — Karaoke mode UI (big-screen)

Sólo cuando Fase A esté estable y A2 funcione bien.

- **Vista fullscreen** (`KaraokeView`) — letras gigantes centradas, sin player bar, sin tabs, sin toolbar. Sólo título + cover art en miniatura + las letras + un timestamp/progress bar minimal.
- **Trigger:** botón "KARAOKE" en `LyricsView` o atajo de teclado (`K`). Salida con Escape.
- **Estética brutalist:** mismo lenguaje que el resto pero al máximo — texto enorme (text-6xl o más), un solo color de acento sweep, alta densidad visual.
- **Optional countdown bar** antes de la próxima línea — barra de progreso de 1-2s que muestra "viene la siguiente". Útil para que el cantante anticipe.

### Fase C — Vocal removal (track instrumental)

El hit visible "fiesta familiar". Requiere stem separation.

- **Tooling:** `Demucs` o `Spleeter` como dep del sistema. Demucs tiene mejor calidad pero es más pesado; Spleeter más rápido pero peor calidad.
- **Backend:** comando `karaoke_extract_instrumental(track_id)` que pre-procesa el track una vez, guarda `<file>.instrumental.mp3` en cache, persiste el path en DB.
- **UI:** toggle en `KaraokeView` "VOCALS / INSTRUMENTAL" que cambia entre las dos fuentes audio en runtime. Si la versión instrumental no existe → ofrece extraerla con progress.
- **Costo de cómputo:** ~30s-3min por track según GPU/CPU. Idealmente en background mientras suena otra canción.

### Fase D — Mic input + feedback básico

- **Tooling:** Web Audio API + `getUserMedia({ audio: true })`. Sin deps externas.
- **Backend:** ninguno — todo en el browser.
- **UI:** botón "MIC ON" en `KaraokeView`. Cuando activo, indicador visual minimal (un cuadrado que pulsa con la amplitud, en accent).
- **Lógica:** VAD simple (RMS over noise floor) — sólo detecta "está cantando algo" vs "silencio". Sin pitch, sin scoring real.
- **Útil para:** feedback "el mic te escucha", record-along (Fase E), engagement de fiesta.

### Fase E — Pitch detection + scoring (competitivo)

Scope grande. Sólo si Fase A-D no alcanzan al daily-use que querés.

- **Pitch tracking:** algoritmo tipo YIN o crepe (ML-based). Devuelve nota cantada por frame.
- **Scoring contra melodía:** requiere referencia. Opciones:
  - **MIDI del track** — si tenemos un MIDI con la melodía vocal, comparamos. Cobertura limitada (no todos los tracks tienen MIDI público).
  - **Pitch del audio canónico** — extraer pitch del track original como referencia. Funciona pero es ruidoso (música tapando voz).
  - **Crowdsource con grabaciones del usuario** — primera vez calibra, después compara contra promedio. Complejo.
- **UI:** score por línea (porcentaje match) + score total al final de la canción.

---

## 1. Contexto y objetivos

### 1.1 El problema

Dos problemas distintos que comparten solución:

1. **Drift dentro de una línea** (limitación del LRC): el karaoke fill linear asume tempo uniforme, falla en rap / screams / secciones irregulares. El usuario lo observó en pruebas de Avicii pero es más obvio en tracks de Lostprophets, KANA-BOON con verses rápidos, etc.
2. **Karaoke como experiencia social** (fiestas): el player no está optimizado para uso de "varios cantando frente a una pantalla". Letras chicas, controles visibles, no hay vocal removal.

Forced alignment resuelve (1). Sub-fases B-E resuelven (2).

### 1.2 Objetivos por fase

**Fase A:**
- Per-word timing real para 95%+ de tracks vocal-driven con letra synced.
- Costo de alignment ~10-30s por track (one-shot, cacheado).
- Operación opt-in (botón AUTO-ALIGN, no automático).
- Cero degradación cuando aeneas no está disponible — todo sigue funcionando como hoy.

**Fase B:**
- Modo de pantalla completa que se siente "para fiesta": grande, alto contraste, sin distracciones.
- Lectura cómoda a 2-3m de distancia (el caso de TV / monitor grande).

**Fase C-E:**
- Sólo si el daily-use lo demanda. Diseño documentado pero no comprometido.

### 1.3 No-objetivos

- **No reemplazar a apps de karaoke serias** (Smule, KaraFun, etc.). Esto es portfolio + uso personal, no producto.
- **No bundlear modelos pesados.** El usuario instala aeneas/Demucs/etc. por separado bajo su responsabilidad.
- **No requerir karaoke para usar el player.** Cero impacto si el usuario nunca prende esta feature.

---

## 2. Por qué forced alignment (y no transcripción ciega)

La distinción crítica que define todo el diseño:

| Approach | Sabe el texto? | Output | Cuándo usar |
|---|---|---|---|
| **Blind transcription** (whisper.cpp default) | No | Texto + timestamps inferidos | Cuando no tenés el texto y querés transcribir |
| **Forced alignment** (WhisperX align-only mode) | Sí (le pasás el texto) | Timestamps por palabra del texto dado | Cuando ya tenés el texto y sólo querés saber CUÁNDO se dice cada palabra |

Nosotros **siempre tenemos el texto** (LRCLIB lo dio cuando hicimos el match). Forced alignment es el paradigma correcto.

### 2.1 whisper.cpp — el tool del medio que descartamos

Razones (no es malo, es el tool equivocado para esto):

- **Está optimizado para "no sé qué se dijo".** Para nuestro caso eso es overhead — repetimos un trabajo que ya tenemos resuelto.
- **Entrenado en habla, no canto.** Pierde precisión en tracks musicales — palabras con melisma, screams, autotune, harmonías. Cada palabra mal transcrita = timestamp mal ubicado.
- **`--prompt` mejora un poco** (le pasás el texto como hint) pero no es alignment puro; sigue transcribiendo con sesgo.

Confirmado empíricamente con un test: WhisperX corrió en modo default (transcribir + alinear) sobre un track del autor. La transcripción salió con errores notables (`bullshit churning` se transcribió como `bunch of purchasing`). Si hubiéramos confiado en esos timestamps, las palabras del karaoke fill estarían off.

### 2.2 aeneas — descartado por proyecto unmaintained

Considerado y descartado. La doc original tenía toda una sección sobre aeneas (forced alignment ligero, ~50MB, basado en eSpeak + DTW). Razones del descarte:

- **No se mantiene desde 2018.** Su `setup.py` usa APIs de setuptools antiguas que ya no existen en Python 3.12+.
- **Falló al instalar en Mac del autor** con Python 3.13 Y 3.11 (intentamos ambos). Build wheel rompía con `error: subprocess-exited-with-error / ERROR: Failed to build 'aeneas'`.
- **Aún si lo arregláramos hoy con flags específicos**, el riesgo de futuro re-bumpeo de Homebrew Python rompiéndolo de nuevo es alto.

Lección: para portfolio piece + uso personal, la fragilidad de proyectos abandonados es un costo real que excede sus pros (liviano, rápido).

### 2.3 WhisperX — qué hace por dentro

[GitHub](https://github.com/m-bain/whisperX) · OSS (BSD 4-clause).

Pipeline interno (cuando se usa en modo align-only):

1. **Carga el audio** vía ffmpeg (subprocess) o torchcodec si está disponible.
2. **Carga el modelo de alignment** — wav2vec2 entrenado en LibriSpeech (`WAV2VEC2_ASR_BASE_960H` para inglés, otras variantes por idioma). El modelo predice probabilidad de cada fonema en cada frame del audio.
3. **`whisperx.align(segments, model, metadata, audio, device)`** — recibe segmentos `{start, end, text}` con texto conocido y los alinea usando CTC forced alignment sobre el output del modelo.
4. **Output**: JSON con `segments[].words[].start/end/score` — exactamente lo que necesitamos.

**Fortalezas:**
- Activamente mantenido (commits recientes).
- Calidad de alignment ~95% (mejor que aeneas).
- Multi-idioma vía modelos por language code.
- Funciona offline después del primer download.
- API Python clara para align-only mode.

**Limitaciones:**
- **Pesado:** ~1.5-2GB en disco (PyTorch + whisper model + wav2vec2 model).
- **Lento sin GPU:** ~30s-2min por track en CPU. Apple Silicon usa MPS (acelerador propio) — bastante mejor pero no equivalente a CUDA.
- **CLI no soporta align-only directamente.** Hay que usar la Python API → wrapper script.
- **Requiere Python 3.11** (3.13+ tiene problemas con algunas deps de PyTorch).
- **`torchcodec` issue** en macOS: la versión que instala pip a veces no encuentra dylibs de ffmpeg. WhisperX cae al fallback de ffmpeg-subprocess automáticamente, así que es un warning ruidoso pero no fatal — confirmado en testing.

---

## 3. Decisión Fase A: WhisperX en modo align-only

Decidido tras intentar aeneas y confirmar que no instalaba (ver §2.2).

**Modo align-only es importante.** Si usáramos WhisperX en su modo default (transcribe + align), recibiríamos timestamps de las palabras que el modelo "escuchó", que puede diferir del texto que tenemos para mostrar. Eso desincroniza palabras visibles vs palabras alineadas — bug grave.

Align-only:
- Usamos `whisperx.load_align_model()` para cargar sólo el modelo wav2vec2.
- Construimos segmentos con la letra de LRCLIB y los timestamps de línea como bounds (`start = lineMs/1000, end = nextLineMs/1000`).
- Llamamos `whisperx.align(segments, model, metadata, audio, device)`.
- Recibimos word-level timestamps para nuestras palabras exactas.

**Por qué pasamos los timestamps de línea como bounds** en vez de un solo segment con `[0, audio_duration]`:
- WhisperX hace mejor alignment cuando le decís "esta palabra está aproximadamente entre estos bounds".
- Si usáramos un solo segment grande, errores se acumulan (alineamiento de la palabra 50 depende de la 49 que depende de la 48, etc.).
- Pasar bounds por línea limita el error a within-line. Outros instrumentales largos no afectan.

### 3.0 Pivot history (para reproducibilidad)

Esta sección documenta la lección aprendida durante el setup, para que el siguiente que toque este sub-sistema (o el autor en 6 meses) entienda por qué WhisperX y no aeneas:

1. **Plan original**: aeneas. Razonamiento: liviano, simple, diseñado para alinear texto conocido.
2. **Realidad del install**: aeneas no instala con Python 3.11 ni 3.13 — su `setup.py` usa setuptools APIs deprecadas.
3. **Pivote a WhisperX**: install limpio con `pipx install --python /opt/homebrew/bin/python3.11 whisperx`.
4. **Trade-off aceptado**: 1.5-2GB en disco vs 50MB de aeneas. Mantenibilidad gana. Para portfolio + uso personal, vale la dep más pesada.

### 3.1 ¿Y si WhisperX queda obsoleto en el futuro?

El sub-sistema queda diseñado para soportar múltiples providers — el módulo `karaoke/` puede tener `whisperx.rs`, `aeneas.rs` (futuro si revive), `montreal.rs` (Montreal Forced Aligner), etc. El cascade decide cuál usar por detección + config. Por ahora sólo whisperx, pero la puerta queda abierta.

---

## 4. Esquema DB

**No agregamos nuevas columnas.** El LRC raw ya vive en `lyrics.synced_lyrics`. Cuando aeneas alinea exitosamente, **reemplazamos** ese blob con la versión A2 (que es backward-compatible con LRC estándar — clientes viejos sólo leen los timestamps de línea, ignoran los `<...>` de palabra).

Único campo nuevo, opcional, para tracking:

```sql
-- 20260504000001_lyrics_aligned_at.sql
ALTER TABLE lyrics ADD COLUMN aligned_at DATETIME;
```

`aligned_at NOT NULL` significa "ya corrimos forced alignment sobre este track". Útil para:
- UI: el botón AUTO-ALIGN cambia a "RE-ALIGN" cuando ya está alineado (con tooltip "alignment from <fecha>").
- No re-correr alignment automáticamente si el usuario pidió que lo refresque.

### 4.1 Por qué A2 LRC y no una tabla aparte

Considerado:
- **Tabla `lyrics_word_timestamps (track_id, line_index, word_index, start_ms, end_ms)`** — más "relacional" pero requiere joins en cada render del LyricsView. Y el LRC ya es texto plano con timing — A2 es una extensión natural.
- **Field nuevo `synced_lyrics_a2 TEXT`** — duplica info, confusión sobre cuál es la fuente de verdad.

A2 inline en `synced_lyrics` es la opción más limpia: un blob, parser detecta el formato, fin.

---

## 5. Backend — Fase A

### 5.1 Estructura

```
src-tauri/
├── src/karaoke/
│   ├── mod.rs              # entrypoint + tipos públicos + parse_output
│   └── whisperx.rs         # spawn Python wrapper + parse stdout
└── resources/scripts/
    └── karaoke_align.py    # wrapper Python — usa whisperx Python API
```

Patrón mirror de `identification/`: módulo separado, uso opt-in via comando dedicado. La diferencia es que whisperx requiere un wrapper Python (su CLI no soporta align-only mode), shippeado como Tauri resource.

### 5.2 Detección de whisperx

```rust
// commands/system.rs (extender)
pub fn check_dependencies() -> DependencyStatus {
    DependencyStatus {
        yt_dlp: which::which("yt-dlp").is_ok(),
        ffmpeg: which::which("ffmpeg").is_ok(),
        fpcalc: which::which("fpcalc").is_ok(),
        whisperx: which::which("whisperx").is_ok(), // NEW
    }
}
```

El frontend usa `deps.whisperx` para decidir si mostrar el botón AUTO-ALIGN.

> **Nota:** detectamos el binary `whisperx` (la CLI), pero al spawnear vamos a usar el `python` de su mismo venv. Razón en §5.4.

### 5.3 Wrapper Python — `karaoke_align.py`

El script vive en `src-tauri/resources/scripts/`. Se shippea como Tauri resource (config en `tauri.conf.json` bundle.resources). Recibe args por argv y devuelve JSON por stdout — no toca filesystem más allá de los archivos temporales que le indicamos.

```python
#!/usr/bin/env python3
"""
Wrapper de whisperx para forced alignment en modo align-only.
Usado por src-tauri/src/karaoke/whisperx.rs vía subprocess.

Args (por argv):
    audio_path        : ruta al archivo de audio
    segments_json_path: ruta a JSON con [{start, end, text}, ...] (segmentos)
    output_json_path  : ruta donde escribir el resultado
    language          : ISO 639-1 (en, es, ja, ko, ...)

Output JSON shape:
    {
      "word_segments": [
        {"word": "...", "start": 1.234, "end": 1.567, "score": 0.89},
        ...
      ]
    }
"""

import json
import sys

import whisperx

audio_path, segments_path, output_path, language = sys.argv[1:5]

with open(segments_path) as f:
    segments = json.load(f)

device = "cpu"  # MPS sería ideal en Mac pero requires extra setup; CPU OK
model_a, metadata = whisperx.load_align_model(language_code=language, device=device)
audio = whisperx.load_audio(audio_path)
result = whisperx.align(
    segments, model_a, metadata, audio, device,
    return_char_alignments=False,
)

with open(output_path, "w") as f:
    json.dump({"word_segments": result["word_segments"]}, f)
```

~30 líneas. Sin deps externas que no sean whisperx (que ya está en el venv detectado).

### 5.4 Spawn desde Rust

WhisperX se instala vía pipx en un venv aislado. El binary `whisperx` está en `~/.local/bin/whisperx`, pero ese script invoca el `python` del venv automáticamente. Para correr **nuestro** script Python con whisperx disponible, necesitamos invocar **ese mismo Python**.

Estrategia:

```rust
// karaoke/whisperx.rs (sketch)

pub async fn align(
    audio_path: &Path,
    segments: &[Segment],     // {start_ms, end_ms, text}
    language: &str,
    script_path: &Path,       // resuelto del Tauri resource bundle
) -> AppResult<Vec<WordTiming>> {
    let tmpdir = tempfile::tempdir()?;
    let segments_path = tmpdir.path().join("segments.json");
    let output_path = tmpdir.path().join("aligned.json");

    // Convertir a la shape que el script espera
    let segments_json: Vec<_> = segments.iter().map(|s| serde_json::json!({
        "start": s.start_ms as f64 / 1000.0,
        "end": s.end_ms as f64 / 1000.0,
        "text": s.text,
    })).collect();
    std::fs::write(&segments_path, serde_json::to_string(&segments_json)?)?;

    // Encontrar el python del venv de whisperx.
    // `which whisperx` → ~/.local/bin/whisperx (symlink al venv).
    // Resolvemos el symlink y subimos un nivel: <venv_root>/bin/python.
    let whisperx_bin = which::which("whisperx")
        .map_err(|_| AppError::WhisperxMissing)?;
    let resolved = std::fs::canonicalize(&whisperx_bin)?;
    let python_bin = resolved
        .parent()
        .ok_or(AppError::Other("whisperx path has no parent".into()))?
        .join("python");

    let output = Command::new(python_bin)
        .arg(script_path)
        .arg(audio_path)
        .arg(&segments_path)
        .arg(&output_path)
        .arg(language)
        .output()
        .await?;

    if !output.status.success() {
        return Err(AppError::WhisperxFailed(
            String::from_utf8_lossy(&output.stderr).into_owned()
        ));
    }

    let json = std::fs::read_to_string(&output_path)?;
    parse_whisperx_output(&json)
}

pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

pub struct WordTiming {
    pub word: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub score: f64,
}
```

### 5.5 Construir segmentos desde el LRC actual

El cascade de Fase A:

```
1. Leer lyrics.synced_lyrics actual (raw LRC).
2. Parsear líneas con timestamp + texto.
3. Para cada línea i, construir segment:
   {
     start: line[i].timestamp_ms,
     end:   line[i+1].timestamp_ms (o duration audio si es la última),
     text:  line[i].text
   }
4. Llamar whisperx::align(audio, segments, language).
5. Recibir Vec<WordTiming>.
6. Convertir a A2 LRC.
7. UPDATE lyrics SET synced_lyrics = ?, aligned_at = CURRENT_TIMESTAMP.
```

### 5.6 Convertir a A2 LRC

WhisperX nos da `[{word, start, end, score}]` — flat array sobre todas las palabras del input. El synced_lyrics original tiene líneas. Hay que asociar palabras a líneas.

Estrategia: **mantenemos el orden**. WhisperX recibió las palabras en orden (las extrajimos del LRC en orden de línea). El output viene en el mismo orden. Iteramos paralelo: por cada palabra del LRC original (en orden), pickeamos el siguiente WordTiming del output, lo asignamos.

Output ejemplo:
```
[ar:Silversun Pickups]
[ti:Substitution]

[00:19.99]<00:19.99>There's <00:20.27>a <00:20.43>vulture <00:21.25>perching <00:22.55>right <00:23.55>offscreen
[00:24.50]<00:24.50>And <00:24.85>it's <00:25.10>bitter <00:25.78>and <00:26.10>whispers <00:27.20>chaotic <00:28.10>things
```

Backward compatible: parsers viejos que ignoran `<...>` siguen leyendo `[00:19.99]There's a vulture perching right offscreen`.

### 5.7 Comando Tauri

```rust
#[tauri::command]
pub async fn karaoke_auto_align(
    track_id: i64,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    // 1. Leer track + lyrics actuales de DB
    // 2. Resolver path al script Python (Tauri resource API)
    // 3. Construir segmentos
    // 4. Llamar karaoke::whisperx::align(...)
    // 5. Convertir a A2 LRC
    // 6. UPDATE lyrics SET synced_lyrics = ?, aligned_at = CURRENT_TIMESTAMP
}
```

**No cancelable en Fase A.** Alignment es ~30s-2min, one-shot por track. El usuario espera. Si después agregamos bulk auto-align (todos los tracks), ahí sí cancelable.

### 5.8 Variantes de error en `AppError`

```rust
#[error("whisperx not installed (install via: pipx install whisperx)")]
WhisperxMissing,

#[error("whisperx alignment failed: {0}")]
WhisperxFailed(String),

#[error("whisperx output parse error: {0}")]
WhisperxParse(String),
```

---

## 6. Parser A2 — Fase A

### 6.1 Sintaxis a soportar

```
[mm:ss.xx]<mm:ss.xx>word1 <mm:ss.xx>word2 <mm:ss.xx>word3
```

El primer `[mm:ss.xx]` es el timestamp de la línea (igual que LRC estándar). Los `<mm:ss.xx>` interleaved entre palabras son los timestamps de cada palabra.

### 6.2 Cambios en `parseLrc`

```typescript
export type LrcLine = {
  timestampMs: number;
  text: string;
  /** Per-word timestamps en ms, uno por palabra del `text` (split por
   *  whitespace). Sólo presente cuando el LRC viene en formato A2.
   *  `undefined` para LRC estándar — el karaoke fill cae al linear. */
  wordTimestampsMs?: number[];
};
```

Parser detecta `<...>` markers, extrae los timestamps, asocia con las palabras siguientes. Si no hay markers, comportamiento idéntico al de hoy.

### 6.3 Cambios en LyricsView / karaoke fill

Cuando `line.wordTimestampsMs` está presente:
- Cada palabra ya no usa `--char-offset` linear.
- El JS computa per-word fill basado en los timestamps reales (interpolando dentro del rango de cada palabra).
- Set `--word-fill-pct` directo en cada palabra cada frame (más DOM mutations pero acotadas a las ~5-15 palabras visibles).

Cuando `wordTimestampsMs` no está → comportamiento actual (linear via `--progress` global).

---

## 7. UI — Fase A

### 7.1 Botón AUTO-ALIGN

En la barra de controles de `LyricsView` (la que tiene SLOWER/FASTER/ALIGN/RESET), agregar:

```tsx
{deps.aeneas && lyrics.syncedLyrics && (
  <Button
    size="sm"
    onClick={onAutoAlign}
    disabled={aligning}
  >
    {aligning ? "ALIGNING..." : alignedAt ? "RE-ALIGN" : "AUTO-ALIGN"}
  </Button>
)}
```

Visible sólo si:
- aeneas detectado en deps.
- Hay synced_lyrics (sin texto no podemos alinear).
- (Opcional, después) confidence > umbral, idioma soportado, etc.

### 7.2 Loading state

Aeneas tarda 10-30s. Durante el run:
- Botón disabled muestra "ALIGNING..." con dot pulsing.
- Resto de la UI sigue funcionable (el usuario puede cambiar de track, reproducir, etc.).
- Si cambia de track durante alignment, la op no se cancela (sigue corriendo en background, el resultado se persiste igual).

### 7.3 Error handling

aeneas puede fallar por:
- Idioma no soportado.
- Audio en formato exótico.
- Track muy corto (<5s).
- Texto muy distinto del audio (mismatch).

En esos casos: status "AUTO-ALIGN failed" en accent + tooltip con razón. El track sigue usando el LRC linear como antes.

### 7.4 Indicador en library? (futuro)

Considerado: agregar columna **A** en LibraryTable (al lado de L y ID) con `[A]` para tracks alineados. Probablemente overkill — el usuario va a ver el efecto visual al abrir el panel de letras.

---

## 8. Karaoke mode UI — Fase B

### 8.1 KaraokeView component

Vista fullscreen que ocupa toda la ventana cuando se activa. Componentes:

```
┌─────────────────────────────────────────────────────────┐
│ [cover]  AVICII — THE NIGHTS                            │  ← header minimal
│                                                         │
│                                                         │
│                                                         │
│         ONCE UPON A YOUNGER YEAR                        │  ← línea pasada (muted, top fade)
│                                                         │
│       ━━━━━━ NEXT LINE IN 1.2S ━━━━━━                  │  ← countdown bar
│                                                         │
│         WHEN ALL OUR SHADOWS DISAPPEARED                │  ← línea ACTIVA (gigante, sweep)
│                                                         │
│         THE ANIMALS INSIDE CAME OUT TO PLAY             │  ← próxima (preview)
│                                                         │
│                                                         │
│                                                         │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━  01:42 / 03:39   │  ← progress bottom
└─────────────────────────────────────────────────────────┘
```

### 8.2 Activación

- Botón "KARAOKE" en `LyricsView` (cuando hay synced + idealmente A2).
- Atajo de teclado `K` (consistente con `F` para fullscreen visualizer).
- Salida con Escape.

### 8.3 Detalles brutalist

- Texto activo: `text-6xl` o más, font-display bold uppercase.
- Sweep brutalist HARD edge entre accent y muted (igual que `LyricsView` actual).
- Sin animaciones de entrada/salida — switch instantáneo.
- Cover art en miniatura sólo (ej 64×64 px) — el track ya está identificado, no necesita ocupar espacio.

---

## 9. Vocal removal — Fase C (sketch)

### 9.1 Tooling

**Demucs** (Facebook Research) o **Spleeter** (Deezer). Ambos OSS.

| Tool | Calidad | Velocidad | Modelo | Setup |
|---|---|---|---|---|
| Demucs v4 | Excelente | Lenta (~real-time CPU, 5x GPU) | ~300MB | Python + PyTorch |
| Spleeter | Buena | Rápida (~10x real-time CPU) | ~150MB | Python + TensorFlow |

Para empezar, **Demucs**: mejor calidad, no necesita ser tiempo real.

### 9.2 Pre-procesamiento

Como Demucs es lento, no podés "switchear vocals/instrumental" en runtime — hay que pre-procesar.

Flujo:
1. Usuario clickea "EXTRACT INSTRUMENTAL" sobre un track.
2. Backend spawnea Demucs, espera ~30s-3min, recibe `<file>.no_vocals.mp3`.
3. Guarda en cache: `<app_cache>/instrumentals/<track_id>.mp3`.
4. DB persiste el path: `tracks.instrumental_path TEXT`.

Después en runtime:
- Toggle "VOCALS / INSTRUMENTAL" cambia entre los dos archivos via el dual-audio pipeline existente (channelGain crossfade entre fuentes).

### 9.3 Limitación honesta

Stem separation no es mágico. Tracks con autotune pesado, mezcla compleja, o vocals procesados (vocoders, harmonías) van a tener artifacts notables. Para el 80% de pop/rock funciona muy bien; para electrónica con vocals procesados, puede sonar raro.

---

## 10. Riesgos

| Riesgo | Probabilidad | Mitigación | Fase |
|---|---|---|---|
| WhisperX 2GB de descarga + install pesado | Alta | Doc explícito + único requisito si querés karaoke. Sin él, app funciona idéntico. | A |
| WhisperX rompe con Python 3.13+ (PyTorch incompat) | Media | pinned a Python 3.11 vía pipx. README documenta exact version. | A |
| `torchcodec` warning ruidoso al correr | Confirmado | Es un warning no fatal — WhisperX cae al fallback ffmpeg-subprocess. Documentamos en README que es esperado. | A |
| Sung audio vs speech model mismatch | Media | wav2vec2 entrenado en LibriSpeech (habla). Para canto, calidad ~85-90%. Si crítico, fallback al karaoke linear. | A |
| Multi-idioma (japonés, coreano sin spaces) | Media | WhisperX soporta esos pero el wav2vec2 model varía calidad por idioma. Inglés y español son los mejor cubiertos. Detectar idioma del track via heurística o setting. | A |
| Long instrumentals confunden el alignment | Baja | Pasamos line-level bounds como segmentos, así que outros instrumentales caen fuera de los segmentos y no afectan. | A |
| Resolver path al `python` del venv de pipx | Confirmado | `which whisperx` → canonicalize → parent → python. Documentado en §5.4. Si pipx cambia su layout en el futuro, ajustamos. | A |
| Demucs/Spleeter cómputo pesado | Alta | Pre-procesamiento async + indicator visual. Idealmente background mientras suena otra canción. | C |
| Mic feedback (eco) en mode fiesta | Alta | `getUserMedia` con `echoCancellation: true`. Si aún hay eco, mensaje al usuario de bajar volumen. | D |
| Pitch detection en presencia de música de fondo | Alta | Difícil de resolver sin vocal removal previo (Fase C habilita Fase E). | E |

---

## 11. Decisiones abiertas

A cerrar al implementar Fase A:

1. **Idioma del alignment.** Aeneas necesita language code (eng/spa/jpn/kor/etc.). Opciones: (a) usar `track.language` si lo tenemos (no lo tenemos hoy), (b) asumir ENG y dejar que el usuario lo override en setting, (c) detectar via lib `whatlang`/`lingua`. Probablemente (b) por ahora — la mayoría de tu library es ENG.
2. **¿On-demand o automático?** Cada vez que un track recibe lyrics nuevas, ¿auto-alinear si aeneas está? Costo: ~10-30s por track × N tracks = mucho cómputo. Probablemente mejor on-demand (botón) — el usuario decide qué tracks vale alinear.
3. **¿Cómo manejar tracks ya alineados?** Si el usuario re-clickea AUTO-ALIGN sobre track ya alineado, ¿se re-corre o no? Probablemente sí (con confirmación) — los algoritmos mejoran, el usuario quizás cambió la letra manualmente, etc.
4. **Fallback path si aeneas falla.** Si retorna error, mostramos mensaje pero el LRC original (no A2) sigue ahí — la UI cae al karaoke linear.
5. **¿Dónde guardamos el path del binario aeneas?** En `which` para Fase A. Si después necesitamos pinpoint version, agregamos un setting.

A cerrar al implementar Fase B:

6. **Layout exacto del KaraokeView.** Wireframe arriba es propuesta — validar con uso real cuando Fase A esté lista.
7. **Atajo de teclado `K` o algo distinto.** `K` está libre. Confirmar al implementar.
8. **¿Mostrar countdown bar entre líneas siempre?** Útil pero puede saturar visualmente. Probablemente toggle setting.

A cerrar al implementar Fase C:

9. **Demucs vs Spleeter.** Probable Demucs por calidad — Spleeter es alternative si Demucs es prohibitivamente lento.
10. **¿Mantener originals o sólo no_vocals?** Demucs separa en 4 stems (vocals, drums, bass, other); para nosotros sólo `no_vocals` interesa. Espacio en disco vs flexibilidad.

---

## 12. Próximos pasos

**Setup verificado (2026-05-03):**

1. ✅ Doc creado.
2. ✅ Intento de aeneas — falló (ver §2.2 y §3.0). Pivote a WhisperX.
3. ✅ Install de WhisperX en Mac del autor:
   ```bash
   brew install pipx python@3.11
   pipx ensurepath  # restart shell
   pipx install --python /opt/homebrew/bin/python3.11 whisperx
   which whisperx   # → ~/.local/bin/whisperx ✓
   ```
4. ✅ Test manual sobre Silversun Pickups - Substitution con modelo `base`. Output JSON con `segments[].words[].start/end/score` confirmada — shape ideal para nuestro pipeline.

**Implementar Fase A:**

5. Migración: `lyrics.aligned_at DATETIME`.
6. `src-tauri/resources/scripts/karaoke_align.py` (~30 líneas, wrapper Python).
7. `src-tauri/tauri.conf.json` — agregar el script a `bundle.resources`.
8. `karaoke/whisperx.rs` — spawn subprocess + parse JSON output.
9. `karaoke/mod.rs` — entrypoint + helper para construir segmentos desde LRC + helper para serializar a A2 LRC.
10. Comando `karaoke_auto_align` + register en `lib.rs`.
11. Variantes nuevas en `AppError` (§5.8).
12. Detección de whisperx en `check_dependencies` + frontend `DependencyStatus`.
13. Parser A2 en `lrcParser.ts` + tests unitarios.
14. Karaoke fill por palabra con timestamps reales en `LyricsView` — cuando `wordTimestampsMs` está poblado, el cálculo de fill cambia (no más `--char-offset` linear, ahora un `--word-progress` real por palabra).
15. Botón AUTO-ALIGN en `LyricsView` controls (visible si deps.whisperx + hay synced_lyrics).
16. Validar end-to-end con 5-10 tracks de distintos idiomas + géneros + ediciones imperfectas.

**Reevaluar antes de Fase B:**

17. ¿Cuán bien funciona WhisperX align-only en práctica? Match rate, calidad subjetiva del karaoke fill, latencia.
18. ¿El daily-use está pidiendo el karaoke mode fullscreen?
19. ¿Qué tracks del autor quedan mal alineados aún con WhisperX? Investigar y categorizar.

---

*Doc vivo. Actualizar conforme avancen las fases.*
