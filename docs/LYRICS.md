# LYRICS.md — Sub-sistema de letras sincronizadas

> Plan por fases, adaptado a la arquitectura actual del proyecto.
> Fuente original: investigación independiente (ver historial). Este doc es la versión slim que aplica a nuestra base.
> Cross-refs: [PLAN-reproductor-brutalist.md §5.4](./PLAN-reproductor-brutalist.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [CLAUDE.md](../CLAUDE.md).

---

## 0. Plan por fases

La feature se introduce en tres fases. Cada una se desbloquea sólo cuando la anterior está estable y mergeada — sin scope creep.

### Fase 1 — MVP (cierra criterio "done" pendiente del proyecto)

Mínimo viable para tachar lyrics de los criterios "done" de Fase 1 del PLAN ([§10](./PLAN-reproductor-brutalist.md#10-criterios-de-done-para-el-mvp-fase-1)).

- **Fuentes:** Embedded (USLT/SYLT vía `lofty`) → LRCLIB. Dos.
- **Backend:** dos `async fn` libres en `src-tauri/src/lyrics/`. Sin trait, sin resolver pattern.
- **Parser LRC:** estándar línea-por-línea. Sin Enhanced LRC (A2).
- **Schema:** migración aditiva sobre la tabla `lyrics` existente (no renombramos columnas).
- **UI:** panel lateral en player view, sync via `requestAnimationFrame`, click-to-seek, control de `offset_ms`.
- **Persistencia:** cache en DB, `status: 'found' | 'not_found' | 'manual_pending'`.
- **Sin:** Genius, Musixmatch, paste manual, refetch automático, identificación canónica.

### Fase 2 — Polish (post-MVP estable)

Sub-fase 2.a (drift + intros) ✓ cerrada 2026-05-03. El resto sigue pendiente.

- ✅ **Drift correction (`speedRatio`)** — multiplicador de tempo + auto-baseline por duration ratio + UI SLOWER/FASTER (±0.5% step). Migración `20260503000001_lyrics_speed_ratio.sql` agregó `lyrics.speed_ratio REAL DEFAULT 1.0`. Comando `lyrics_set_speed_ratio`. Fórmula al consumir: `audioMs = (lrcMs + lrcOffset) * speedRatio + userOffsetMs` — speedRatio se aplica DESPUÉS de sumar el offset del archivo LRC pero ANTES de sumar el offset del usuario, para que userOffset sea un shift externo absoluto (típicamente padding de YouTube) y no quede escalado.
- ✅ **`ALIGN` mode** — toggle one-shot para resolver intros grandes (típico YouTube padding 5-30s). Click en el botón ALIGN, después click en cualquier línea durante reproducción → offset se ajusta para alinear ESA línea con el audio actual. Resuelve casos donde el offset manual ±100ms es demasiado fino. Escape sale del modo.
- ✅ **`RESET` extendido** — un solo click resetea offset + speedRatio a sus valores neutros (0 y 1.0). Comando `lyrics_reset_sync`.
- **Refactor a trait `LyricsProvider` + resolver** — recién cuando se sume el 3er provider. Antes es ceremonia para 2 funciones.
- **Genius** como último recurso (sólo plain — Genius no tiene letras synced).
- **Manual paste / edit modal** para tracks no encontrados.
- **Botón "Search again"** que fuerza refetch ignorando el cache `not_found`.
- **Tabla `lyrics_search_attempts`** con TTL para evitar martillar providers ante búsquedas repetidas.

### Fase 3 — Avanzado

No comprometido. Se evalúa ítem por ítem según uso real.

- **Musixmatch** opcional con API key del usuario (en `settings`).
- **NetEase** para cobertura asiática (API reverseada, riesgo de ruptura).
- **Identificación canónica vía AcoustID + Chromaprint** — ✓ shippeado 2026-05-02, ver [IDENTIFICATION.md](./IDENTIFICATION.md). Resuelve la mitad del problema: pisa la metadata sucia de yt-dlp con la canónica de MusicBrainz, lo cual feedea al cascade text-based de LRCLIB con mucho mejor hit rate ("AviciiOfficialVEVO" → "Avicii", `(Official Video)` strippeado). **Lo que NO resuelve** (corrección al plan original): LRCLIB no acepta lookup por MBID, así que no es el "santo grial" automático que pensábamos. Tracks identificados pero con LRC con drift residual por edición distinta siguen necesitando `speedRatio` (Fase 2 — drift correction sigue siendo trabajo separado).
- **Background job semanal** de re-fetch para tracks `not_found`.
- **Enhanced LRC (A2 / per-word) + forced alignment** — sub-sistema propio en [KARAOKE.md](./KARAOKE.md). El LRC estándar sólo da timestamps por línea, lo que asume tempo uniforme — falla en rap, screams, secciones rítmicas irregulares. La solución es generar A2 (timestamps por palabra) vía forced alignment con `aeneas` o `WhisperX`. El parser A2 + el karaoke fill por palabra son piezas compartidas con el karaoke mode fullscreen (también en KARAOKE.md), por eso quedó como sub-sistema separado.
- **Submit a LRCLIB** de letras editadas manualmente (contribución a la comunidad).

---

## 1. Contexto y objetivos

Mostrar las letras de la canción **sincronizadas con el audio**: a medida que la música avanza, la línea actual se destaca, las anteriores se desvanecen, las próximas se anticipan. Tipo karaoke / Apple Music / Spotify lyrics view.

### Objetivos (todas las fases)

- Letras sincronizadas cuando estén disponibles (preferido).
- Letras planas cuando no haya sincronizadas (fallback aceptable).
- Cero letras + UI clara cuando no se encuentre nada (no romper UX).
- Cache local agresivo: una vez encontradas, no volver a pedirlas.
- Ajuste manual de offset por el usuario para corregir desincronización.

### No-objetivos

- Transcribir audio a letras (Whisper, etc.).
- Traducir letras.
- Anotaciones tipo Genius.
- Editor avanzado de timestamps en MVP — solo offset global.

### Independencia con identification (`[ID]` ⊥ `[L]`)

Importante para no confundir indicadores en la UI: la columna **`[L]`** (letra disponible) y la columna **`[ID]`** (identificación AcoustID) son **independientes**. Un track puede tener `[ID]` y aún así no tener letra (`—` en L), porque MusicBrainz tiene cobertura de ~50M+ recordings pero LRCLIB es comunitario y mucho más chico — DJ livesets, indie nicho, idiomas con poca cobertura LRCLIB caen en este caso. **Es esperado, no es bug.** Ver [IDENTIFICATION.md §1.4](./IDENTIFICATION.md#14-id--l--son-independientes) para tabla completa de combinaciones.

---

## 2. El formato LRC

LRC es texto plano que asocia timestamps a líneas de letras. Existe desde los 90s (popularizado por Winamp).

```
[ti:Come As You Are]
[ar:Nirvana]
[al:Nevermind]
[length:03:39]
[offset:+0]

[00:25.43]Come as you are, as you were
[00:30.21]As I want you to be
[00:35.10]As a friend, as a friend
[00:39.85]As an old enemy
[00:44.62]
[00:49.40]Take your time, hurry up
```

### Tipos de líneas

- **Tags de metadata:** `[ti:]`, `[ar:]`, `[al:]`, `[length:mm:ss]`, `[by:]`, `[offset:+/-ms]`.
- **Líneas con timestamp:** `[mm:ss.xx]texto` — `xx` son centésimas (resolución 10ms).
- **Líneas vacías:** `[00:44.62]` sin texto → silencio/instrumental, útil para sincronizar pausas.
- **Múltiples timestamps:** `[00:25.43][01:32.10]Chorus` → la misma línea aparece dos veces.

### Casos edge

- Timestamps fuera de orden — ordenar por timestamp al parsear.
- Líneas duplicadas con mismo timestamp — concatenar con `\n` (a veces letras + harmonías).
- Encoding: LRCLIB siempre devuelve UTF-8. Si se importan `.lrc` viejos, considerar `encoding_rs` (Fase 3, no MVP).
- CR / LF / CRLF: normalizar a `\n`.
- BOM al inicio: strip.

### Enhanced LRC (A2) — fuera de Fase 1

Extensión con timestamps por palabra: `[00:25.43]<00:25.43>Come <00:25.85>as <00:26.10>you...`. La mayoría de letras en LRCLIB son LRC estándar; A2 queda para Fase 3.

---

## 3. Fuentes de datos

### 3.1 Embedded (USLT/SYLT) — Fase 1

Algunos archivos MP3/FLAC tienen letras embebidas en tags ID3:
- `USLT` → letras planas.
- `SYLT` → sincronizadas (raro pero existe).

`lofty` (ya integrado en `src-tauri/src/audio/mod.rs` para metadata + cover art) lee ambos frames. **Prioridad máxima:** si el archivo ya las trae, no pegarle a internet.

### 3.2 LRCLIB — Fase 1

**Sitio:** https://lrclib.net · **Docs:** https://lrclib.net/docs

- Open source, gratuito, sin auth, sin API key.
- Devuelve `syncedLyrics` (LRC) + `plainLyrics`.
- Búsqueda exacta por `(artist, title, album, duration)` o flexible por keyword.
- Sin DRM ni restricciones de cache: guardar en DB local sin problema.
- User-Agent recomendado: `BrutalistPlayer/0.1 ( https://github.com/<user>/<repo> )`.

**Endpoint principal:**
```
GET https://lrclib.net/api/get
  ?artist_name=Nirvana
  &track_name=Come+As+You+Are
  &album_name=Nevermind
  &duration=219
```
- 200 con JSON o 404 si no hay match.

**Shape de respuesta:**
```json
{
  "id": 12345,
  "trackName": "Come As You Are",
  "artistName": "Nirvana",
  "albumName": "Nevermind",
  "duration": 219.0,
  "instrumental": false,
  "plainLyrics": "Come as you are, as you were\n...",
  "syncedLyrics": "[00:25.43]Come as you are, as you were\n..."
}
```

**Cobertura realista (estimación comunitaria):**
- Mainstream occidental: ~85%.
- Indie/alternativa conocida: ~60%.
- Nicho/underground/muy nuevo: ~30-40%.
- No occidental (J-pop, K-pop, latino): ~50-70%.
- Clásica/instrumental: bajo, pero LRCLIB marca `instrumental: true` cuando aplica.

### 3.3 Genius — Fase 2

API oficial gratuita + scraping del HTML para obtener letras (la API solo da metadata). Requiere API key.

**Características:**
- Cobertura enorme para plain.
- **NO tiene synced.**
- Selector típico: `div[data-lyrics-container="true"]` (puede cambiar; verificar al implementar).
- Scraping → fragilidad: si Genius redibuja el HTML, romper gracefully (provider falla, otros siguen).

### 3.4 Musixmatch — Fase 3

Comercial. Plan free ~2000 calls/día. Términos restrictivos sobre cache (24h en algunos planes — para portfolio personal es zona gris aceptable). Activar como provider opcional con API key del usuario en settings; **no bundlear API key.**

### 3.5 NetEase Cloud Music — Fase 3

API no oficial, cobertura excelente para música asiática. Riesgo alto de ruptura. Considerar sólo si hay demanda real.

### 3.6 Comparación

| Fuente | Synced | Plain | Free | API key | Cobertura | Confiabilidad | Fase |
|---|---|---|---|---|---|---|---|
| Embedded (USLT/SYLT) | A veces | Sí | N/A | N/A | Variable | Alta | 1 |
| LRCLIB | Sí | Sí | Sí | No | Buena | Alta | 1 |
| Genius | No | Sí | Sí | Sí | Excelente | Alta | 2 |
| Musixmatch | Sí | Sí | Limitado | Sí | Excelente | Alta | 3 |
| NetEase | Sí | Sí | Sí | No | Excelente (Asia) | Media-baja | 3 |

---

## 4. Esquema de DB

### 4.1 Estado actual (Fase 0)

Migración `20260421000001_initial_schema.sql` ya creó `lyrics`:

```sql
CREATE TABLE lyrics (
    track_id INTEGER PRIMARY KEY,
    synced_lyrics TEXT,
    plain_lyrics TEXT,
    source TEXT,
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
```

La tabla está vacía (no hay código que escriba aún). **Conservamos los nombres de columna** — el doc original proponía renombrar a `synced_lrc` / `plain_text`, pero no agrega valor y rompe la migración existente.

### 4.2 Migración para Fase 1 (aditiva)

```sql
-- 20260502000001_lyrics_phase1.sql
ALTER TABLE lyrics ADD COLUMN offset_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lyrics ADD COLUMN status TEXT NOT NULL DEFAULT 'found';
ALTER TABLE lyrics ADD COLUMN source_id TEXT;
ALTER TABLE lyrics ADD COLUMN confidence REAL;
ALTER TABLE lyrics ADD COLUMN last_used_at DATETIME;

-- SQLite no soporta CHECK añadido por ALTER. Se valida en código:
-- status ∈ {'found', 'not_found', 'manual_pending'}.

CREATE INDEX idx_lyrics_status ON lyrics(status);
```

### 4.3 Tabla auxiliar — Fase 2

Para política "no re-intentar si falló hace <1 semana":

```sql
CREATE TABLE lyrics_search_attempts (
    track_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    found BOOLEAN NOT NULL,
    error_message TEXT,
    PRIMARY KEY (track_id, provider, attempted_at),
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
);
```

### 4.4 Decisión: no parsear LRC a tabla

Parsear `synced_lyrics` en runtime cuando se carga el track. Razones:
- Letras tienen 50-150 líneas; parsing es O(n) trivial.
- El LRC ya está en `lyrics.synced_lyrics`.
- Sincronizar dos representaciones es complejidad innecesaria.

---

## 5. Parser LRC (Fase 1)

### 5.1 Tipos

```rust
// src-tauri/src/lyrics/lrc.rs

#[derive(Debug, Clone, PartialEq)]
pub struct LrcLine {
    pub timestamp_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct LrcMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub length_ms: Option<u64>,
    pub offset_ms: i64,  // puede ser negativo
    pub by: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedLrc {
    pub metadata: LrcMetadata,
    pub lines: Vec<LrcLine>,  // ordenadas por timestamp
}
```

### 5.2 Implementación

```rust
pub fn parse_lrc(input: &str) -> ParsedLrc {
    let mut metadata = LrcMetadata::default();
    let mut lines = Vec::new();

    for raw in input.lines() {
        let line = raw.trim_start_matches('\u{FEFF}').trim();
        if line.is_empty() { continue; }

        if apply_metadata_tag(&mut metadata, line) { continue; }

        for (ts, text) in parse_timed_line(line) {
            lines.push(LrcLine { timestamp_ms: ts, text });
        }
        // Líneas malformadas se ignoran silenciosamente (best-effort).
    }

    lines.sort_by_key(|l| l.timestamp_ms);
    ParsedLrc { metadata, lines }
}

fn parse_timed_line(line: &str) -> Vec<(u64, String)> {
    // Regex: \[(\d+):(\d+)(?:\.(\d+))?\]
    // Acepta uno o más timestamps al inicio + texto al final.
    // Implementación con regex crate o parser manual byte-level.
    // ... (ver tests de §5.3 para casos a cubrir)
}
```

Errores: el parser no falla — devuelve un `ParsedLrc` posiblemente vacío. Líneas malformadas se descartan. Esto es deliberado: las letras son input externo no controlado, no queremos que un timestamp roto haga que **toda** la letra se pierda.

### 5.3 Tests críticos

```rust
#[test] fn parses_basic_line()         // [00:25.43]Hello → (25430, "Hello")
#[test] fn parses_multiple_timestamps() // [00:25.43][01:32.10]X → 2 entries
#[test] fn parses_minutes_over_60()    // [60:30.00]Long → 3_630_000ms
#[test] fn parses_empty_line()         // [00:44.62] → (44620, "")
#[test] fn handles_offset_metadata()   // [offset:-500] → metadata.offset_ms = -500
#[test] fn handles_unicode()           // [00:01.00]こんにちは 🎵 → preserved
#[test] fn handles_crlf()              // \r\n separator → 2 lines
#[test] fn ignores_malformed_lines()   // garbage + valid → 1 line
#[test] fn sorts_lines_by_timestamp()  // out-of-order input → sorted output
#[test] fn strips_bom()                // \u{FEFF} prefix → ignored
```

### 5.4 Aplicación del offset

El tag `[offset:N]` y el `offset_ms` configurable por el usuario se aplican **al consumir**, no al parsear (para no destruir timestamps originales):

```rust
pub fn effective_timestamp_ms(line: &LrcLine, lrc_offset: i64, user_offset: i64) -> u64 {
    let raw = line.timestamp_ms as i64;
    (raw + lrc_offset + user_offset).max(0) as u64
}
```

---

## 6. Backend — Fase 1 (sin trait)

### 6.1 Estructura

```
src-tauri/src/lyrics/
├── mod.rs          # fetch_lyrics + tipos públicos
├── lrc.rs          # parser LRC + tests
├── embedded.rs     # try_embedded — lee USLT/SYLT con lofty
└── lrclib.rs       # try_lrclib — HTTP a LRCLIB
```

### 6.2 Tipos compartidos

```rust
// src-tauri/src/contracts.rs (extender)

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub track_id: i64,
    pub synced_lyrics: Option<String>,
    pub plain_lyrics: Option<String>,
    pub source: String,            // 'embedded' | 'lrclib' | 'manual'
    pub source_id: Option<String>,
    pub confidence: Option<f64>,
    pub offset_ms: i64,
    pub status: String,            // 'found' | 'not_found' | 'manual_pending'
}
```

### 6.3 Función principal

```rust
// src-tauri/src/lyrics/mod.rs
use crate::errors::{AppError, AppResult};

pub struct LyricsQuery<'a> {
    pub track_id: i64,
    pub artist: &'a str,
    pub title: &'a str,
    pub album: Option<&'a str>,
    pub duration_seconds: u32,
    pub file_path: &'a Path,
}

/// Cascade Embedded → LRCLIB. Devuelve `Some` si **alguno** encontró algo
/// (synced o plain). Si Embedded da plain y LRCLIB da synced, gana LRCLIB.
/// Si Embedded da synced, no consultamos LRCLIB.
pub async fn fetch_lyrics(
    pool: &SqlitePool,
    http: &reqwest::Client,
    query: LyricsQuery<'_>,
) -> AppResult<Option<Lyrics>> {
    // 1. Embedded
    if let Some(found) = embedded::try_embedded(query.file_path).await? {
        if found.synced_lyrics.is_some() {
            return Ok(Some(persist(pool, query.track_id, found).await?));
        }
        // Plain only — guardamos como tentativa pero seguimos buscando synced.
        let best_plain = found;
        if let Some(synced) = lrclib::try_lrclib(http, &query).await? {
            if synced.synced_lyrics.is_some() {
                return Ok(Some(persist(pool, query.track_id, synced).await?));
            }
        }
        return Ok(Some(persist(pool, query.track_id, best_plain).await?));
    }

    // 2. LRCLIB (sin plain previo de embedded)
    if let Some(found) = lrclib::try_lrclib(http, &query).await? {
        return Ok(Some(persist(pool, query.track_id, found).await?));
    }

    // 3. Nada
    persist_not_found(pool, query.track_id).await?;
    Ok(None)
}
```

`try_embedded` y `try_lrclib` devuelven `AppResult<Option<Lyrics>>`. **No usar `anyhow`** — el proyecto ya tiene `AppError` (`thiserror`-based) en [src-tauri/src/errors.rs](../src-tauri/src/errors.rs). Errores de red de `reqwest` se convierten via `From` impl que agregamos.

### 6.4 Field fallback en LRCLIB

Si el match exacto falla, intentar variantes antes de rendirse:

```
1. (artist, title, album, duration)  ← más específico
2. (artist, title, duration)          ← sin album
3. (artist, title)                    ← último intento
```

Cada variante = 1 request. Suele valer la pena: el match exacto a veces falla por un dato menor en el album.

### 6.5 Confidence por duration delta

```rust
fn confidence_from_duration(returned: f32, expected: u32) -> f32 {
    let diff = (returned as i32 - expected as i32).abs();
    match diff {
        0..=2 => 1.0,
        3..=5 => 0.8,
        _ => 0.5,
    }
}
```

Si `confidence < 0.8`, el frontend muestra un warning visual ("low confidence — may be a different version").

### 6.6 Refactor a trait — Fase 2

Sólo cuando se sume Genius (3er provider), refactorizar a:

```rust
#[async_trait]
pub trait LyricsProvider: Send + Sync {
    fn name(&self) -> &str;
    fn supports_synced(&self) -> bool;
    async fn fetch(&self, q: &LyricsQuery<'_>) -> AppResult<Option<Lyrics>>;
}

pub struct LyricsResolver {
    providers: Vec<Box<dyn LyricsProvider>>,
}
```

Antes de Fase 2 esto es ceremonia para 2 funciones. CLAUDE.md: "preferir patrones simples sobre abstracciones prematuras".

---

## 7. Sincronización con la reproducción (frontend)

### 7.1 Hook adaptado al singleton audio

Nuestro `<audio>` es singleton fuera del JSX (ver [ARCHITECTURE.md §6.2](./ARCHITECTURE.md#62-singleton-de-audio-fuera-del-jsx)) — el hook **no** recibe un `audioRef`, lee el singleton directo:

```typescript
// src/hooks/useSyncedLyrics.ts
import { useEffect, useState, useRef } from "react";
import { getAudioElement } from "../audio/element";

interface LrcLine { timestampMs: number; text: string; }

export function useSyncedLyrics(lines: LrcLine[], userOffsetMs: number = 0) {
  const [activeLineIndex, setActiveLineIndex] = useState(-1);
  const cursorRef = useRef(-1);

  useEffect(() => {
    const audio = getAudioElement();
    if (lines.length === 0) return;

    let rafId = 0;

    const update = () => {
      const currentMs = audio.currentTime * 1000 - userOffsetMs;
      let cursor = cursorRef.current;
      while (cursor + 1 < lines.length && lines[cursor + 1].timestampMs <= currentMs) cursor++;
      while (cursor >= 0 && lines[cursor].timestampMs > currentMs) cursor--;
      if (cursor !== cursorRef.current) {
        cursorRef.current = cursor;
        setActiveLineIndex(cursor);
      }
    };

    const tick = () => { update(); rafId = requestAnimationFrame(tick); };
    const onPlay = () => { rafId = requestAnimationFrame(tick); };
    const onPause = () => { cancelAnimationFrame(rafId); };
    const onSeeked = () => { cursorRef.current = -1; update(); };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("seeked", onSeeked);
    if (!audio.paused) onPlay();

    return () => {
      cancelAnimationFrame(rafId);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("seeked", onSeeked);
    };
  }, [lines, userOffsetMs]);

  return activeLineIndex;
}
```

### 7.2 Por qué `requestAnimationFrame` y no `timeupdate`

`timeupdate` dispara cada ~250ms — la línea cambia con delay perceptible. `requestAnimationFrame` corre a la velocidad del display (~60Hz). Costo de CPU despreciable: la operación interna es comparación de números.

Convive bien con el rAF del visualizer (ambos hooks pueden correr simultáneamente; el browser los unifica).

### 7.3 Cursor incremental vs binary search

El hook arriba usa cursor incremental: O(1) amortizado durante reproducción normal. Si en el futuro hay seeks frecuentes y el cursor se desincroniza mucho, switch a binary search (O(log n)). Para <1000 líneas ambos son indistinguibles en performance; cursor es más natural para reproducción lineal.

---

## 8. UI brutalist

### 8.1 Layout — Fase 1

Panel lateral derecho del PLAYER view, toggleable:

```
┌─────────────────────────────────────────────────────────┐
│ NIRVANA — COME AS YOU ARE                       03:39   │
├──────────────────────────────────┬──────────────────────┤
│                                  │                      │
│    Come as you are, as you were  │                      │  ← gris
│    As I want you to be           │                      │  ← fg, recién pasada
│                                  │                      │
│ ► AS A FRIEND, AS A FRIEND ◄     │                      │  ← acento, GRANDE
│                                  │                      │
│    As an old enemy               │                      │  ← fg α=0.7
│    Take your time, hurry up      │                      │
│                                  │                      │
│ ──────────────────────────────── │                      │
│ Offset: 0ms [-100][-10][+10][+100][RESET]               │
└─────────────────────────────────────────────────────────┘
```

### 8.2 Estados visuales

| Estado | Color | Tamaño | Peso | Transformación |
|---|---|---|---|---|
| Pasada (>2s atrás) | `--muted` | base | normal | — |
| Recién pasada (<2s) | `--fg` | base | normal | fade a muted (200ms) |
| **Activa** | `--accent` | 1.5–2x | bold | UPPERCASE |
| Próxima (siguiente) | `--fg` α=0.7 | base | normal | — |
| Futura lejana | `--muted` | base | normal | — |

**Detalle brutalist:** la línea activa aparece **on/off**, sin transición de aparición. La única transición es el fade-out de la anterior (~200ms).

### 8.3 Auto-scroll

```typescript
useEffect(() => {
  if (activeLineIndex >= 0) {
    activeLineRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }
}, [activeLineIndex]);
```

### 8.4 Estados vacíos

**Sin letras:**
```
NO LYRICS AVAILABLE
Tried: EMBEDDED · LRCLIB
[SEARCH AGAIN]                  ← Fase 2
[PASTE MANUALLY]                ← Fase 2
```

**Solo plain:**
```
PLAIN LYRICS ONLY
No synced version found.

Come as you are, as you were
As I want you to be
...
[SEARCH FOR SYNCED]             ← Fase 2
```

**Track instrumental** (LRCLIB devolvió `instrumental: true`):
```
♪ INSTRUMENTAL ♪
This track has no lyrics.
```

**Confidence baja (Fase 1, warning visible):**
```
⚠ LOW CONFIDENCE — duration mismatch (track 3:39 vs lyrics 4:12)
```

### 8.5 Control de offset (Fase 1)

```
Offset: -250ms  [-100] [-10] [+10] [+100] [RESET]
```

Persiste en `lyrics.offset_ms` automáticamente al cambiar (debounce 300ms para no spammear DB writes).

**UX:** botones visibles sólo en hover sobre el panel. No saturar default.

### 8.6 Click en línea → seek

```typescript
function onLineClick(line: LrcLine, userOffsetMs: number) {
  getAudioElement().currentTime = (line.timestampMs + userOffsetMs) / 1000;
}
```

### 8.7 Manual paste / edit — Fase 2

Modal con tabs PLAIN / LRC SYNCED, textarea, validación al guardar (parser LRC corre, si falla mostrar errores). Persiste con `source = 'manual'`, `status = 'found'`.

---

## 9. Comandos Tauri y eventos

### 9.1 Comandos Fase 1

```rust
// src-tauri/src/commands/lyrics.rs

#[tauri::command]
pub async fn lyrics_fetch(
    track_id: i64,
    pool: State<'_, SqlitePool>,
    http: State<'_, reqwest::Client>,  // se registra en lib.rs setup()
) -> AppResult<Option<Lyrics>> {
    // 1. Si ya está cacheado (status='found' o 'not_found'), devolver cache.
    // 2. Si no, leer track de DB, armar LyricsQuery, llamar fetch_lyrics().
    // 3. Persistir + devolver.
}

#[tauri::command]
pub async fn lyrics_set_offset(
    track_id: i64,
    offset_ms: i64,
    pool: State<'_, SqlitePool>,
) -> AppResult<()> {
    // UPDATE lyrics SET offset_ms = ? WHERE track_id = ?
}
```

Registro en `lib.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existentes
    commands::lyrics::lyrics_fetch,
    commands::lyrics::lyrics_set_offset,
])
```

### 9.2 Comandos Fase 2

```rust
lyrics_refetch(track_id) -> Option<Lyrics>           // ignora cache not_found
lyrics_save_manual(track_id, synced, plain) -> ()    // source='manual'
lyrics_delete(track_id) -> ()                        // borra cache
```

### 9.3 Eventos backend → frontend

```rust
"lyrics-fetch-started"   { track_id }
"lyrics-fetched"         { track_id, source, has_synced }
"lyrics-fetch-failed"    { track_id, error }
```

Permite que la UI muestre spinner / estado sin esperar al return de `invoke()`.

---

## 10. Adaptaciones a la base de código actual

Nuestra base difiere del doc original en varios puntos. **Antes de implementar**, alinear:

1. **Errores:** usar `AppResult<T>` (alias de `Result<T, AppError>`). Agregar variantes a `AppError` si hace falta (`Http(reqwest::Error)`, `Parse(String)`). **No introducir `anyhow`.**

2. **State Tauri:** comandos reciben `State<'_, SqlitePool>` directo, no un `AppState` compuesto. Para `reqwest::Client`, registrarlo como segundo state en `lib.rs setup()`:
   ```rust
   let http = reqwest::Client::builder()
       .user_agent("BrutalistPlayer/0.1 ( https://github.com/<user>/<repo> )")
       .build()?;
   app.manage(http);
   ```

3. **HTTP client:** `reqwest` con `default-features = false, features = ["rustls-tls", "json"]`. Sin OpenSSL → menos fricción de build cross-platform.

4. **Audio element:** singleton fuera del JSX. Hooks que necesiten `<audio>` lo importan:
   ```typescript
   import { getAudioElement } from "../audio/element";
   ```
   No `useRef<HTMLAudioElement>` ni `audioRef` props.

5. **Stores:** crear `lyricsStore` o extender `playerStore`. Decisión al implementar — probablemente nuevo store, paralelo a `libraryStore`/`downloadStore`. Persiste sólo `panelOpen: boolean` (toggle del panel).

6. **Cargo.toml — deps nuevas:**
   ```toml
   reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }
   regex = "1"  # para parser LRC (o parser manual)
   ```

7. **Variantes de `AppError` a agregar:**
   ```rust
   #[error("http error: {0}")]
   Http(#[from] reqwest::Error),
   ```

---

## 11. Estrategia de fetch — cuándo llamar

### Fase 1

- **Trigger principal:** al cambiar de track. En `playerStore.playTrack` (o un hook que escuche `currentTrackId`), disparar `invoke('lyrics_fetch', { trackId })`.
- **Cache check:** el comando primero consulta DB; sólo pega a la red si no hay row.
- **Concurrencia:** una fetch a la vez por track. Si el usuario salta de track antes del return, el resultado igual se persiste — se descarta sólo el render.

### Fase 2

- **Refetch botón:** force fetch ignorando cache.
- **Background fetch al downloadear:** después de `download-completed`, encolar `lyrics_fetch` para el nuevo track. Best-effort.

---

## 12. Riesgos

| Riesgo | Probabilidad | Mitigación | Fase |
|---|---|---|---|
| LRCLIB cambia API o cae | Baja | Cascade falla a Genius (Fase 2). Logs claros. | 1 |
| Letras con duración distinta al track | Alta | Confidence + warning visual. | 1 |
| Genius cambia HTML, scraping rompe | Media | Provider falla gracefully; tests con HTML fixture. | 2 |
| Usuario edita metadata, lyrics quedan stale | Media | Botón "Re-search" (Fase 2). Clear cache al cambiar artist/title. | 2 |
| Performance del rAF loop en tracks largos | Baja | Cursor optimizado O(1). | 1 |
| RTL (árabe, hebreo) | Baja-Media | CSS `direction: rtl` autodetect por contenido. Probar. | 1 |
| Caracteres especiales en queries (acentos, comillas) | Media | URL-encoding correcto (`reqwest .query(&[...])` lo hace). Tests Unicode. | 1 |
| Match incorrecto (live vs studio) | Media | Confidence + warning. Re-search manual. | 1 / 2 |

---

## 13. Decisiones abiertas

A cerrar al implementar Fase 1:

1. **Parser LRC: regex vs byte-level manual.** Regex es 5 líneas pero agrega `regex` crate (~500KB compiled). Manual es 30 líneas sin deps. Probablemente regex.
2. **Auto-fetch al cambiar de track vs lazy fetch al abrir el panel.** Auto-fetch da UX inmediata pero gasta requests si el panel está cerrado. Probablemente lazy + cache.
3. **`lyricsStore` vs extender `playerStore`.** Probablemente nuevo store (separación clara, mismo patrón que `downloadStore`).
4. **Toggle del panel: shortcut keyboard?** Probablemente `L`. Definir al hacer la UI.

A cerrar al implementar Fase 2:

5. **Refactor a trait timing.** ¿Esperar al 3er provider o anticiparse? Esperar — CLAUDE.md.
6. **`scraper` vs `select` vs `nipper` para Genius.** Probablemente `scraper`.
7. **Submit a LRCLIB de letras manuales.** Útil pero opcional.

---

## 14. Próximos pasos

**Antes de implementar lyrics:**

1. ✅ Cerrar persistencia de último track (Fase 1 del proyecto).
2. ⏳ Cerrar **crossfade** (Fase 1 del proyecto).
3. ⏳ Verificar estabilidad general durante una semana de uso real.

**Implementar Fase 1 de lyrics (este doc):**

4. Migración 4.2 (aditiva).
5. Parser LRC + tests (5).
6. `try_embedded` + `try_lrclib` + `fetch_lyrics` (6).
7. Comandos `lyrics_fetch` + `lyrics_set_offset` (9.1).
8. `useSyncedLyrics` hook (7.1).
9. UI panel lateral (8) + integración con player view.
10. Validar con 20-30 tracks reales: medir hit rate, ajustar field fallback.

**Reevaluar antes de Fase 2:**

11. ¿Cuántos tracks quedaron `not_found` en Fase 1? Si <20%, Genius no aporta. Si >40%, sí.
12. ¿Apareció demanda real de manual paste? Si sí, priorizar; si no, dejar.

---

*Doc vivo. Actualizar conforme se cierren decisiones abiertas durante implementación.*
