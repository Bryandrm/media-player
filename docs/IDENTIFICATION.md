# IDENTIFICATION.md — Identificación canónica de audio (AcoustID + Chromaprint)

> Sub-sistema para identificar tracks por **fingerprint acústico** y obtener un MBID canónico de MusicBrainz. Permite eliminar de raíz los problemas de "metadata sucia" + "match incorrecto por versión distinta" que en Fase 1 mitigamos con heurísticas.
> Cross-refs: [LYRICS.md Fase 3](./LYRICS.md#fase-3--avanzado), [PLAN-reproductor-brutalist.md §6](./PLAN-reproductor-brutalist.md#6-roadmap-por-fases), [ARCHITECTURE.md](./ARCHITECTURE.md), [CLAUDE.md](../CLAUDE.md).

---

## 0. Plan por fases

Tres fases. Cada una se desbloquea sólo cuando la anterior lleva al menos una semana de uso real sin romper. Sin scope creep entre fases.

### Fase 1 — MVP on-demand (single-track)

Caso minimal: el usuario hace click en **IDENTIFY** sobre un track de la library, la app calcula el fingerprint, lo manda a AcoustID, recibe un MBID, lo persiste, y lo usa para refetchear letras desde LRCLIB con match exacto por MBID.

- **Tooling:** `fpcalc` (Chromaprint) como dep del sistema, mismo patrón que yt-dlp/ffmpeg. Detect-and-banner si falta.
- **Backend:** dos `async fn` libres en `src-tauri/src/identification/`. Sin trait, sin resolver pattern (mismo principio que Lyrics Fase 1).
- **API key AcoustID:** en `settings` table (no env, no bundlear). UI para pegarla en SETTINGS view.
- **Schema:** migración aditiva sobre `tracks` (5 columnas — fingerprint + acoustid_id + mbid + status + attempted_at).
- **UI:** botón "IDENTIFY" en cada row de library (al lado del indicador `L`) + indicador de status (✓/—/⌛).
- **Cascade lyrics:** después de identificar, re-fetch lyrics priorizando MBID (LRCLIB acepta `track_mbid` como query param exacto).
- **Sin:** bulk backfill, auto-identify on import, ambigüedad picker (si AcoustID devuelve múltiples matches → tomar el de mayor score y persistir; el alternative picker es Fase 3).

### Fase 2 — Backfill bulk

Sólo cuando Fase 1 lleve unos días en uso y haya validado el end-to-end con varios tracks reales.

- **Botón "IDENTIFY ALL"** en `LibraryToolbar` (mismo patrón que "CLEAN METADATA"). Procesa todos los tracks con `identification_status IS NULL` o `'failed'`.
- **Rate limiting:** AcoustID free tier es 3 req/seg. Throttle backend-side con un semaphore de tokio.
- **Progress events:** stream `identification-progress` con `{ done, total, current_title }` para que la UI muestre una barra (mismo patrón que downloads).
- **Cancelable:** botón "STOP" durante el run. Idempotente — si lo cortás a mitad, retomás desde donde quedó.
- **Telemetry mínima en logs:** match rate, tracks con `failed`, tracks con score bajo. No analytics — stdout debug.

### Fase 3 — Auto + ambigüedad

No comprometido. Se evalúa según el match rate real que veamos en Fase 2.

- **Auto-identify on import** (scan dir + download): después de `lofty::extract_metadata`, encolar fingerprint + AcoustID lookup. Best-effort, no bloquea import.
- **Ambiguity picker:** cuando AcoustID devuelve ≥2 matches con scores cercanos (delta <0.1), modal con la lista (artist/title/album/year/duration de cada candidato) y el usuario elige. Persistir esa elección.
- **Re-identify** botón en track context menu (forzar refetch ignorando cache, útil si reemplazaste el archivo).
- **MusicBrainz extras:** una vez que tenemos MBID podemos pedir más metadata (release year correcto, original album, etc.). Probablemente no aporta para nuestro caso de uso (visualizer + lyrics) pero la puerta queda abierta.
- **Submit to AcoustID:** si el track no tiene match pero la metadata es confiable, ofrecer enviar el fingerprint+metadata a AcoustID (contribución a la comunidad). Requiere user-musicbrainz-account, scope de portfolio personal probablemente no lo justifica.

---

## 1. Contexto y objetivos

### 1.1 El problema que resolvemos

Fase 1 (lyrics) cierra con dos heurísticas que cubren los casos comunes pero no escalan:

1. **Cleanup de metadata yt-dlp** ([audio/cleanup.rs](../src-tauri/src/audio/cleanup.rs)): strip de `OfficialVEVO`, `(Official Video)`, prefijo `<artist> - ` en title, etc. Conservador a propósito (prefiere falsos negativos).
2. **LRCLIB search fallback** ([lyrics/lrclib.rs](../src-tauri/src/lyrics/lrclib.rs)): si `/api/get` exact-match falla, prueba `/api/search` fuzzy con penalty `confidence × 0.85`.

Estas dos cubren ~80% de los tracks del autor. Los casos que escapan:

- **Artistas con uploader != artist real** (ej: LOSTPROPHETS subido por un canal "EZBAND-OFFICIAL"). Las heurísticas no saben que el artista correcto es "Lostprophets" porque eso requiere conocer la canonicalización.
- **"David Guetta Feat. Akon - Sexy Bitch"** vs LRCLIB que la tiene como `artist="David Guetta"`, `featured="Akon"`. Match text falla por el `Feat.` en title.
- **Drift por edición distinta:** LRCLIB tiene la versión album cut (4:23) pero el track del usuario es la radio edit (3:35). El offset constante no alcanza — necesitarías `speedRatio` (ver LYRICS Fase 2). Pero el problema raíz es que LRCLIB devolvió la edición incorrecta.

AcoustID resuelve los tres casos porque identifica el **audio**, no la metadata. Si dos archivos tienen la misma waveform (mismo master, mismo encoding aproximado), tienen el mismo fingerprint y el mismo MBID — independientemente de cómo estén taggeados.

### 1.2 Objetivos

- **Match rate ~95%+** para mainstream occidental (donde MusicBrainz tiene cobertura completa).
- **Match exacto contra LRCLIB** vía MBID (campo `track_mbid` del endpoint `/api/get`), eliminando la fuzzy search.
- **Cero falsos positivos** en metadata correction. Si AcoustID está dudoso (score <0.85 o múltiples matches con scores cercanos), no hacemos nada — preferimos quedarnos con la metadata sucia que pisarla con la equivocada.
- **Operación opt-in.** El usuario aprieta IDENTIFY (Fase 1) o IDENTIFY ALL (Fase 2). No hacemos llamadas de red en background sin pedir.

### 1.3 No-objetivos

- **No re-encodear ni mover archivos.** AcoustID nos da metadata canónica, no toca el archivo. Las columnas `title`/`artist` de la DB sí se actualizan; los tags ID3 del archivo no (esa es responsabilidad de un tag editor, fuera de scope).
- **No usar AcoustID para buscar covers.** Existe la opción vía MusicBrainz Cover Art Archive, pero ya tenemos cover via lofty + sibling fallback. Quedaría como mejora opcional Fase 3.
- **No bundlear `fpcalc`** en el binario. Mismo razonamiento que yt-dlp/ffmpeg — el usuario instala con `brew install chromaprint` (macOS) / `apt install libchromaprint-tools` (Debian) / portable binary (Windows).

---

## 2. Cómo funciona Chromaprint + AcoustID

Tres piezas separadas pero diseñadas para encadenarse:

### 2.1 Chromaprint — el algoritmo de fingerprint

Open source. Lo escribió Lukáš Lalinský (creador de MusicBrainz Picard). Conceptualmente:

1. Decodifica el audio a PCM mono 11025 Hz (descarta calidad para que el fingerprint sea robusto a re-encoding y bitrate distinto).
2. Calcula **chromas** (vector de 12 floats — uno por nota cromática) en ventanas overlapping de ~0.12s.
3. Aplica filtros y comparaciones byte a byte para producir un array de `i32` (~1 valor por ventana).
4. Encodea ese array a un string base64 compacto: el fingerprint.

Características útiles:

- **Robusto a:** re-encoding (mp3 vs flac vs opus), bitrate distinto, ligeras diferencias de mastering, EQ leve.
- **Frágil ante:** speed/pitch shift, edits con secciones removidas, mezcla de dos canciones, live performances vs studio.
- **Tamaño:** un fingerprint de un track de 4min son ~80-200 bytes en base64. Fits in a TEXT column sin problemas.
- **Computable rápido:** ~200-500ms por track en CPU moderna. Con 1000 tracks → ~5-8 min de CPU full + I/O. En Fase 2 con throttle por rate limit → ~6 min mínimo (3 req/seg × 1000 tracks).

### 2.2 `fpcalc` — la CLI de Chromaprint

Binario que viene con la lib `chromaprint`. Uso:

```bash
fpcalc -json /path/to/track.mp3
```

Output:

```json
{"duration": 219.43, "fingerprint": "AQAAYUmSJEoSJYmS..."}
```

Eso es todo. `duration` es la duración decodificada por `fpcalc` (puede diferir leve del campo `duration` de los tags — usar **siempre** el de fpcalc para la query a AcoustID).

Razones para usar el binario en lugar de linkear `chromaprint` como crate Rust:

- **Mismo patrón que ya tenemos** con yt-dlp y ffmpeg. El usuario ya está acostumbrado a instalar deps.
- **No hay binding Rust de `chromaprint` mantenido**. Hay [`rust-chromaprint`](https://crates.io/crates/chromaprint) pero está sin updates desde 2019. Linkear C requiere `bindgen` + `pkg-config` + setup cross-platform → muchísima fricción para 0 ganancia.
- **`fpcalc` es chiquito** (~1.5MB en macOS via brew, parte del paquete `chromaprint`).

### 2.3 AcoustID — la base de datos comunitaria

Sitio: https://acoustid.org · Docs API: https://acoustid.org/webservice

- Open source, comunitario (fork conceptual de MusicBrainz para la pieza acústica).
- Free tier: **API key requerida** + **rate limit 3 req/seg**. Aplicación se registra en https://acoustid.org/applications/.
- Endpoint principal: `GET https://api.acoustid.org/v2/lookup?client=<KEY>&duration=<sec>&fingerprint=<base64>&meta=recordings`.
- Devuelve JSON con `results: [{ id, score, recordings: [{ id (MBID), title, artists, duration }] }]`. `id` del result es el **AcoustID ID** (UUID propio de AcoustID); el `id` de cada recording es el **MBID** de MusicBrainz (lo que queremos para LRCLIB).

Ejemplo response (truncado):

```json
{
  "status": "ok",
  "results": [
    {
      "id": "9eb4d22e-3bbf-46b1-8feb-d2fc5c7f6c44",
      "score": 0.987,
      "recordings": [
        {
          "id": "3bf6f72f-ae87-4c91-bdcc-cc40d51f3c25",
          "title": "The Nights",
          "artists": [{"id": "...", "name": "Avicii"}],
          "duration": 176
        }
      ]
    }
  ]
}
```

**`score`** es la confianza del match acústico (0..1). **Threshold conservador propuesto: 0.85**. Por debajo no aceptamos. AcoustID en práctica devuelve `score >= 0.95` cuando hay match real; valores entre 0.5 y 0.85 suelen ser ruido o samples superpuestos.

### 2.4 LRCLIB con metadata canónica

> **Nota (corregida durante implementación 2026-05-02):** Inicialmente este doc
> proponía hacer lookup directo a LRCLIB por MBID (`?track_mbid=<uuid>`).
> Verificación contra la API real (`curl https://lrclib.net/api/get?track_mbid=...`)
> confirmó que **LRCLIB no soporta lookup por MBID** en ningún endpoint
> documentado — `/api/get` exige `track_name`+`artist_name`, y `/api/search`
> con variantes `?mbid=` o `?recording_mbid=` devuelve `[]`.
>
> El valor real de AcoustID en Fase 1 es entonces **darnos metadata canónica
> limpia** que feedea al cascade text-based existente de LRCLIB. El MBID se
> persiste en `tracks.mbid_recording` para usos futuros (Fase 3 ambiguity
> picker, MusicBrainz extras), pero no participa en el cascade actual.

Comparación práctica de comportamiento antes/después de identification:

| Escenario | Antes (sin AcoustID) | Después de IDENTIFY |
|---|---|---|
| Avicii The Nights con tags `artist="AviciiOfficialVEVO"` | match exacto LRCLIB falla → fuzzy fallback con confidence 0.85 (penalty) | `artist` se sobreescribe con `"Avicii"`; LRCLIB exact match |
| David Guetta Feat. Akon con title `"David Guetta - Sexy Bitch (Feat. Akon)"` | fuzzy match, posiblemente devuelve la versión equivocada | canonical title `"Sexy Bitch"` y artist `"David Guetta"`; exact match LRCLIB con feature MB linkeado |
| Track no existente en MusicBrainz (release nuevo, indie obscure) | text-based lookup hace lo que puede | `no_match`; metadata se queda igual; cascade text-based corre como antes |

**Mecánica del re-fetch:** después de un match aceptado, el comando
`identification_identify_track` borra la fila de `lyrics` para ese track
(mismo patrón que `library_backfill_metadata`) — el siguiente
`lyrics_fetch` ve cache miss y corre el cascade con la metadata fresca.

---

## 3. Esquema de DB

### 3.1 Migración aditiva

```sql
-- 20260510000001_identification.sql
ALTER TABLE tracks ADD COLUMN acoustid_fingerprint TEXT;
ALTER TABLE tracks ADD COLUMN acoustid_id TEXT;
ALTER TABLE tracks ADD COLUMN mbid_recording TEXT;
ALTER TABLE tracks ADD COLUMN identification_status TEXT;
ALTER TABLE tracks ADD COLUMN identification_attempted_at DATETIME;

-- Backup de la metadata original ANTES de pisarla con la canónica de
-- AcoustID. Permite revertir si el match resultó incorrecto. Se popula
-- sólo cuando identification_status pasa a 'identified' por primera
-- vez — si ya tenían valor previo (re-identify futuro), no se sobreescribe.
ALTER TABLE tracks ADD COLUMN original_title TEXT;
ALTER TABLE tracks ADD COLUMN original_artist TEXT;

CREATE INDEX idx_tracks_mbid ON tracks(mbid_recording);
CREATE INDEX idx_tracks_id_status ON tracks(identification_status);
```

Valores de `identification_status`:

- `NULL` — nunca se intentó (default).
- `'identified'` — AcoustID devolvió un match con score ≥ threshold; `acoustid_id` y `mbid_recording` están poblados.
- `'low_confidence'` — AcoustID devolvió matches pero todos con score < 0.85. `acoustid_id` y `mbid_recording` quedan NULL (no aceptamos el match), pero registramos que ya intentamos.
- `'no_match'` — AcoustID devolvió `results: []`. Track no está en la base.
- `'fingerprint_failed'` — `fpcalc` falló sobre el archivo (corrupto, formato no soportado, etc).
- `'api_error'` — error de red o quota excedida; **es retriable** (a diferencia de los anteriores).

`acoustid_fingerprint` se guarda **siempre que `fpcalc` haya tenido éxito**, incluso si AcoustID falló — así un retry no recalcula el fingerprint. `identification_attempted_at` se actualiza en cada intento; útil para política "no retriar `low_confidence`/`no_match` antes de N días" (Fase 2/3).

### 3.2 Por qué `mbid_recording` y no `mbid`

MusicBrainz tiene varias entidades con MBID: artist, release, recording, work. Lo que AcoustID nos devuelve es siempre **recording MBID** (la grabación específica, no el "song" abstracto). LRCLIB usa también recording MBID. Nombramos la columna explícito para no confundir si en el futuro queremos guardar también `mbid_release` (album) o `mbid_artist`.

### 3.3 Settings: API key

Reusar la tabla `settings` existente (`(key, value)`). Key propuesta: `acoustid_api_key`. UI: input password en SETTINGS view (Fase 1 puede ser un prompt simple — input + save — sin construir aún la SETTINGS view completa).

---

## 4. Backend — Fase 1

### 4.1 Estructura

```
src-tauri/src/identification/
├── mod.rs          # identify_track (entrypoint) + tipos públicos
├── fpcalc.rs       # spawn fpcalc + parse JSON output
└── acoustid.rs     # HTTP a AcoustID API + parse response
```

Patrón idéntico al de `lyrics/`: dos funciones libres + un entrypoint cascade. Sin trait. Cuando llegue una segunda fuente de identificación (ej: Shazam API si entra en Fase 3), refactorizamos a trait — antes es ceremonia.

### 4.2 Tipos compartidos

```rust
// src-tauri/src/contracts.rs (extender Track)

#[derive(...)]
pub struct Track {
    // ... campos existentes ...
    pub acoustid_id: Option<String>,
    pub mbid_recording: Option<String>,
    pub identification_status: Option<String>,
}

// src-tauri/src/identification/mod.rs

pub struct IdentificationResult {
    pub fingerprint: String,
    pub duration_seconds: f32,
    pub acoustid_id: Option<String>,
    pub mbid_recording: Option<String>,
    pub canonical_title: Option<String>,
    pub canonical_artist: Option<String>,
    pub status: IdentificationStatus,
}

#[derive(Debug, Clone, Copy)]
pub enum IdentificationStatus {
    Identified,        // score >= 0.85, MBID poblado
    LowConfidence,     // hubo matches pero todos < threshold
    NoMatch,           // results: []
    FingerprintFailed, // fpcalc error
    ApiError,          // red / 5xx / quota
}
```

### 4.3 Función principal

```rust
// src-tauri/src/identification/mod.rs

pub async fn identify_track(
    pool: &SqlitePool,
    http: &reqwest::Client,
    track_id: i64,
    file_path: &Path,
    api_key: &str,
) -> AppResult<IdentificationResult> {
    // 1. Reusar fingerprint si ya lo calculamos antes (status='api_error' retry).
    let cached_fp = db::tracks::get_acoustid_fingerprint(pool, track_id).await?;

    let (fingerprint, duration) = match cached_fp {
        Some(fp) => {
            let dur = db::tracks::get_duration_seconds(pool, track_id).await?;
            (fp, dur)
        }
        None => match fpcalc::compute(file_path).await {
            Ok((fp, dur)) => {
                db::tracks::save_fingerprint(pool, track_id, &fp).await?;
                (fp, dur)
            }
            Err(e) => {
                db::tracks::update_identification_status(
                    pool, track_id, IdentificationStatus::FingerprintFailed,
                ).await?;
                return Err(e);
            }
        },
    };

    // 2. AcoustID lookup.
    match acoustid::lookup(http, api_key, &fingerprint, duration).await {
        Ok(Some(best)) if best.score >= 0.85 => {
            db::tracks::save_identification(
                pool, track_id, &best.acoustid_id, &best.mbid, &best.title, &best.artist,
            ).await?;
            // ... return IdentificationResult { ... Identified }
        }
        Ok(Some(_)) => {
            db::tracks::update_identification_status(
                pool, track_id, IdentificationStatus::LowConfidence,
            ).await?;
            // ... return LowConfidence
        }
        Ok(None) => {
            db::tracks::update_identification_status(
                pool, track_id, IdentificationStatus::NoMatch,
            ).await?;
            // ... return NoMatch
        }
        Err(e) => {
            db::tracks::update_identification_status(
                pool, track_id, IdentificationStatus::ApiError,
            ).await?;
            return Err(e);
        }
    }
}
```

### 4.4 `fpcalc::compute`

```rust
// src-tauri/src/identification/fpcalc.rs
use tokio::process::Command;
use serde::Deserialize;

#[derive(Deserialize)]
struct FpcalcOutput {
    duration: f32,
    fingerprint: String,
}

pub async fn compute(path: &Path) -> AppResult<(String, f32)> {
    let output = Command::new("fpcalc")
        .arg("-json")
        .arg(path)
        .output()
        .await
        .map_err(AppError::FpcalcSpawn)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::FpcalcFailed(stderr.into_owned()));
    }

    let parsed: FpcalcOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::FpcalcParse(e.to_string()))?;

    Ok((parsed.fingerprint, parsed.duration))
}
```

`fpcalc` no necesita `PYTHONUNBUFFERED` (no es Python; es C++) ni fan-in stdout/stderr — termina rápido y devuelve todo de una.

### 4.5 `acoustid::lookup`

```rust
// src-tauri/src/identification/acoustid.rs

const ENDPOINT: &str = "https://api.acoustid.org/v2/lookup";

pub struct AcoustIdMatch {
    pub score: f64,
    pub acoustid_id: String,
    pub mbid: String,
    pub title: String,
    pub artist: String,
}

pub async fn lookup(
    http: &reqwest::Client,
    api_key: &str,
    fingerprint: &str,
    duration_seconds: f32,
) -> AppResult<Option<AcoustIdMatch>> {
    let response = http
        .get(ENDPOINT)
        .query(&[
            ("client", api_key),
            ("format", "json"),
            ("duration", &(duration_seconds as u32).to_string()),
            ("fingerprint", fingerprint),
            ("meta", "recordings"),
        ])
        .send()
        .await?
        .error_for_status()?;

    let body: AcoustIdResponse = response.json().await?;

    if body.status != "ok" {
        return Err(AppError::AcoustIdStatus(body.error.unwrap_or_default()));
    }

    // Tomar el result con mayor score que tenga al menos un recording con MBID.
    let best = body.results.into_iter()
        .filter_map(|r| {
            let rec = r.recordings.into_iter().find(|rc| !rc.id.is_empty())?;
            Some((r.score, r.id, rec))
        })
        .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    Ok(best.map(|(score, acoustid_id, rec)| AcoustIdMatch {
        score,
        acoustid_id,
        mbid: rec.id,
        title: rec.title.unwrap_or_default(),
        artist: rec.artists
            .and_then(|a| a.first().map(|x| x.name.clone()))
            .unwrap_or_default(),
    }))
}
```

### 4.6 Variantes nuevas en `AppError`

```rust
#[error("fpcalc spawn failed: {0}")]
FpcalcSpawn(#[from] std::io::Error),

#[error("fpcalc failed: {0}")]
FpcalcFailed(String),

#[error("fpcalc output parse error: {0}")]
FpcalcParse(String),

#[error("AcoustID API status not ok: {0}")]
AcoustIdStatus(String),
```

`reqwest::Error` ya está mapeado por la variante `Http` que agregamos en lyrics Fase 1.

### 4.7 Cascade lyrics — sin cambios en `lrclib.rs`

Como descubrimos durante implementación que LRCLIB no acepta MBID
(ver §2.4), `lyrics/lrclib.rs::try_lrclib` **no se modifica**. La integración
con AcoustID ocurre arriba: el comando `identification_identify_track`
sobreescribe `tracks.title` / `tracks.artist` con los valores canónicos y
borra la fila de `lyrics` (cache invalidation). El siguiente `lyrics_fetch`
corre el cascade text-based existente con la metadata limpia y matchea
exact en `/api/get`.

Ventaja de mantener `lrclib.rs` intacto: la lógica de lyrics (cache, fallback
sin album, search fuzzy con duration tolerance) sigue funcionando idéntico
para tracks que **no** se identificaron. Identification es opt-in.

---

## 5. Frontend — Fase 1

### 5.1 Indicador de identificación en library

Agregar columna **ID** en `LibraryTable` (al lado de la columna `L`):

| Status | Render |
|---|---|
| `null` (no intentado) | vacío |
| `'identified'` | `[ID]` en accent |
| `'low_confidence'` | `?` en muted (matches débiles, no aceptados) |
| `'no_match'` | `—` en muted |
| `'fingerprint_failed'` | `!` en muted con tooltip "fpcalc error" |
| `'api_error'` | `⌛` en muted (retriable) |

Mismo patrón visual que el indicador `L`. Width col `w-10`.

### 5.2 Botón IDENTIFY en row context

Tres opciones para el trigger en Fase 1:

- **A. Right-click context menu** sobre la row → "IDENTIFY". Más limpio, no agrega clutter visual.
- **B. Button explícito** en una columna nueva. Más obvio para descubrir.
- **C. Toolbar action** "IDENTIFY CURRENT" (sólo el track que está playing). Mínimo viable pero limita.

**Propuesta default: A (context menu)**. Los context menus son brutalist-friendly (lista plana, sin iconos, fondo opaco con border duro). Si el usuario nunca lo descubre, mover a B en Fase 2.

### 5.3 SETTINGS view mínima

No tenemos SETTINGS view aún. Para Fase 1, opciones:

- **A. Construir SETTINGS view ahora** (PLAN §1.3 ya la tiene en scope, podríamos cerrarla acá).
- **B. Modal one-shot** que aparece cuando el usuario hace click en IDENTIFY por primera vez sin API key configurada. "PASTE ACOUSTID API KEY: [____] [SAVE]" con link a `https://acoustid.org/new-application`.

**Propuesta default: B**. Construir SETTINGS completa es scope creep — la podemos hacer en Fase 2 cuando tengamos varias settings (API key + threshold + auto-identify toggle).

### 5.4 Hook + store

```typescript
// src/stores/identificationStore.ts
interface IdentificationStore {
  identifying: Set<number>;  // track_ids in flight
  identifyTrack: (trackId: number) => Promise<void>;
  apiKey: string | null;
  setApiKey: (key: string) => Promise<void>;
}
```

`identify_track` llama a `invoke('identification_identify_track', { trackId })`, después llama a `loadTracks()` (libraryStore) para refrescar la column ID, después llama a `lyrics_refetch(trackId)` para que las letras se actualicen con MBID.

Persistir nada — `identifying` es runtime, `apiKey` ya queda en `settings` table (el getter inicial lo lee al boot via comando dedicado).

### 5.5 Detect-and-banner para fpcalc

`check_dependencies` ya verifica yt-dlp + ffmpeg. Extender para incluir `fpcalc`:

```rust
pub fn check_dependencies() -> Dependencies {
    Dependencies {
        yt_dlp: which::which("yt-dlp").is_ok(),
        ffmpeg: which::which("ffmpeg").is_ok(),
        fpcalc: which::which("fpcalc").is_ok(),  // NEW
    }
}
```

Si falta `fpcalc`, el `DependencyBanner` lo muestra junto con yt-dlp/ffmpeg. La feature de identification queda gris/disabled hasta que se instale.

---

## 6. Comandos Tauri y eventos

### 6.1 Fase 1

```rust
identification_identify_track(track_id) -> IdentificationResult
identification_get_api_key() -> Option<String>
identification_set_api_key(key) -> ()
```

`identification_identify_track`:
1. Lee track de DB (necesita `file_path`).
2. Lee API key de `settings`. Si no hay → `Err(AppError::AcoustIdNoApiKey)`.
3. Llama `identify_track(...)`.
4. Si `Identified`, dispara internamente `lyrics_refetch(track_id)` (pasarle el MBID).
5. Devuelve `IdentificationResult`.

### 6.2 Fase 2

```rust
identification_identify_all() -> ()              // dispara background job
identification_cancel() -> ()                    // setea cancel flag
```

Eventos:
```
"identification-progress"  { done, total, current_title }
"identification-completed" { ok_count, failed_count, no_match_count }
"identification-cancelled"
```

### 6.3 Eventos Fase 1

`identification_identify_track` es síncrono respecto al frontend (single-shot, takes ~1-2s). No necesita events; suficiente con el `await` del invoke.

---

## 7. Manejo de la API key

### 7.1 Almacenamiento

Tabla `settings`, key `acoustid_api_key`. Plain text — la API key de AcoustID free tier no es sensible (no permite escrituras destructivas, sólo lookups). Si en el futuro queremos OAuth o keys con privilegios elevados, encriptar.

### 7.2 Disclaimer en UI

Cuando el usuario abre el modal por primera vez:

```
ACOUSTID API KEY

To identify tracks, paste your AcoustID API key below.
Get one free at https://acoustid.org/new-application
(no auth required for personal use).

[__________________________________________]

[SAVE]
```

Link al sitio externo (`open(...)` via Tauri shell plugin). Sin auto-fill, sin "demo key" — el usuario es responsable de su propia key.

### 7.3 NO bundlear key del autor

Crítico — esto es portfolio-piece compartible. Si bundleamos la key del autor en el binario:

- Cualquiera que clone el repo la usa.
- AcoustID nos puede revocar la key por uso compartido.
- Es trivial extraerla del binario con `strings`.

Patrón: el usuario instala fpcalc + se registra en AcoustID + pega su key. Mismo nivel de friction que yt-dlp + ffmpeg, ya aceptado.

---

## 8. Riesgos

| Riesgo | Probabilidad | Mitigación | Fase |
|---|---|---|---|
| Usuario olvida instalar `fpcalc` | Alta | DependencyBanner + IDENTIFY button disabled. | 1 |
| AcoustID rate limit (3 req/seg) | Alta en Fase 2 | Throttle backend con `tokio::sync::Semaphore`. | 2 |
| AcoustID devuelve match incorrecto con score alto | Baja | Threshold 0.85 + (Fase 3) ambiguity picker para casos cercanos. | 1 / 3 |
| API key del usuario se filtra | Media | Plain text en SQLite local; no syncamos config. Disclaimer visible. | 1 |
| `fpcalc` muere en formato exótico (opus, dsd, etc) | Media | Status `fingerprint_failed` registrado; tracks afectados no rompen el flujo. | 1 |
| Track no está en MusicBrainz (release nuevo, indie obscure) | Alta | `no_match` registrado. Re-intentar en N días (Fase 3). | 1 |
| Quota free agotada (límite vago en docs) | Media | Status `api_error` retriable + log claro. Si pasa seguido, mover a Fase 3 con cache más agresivo. | 1 |
| MBID lookup en LRCLIB también falla | Media | Cascade al lookup text-based con la metadata canonicalizada por AcoustID (mejor que la metadata original). | 1 |
| Usuario reemplaza el archivo del track (mismo path, audio distinto) | Baja | Fingerprint cacheado queda inválido. Botón "RE-IDENTIFY" en Fase 3. Workaround Fase 1: borrar row y re-scan. | 3 |

---

## 9. Decisiones abiertas

**Cerradas para Fase 1** (decididas 2026-05-02):

1. ✅ **Score threshold = 0.85.** Confirmar con tests reales; si vemos falsos positivos, subir a 0.90.
2. ✅ **Pisar `tracks.title`/`tracks.artist` cuando `status = 'identified'`** (la metadata de yt-dlp es peor que la de MusicBrainz). Guardar las originales en `tracks.original_title`/`original_artist` para poder revertir.
3. ✅ **Trigger UI = context menu (A)** sobre la row. Revisitar si nadie lo descubre.
4. ✅ **API key prompt = modal one-shot (B).** SETTINGS view full queda para Fase 2 cuando haya más settings que justifiquen la vista; no es bloqueante.

A cerrar al implementar Fase 1:

5. **`fpcalc` en macOS Apple Silicon:** verificar que `brew install chromaprint` instala arm64 nativo. Si sólo hay x86_64 vía Rosetta, agregar a la guía de instalación.

A cerrar al implementar **Fase 2**:

6. **Throttle exact:** semaphore de tamaño 3 con sleep 1s entre acquires, vs `governor` crate? Semaphore es trivial; `governor` agrega dep. Probablemente semaphore.
7. **Política de retry para `api_error`:** ¿en cada IDENTIFY ALL, o sólo después de N días? Probablemente cada IDENTIFY ALL — son retriables por definición.
8. **¿Re-intentar `low_confidence`/`no_match` en background?** Probablemente no — la decisión de re-intentar es del usuario (re-clickea IDENTIFY ALL).

A cerrar al implementar **Fase 3**:

9. **Cómo elegimos entre matches en el ambiguity picker.** UI propuesta: tabla con score, title, artist, year, duration. Click en una row → confirma + persiste.
10. **Auto-identify on import:** ¿durante el scan o post-scan en background? Probablemente post-scan (no bloquear el feedback inmediato del SCAN).
11. **¿Submit a AcoustID de tracks `no_match`?** Probablemente no por ahora (requiere account de MusicBrainz, scope expandido).

---

## 10. Adaptaciones a la base de código actual

Nada disruptivo. Todo se enchufa con los patrones existentes:

1. **Errores:** `AppResult<T>`. Agregar variantes en `errors.rs` (ver §4.6).
2. **State Tauri:** comandos reciben `State<'_, SqlitePool>` + `State<'_, reqwest::Client>` (ya registrados). No cambia nada.
3. **HTTP client:** ya está configurado con `User-Agent: BrutalistPlayer/0.1 (...)`. AcoustID acepta cualquier UA.
4. **Migraciones:** `sqlx migrate add identification` → editar el `.sql` con el ALTER del §3.1.
5. **Cargo.toml:** ninguna dep nueva. `serde_json` y `tokio::process` ya están.
6. **Stores:** crear `identificationStore` (chiquito — una Set + dos actions). Igual que como nació `lyricsStore`.
7. **Comandos register en `lib.rs`:** los tres del §6.1.

---

## 11. Próximos pasos

**Antes de implementar Fase 1:**

1. ✅ Closure de Fase 1 lyrics + docs polish (cerrado 2026-05-02).
2. ⏳ Verificar `fpcalc` corre en la mac del autor (`brew install chromaprint && fpcalc -version`).
3. ⏳ Registrar applicaition en AcoustID + obtener API key (test personal).

**Implementar Fase 1:**

4. Migración 3.1 (aditiva, 5 columnas + 2 índices).
5. `fpcalc::compute` + tests con un mp3 fixture.
6. `acoustid::lookup` + tests con response mock (httpmock o wiremock-rs).
7. `identify_track` cascade + tests del flujo completo (DB temp + reqwest mocked).
8. Comandos Tauri (3) + register.
9. Modal API key + `identificationStore`.
10. Columna ID en LibraryTable + indicador.
11. Context menu IDENTIFY en row.
12. Update `lyrics/lrclib.rs::try_lrclib` para priorizar MBID.
13. Validar end-to-end con 10-20 tracks reales: medir match rate, verificar que LRCLIB con MBID resuelve los casos que Fase 1 no cubría.

**Reevaluar antes de Fase 2:**

14. ¿Cuántos tracks quedan `identified` vs `low_confidence` vs `no_match`?
15. ¿Cuántas letras nuevas se desbloquearon por MBID match?
16. ¿Hay cuellos de botella obvios (fpcalc lento, AcoustID con quota)?

---

*Doc vivo. Actualizar conforme se cierren decisiones abiertas durante implementación.*
