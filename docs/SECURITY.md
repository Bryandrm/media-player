# Security — Brutalist Music Player

> Auditoría de superficie de ataque y plan de hardening.
> Última revisión: 2026-06-19.

---

## Estado actual: BAJO RIESGO

La app es desktop local (no servidor, no multi-usuario). La mayoría de
vectores web clásicos (CSRF, session hijacking, privilege escalation) no
aplican. Los riesgos reales son: ejecución de subprocesos, inyección SQL
en queries dinámicos, y manejo de archivos basado en input del usuario.

---

## 1. Superficie auditada

### 1.1 Subprocesos (yt-dlp, fpcalc, Python scripts)

**Estado: SEGURO**

| Binario | Archivo | Cómo se invoca | Riesgo |
|---------|---------|----------------|--------|
| yt-dlp | `downloader/mod.rs` | `.arg(url)` sin interpolación | Ninguno |
| fpcalc | `identification/fpcalc.rs` | `.arg(path)` con path del filesystem | Ninguno |
| Python (whisperx) | `karaoke/whisperx.rs` | Args separados, paths absolutos | Ninguno |

Todos los subprocesos usan `tokio::process::Command` con argumentos
separados (no shell string). No hay inyección de comandos posible.

### 1.2 SQL Injection

**Estado: SEGURO**

- **Queries estáticas** (`db/tracks.rs`, `db/lyrics.rs`, etc.): 100% uso
  de `.bind()` / `sqlx::query!`. Cero interpolación de strings.
- **Query builder dinámico** (`db/smart.rs`): whitelist de columnas por
  `match` contra literales + todos los valores por `push_bind()`. Campo
  inválido → `WHERE 1=0`. JSON inválido en value → 0 elementos → `WHERE 1=0`.
  Imposible inyectar SQL.

### 1.3 Tauri IPC (comandos expuestos)

**Estado: SEGURO**

~25 comandos expuestos vía `tauri::generate_handler![]`. Cada uno valida
sus inputs. No hay combinaciones peligrosas (no hay "leer archivo
arbitrario" + "enviar por red"). Capabilities en `default.json`:
`core:default`, `opener:default`, `dialog:default` — superficie mínima.

### 1.4 Requests de red

**Estado: SEGURO**

| API | URL | Protocolo |
|-----|-----|-----------|
| AcoustID | `api.acoustid.org/v2/lookup` | HTTPS ✅ |
| LRCLIB | `lrclib.net/api/get` | HTTPS ✅ |
| NetEase | `music.163.com/api/search/get/` | HTTPS ✅ |
| MusicBrainz | `musicbrainz.org/ws/2/recording` | HTTPS ✅ |
| Cover Art Archive | `coverartarchive.org/release-group` | HTTPS ✅ |

- Todos HTTPS. Sin keys hardcodeadas.
- AcoustID API key: provista por el usuario, almacenada en SQLite local,
  transmitida en query params sobre HTTPS (patrón legítimo de la API).
- `reqwest` con `rustls-tls` (sin OpenSSL).

### 1.5 XSS / HTML Injection

**Estado: SEGURO**

- React escapa texto por default. No hay `dangerouslySetInnerHTML` en
  ningún componente.
- Lyrics, títulos, artistas se renderizan como texto plano.
- Metadata de yt-dlp (potencialmente maliciosa) se muestra como texto,
  nunca como HTML.

### 1.6 Operaciones de archivos

**Estado: MAYORMENTE SEGURO** (ver items pendientes)

- **Library scan**: usuario provee directorio, validado con `is_dir()`.
- **Downloads**: paths extraídos del stdout de yt-dlp, no del usuario.
- **Cover art cache**: filenames construidos como `<id>.<ext>` (id es
  entero, ext validada). Sin path traversal.
- **Import drag & drop**: paths del evento nativo de Tauri, no del HTML5.

### 1.7 Secrets / Credenciales

**Estado: SEGURO**

- Cero keys hardcodeadas en el source.
- AcoustID key: user-provided, SQLite local.
- Cookies file: el usuario selecciona el archivo, se pasa a yt-dlp sin
  inspeccionar el contenido (yt-dlp lo valida).

### 1.8 Memory Safety

**Estado: SEGURO**

- Cero bloques `unsafe` en todo el codebase Rust.
- Sin manejo manual de memoria.
- JSON parsing vía serde (type-safe).

---

## 2. Items pendientes de hardening

### 2.1 Validación de URL en backend (Prioridad: Media)

**Archivo:** `src-tauri/src/commands/downloader.rs`

El URL del downloader se valida en el frontend (`type="url"` en el input)
pero no en el backend. Un IPC call directo podría pasar URLs con schemes
no-HTTP (file://, javascript://, etc.) a yt-dlp.

**Fix propuesto:**
```rust
use url::Url;
let parsed = Url::parse(&url).map_err(|_| AppError::Other("invalid URL".into()))?;
if !["http", "https"].contains(&parsed.scheme()) {
    return Err(AppError::Other("only http/https URLs allowed".into()));
}
```

### 2.2 Validación de path en M3U export (Prioridad: Media)

**Archivo:** `src-tauri/src/commands/playlists.rs:139`

`dest_path` del export M3U viene del save dialog (UI nativa) pero no se
valida en backend. Si se invoca vía IPC directo, podría escribir en
ubicaciones arbitrarias del filesystem.

**Fix propuesto:**
```rust
let dest = Path::new(&dest_path);
if dest.extension().and_then(|e| e.to_str()) != Some("m3u") {
    return Err(AppError::Other("export must be .m3u file".into()));
}
```

### 2.3 Cookie file validation (Prioridad: Baja)

**Archivo:** `src-tauri/src/downloader/mod.rs`

`cookies_file` no se valida como archivo existente antes de pasarlo a
yt-dlp. Error poco claro si el path es inválido.

**Fix propuesto:** verificar `Path::new(&cookies_file).is_file()` y dar
error descriptivo.

### 2.4 API key storage encryption (Prioridad: Baja)

La AcoustID API key se almacena en texto plano en SQLite. Para una app
local personal esto es aceptable, pero si se distribuyera:

**Opciones:**
- Tauri plugin `tauri-plugin-stronghold` (encrypted vault).
- OS keychain: macOS Keychain / Windows Credential Manager / Linux
  Secret Service vía `keyring` crate.
- Aceptar texto plano (es una API key gratuita, no un password).

### 2.5 Rate limiting en requests (Prioridad: Baja)

MusicBrainz requiere max 1 req/seg (ya implementado en el backfill loop
con `tokio::time::sleep`). Pero no hay rate limiting global — un usuario
podría triggerear múltiples identify/fetch en paralelo.

**Fix propuesto:** semáforo global por API (ej: `tokio::sync::Semaphore`
con 1 permit para MusicBrainz).

### 2.6 Subprocess path validation (Prioridad: Baja)

`resolve_binary` busca binarios en paths hardcodeados como fallback. Si
un atacante colocara un binario malicioso en `~/.local/bin/yt-dlp`, se
ejecutaría. Esto es el mismo riesgo que cualquier app que use PATH.

**Mitigación posible:** verificar firma digital del binario (overkill
para app personal). Con Pixi (ADR-037), la resolución de binarios pasa
a ser dentro del environment controlado → riesgo eliminado.

### 2.7 Pixi environment integrity (Prioridad: Media — futuro)

Cuando se implemente ADR-037 (Pixi), verificar:
- Que `pixi install` use lockfile (reproducible, sin supply chain drift).
- Que los PyPI packages se instalen con hashes verificados.
- Que el binario de pixi bundleado tenga checksum verificable.

### 2.8 Content Security Policy del WebView (Prioridad: Media)

No se encontró CSP configurado en `tauri.conf.json`. La app solo carga
contenido local (no URLs externas en el webview), pero un CSP explícito
es defense-in-depth.

**Fix propuesto:** en `tauri.conf.json`:
```json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: https://coverartarchive.org"
    }
  }
}
```

---

## 3. Riesgos aceptados (no requieren fix)

| Riesgo | Razón de aceptación |
|--------|---------------------|
| yt-dlp ejecuta código de YouTube (JS challenge) | Inherente al downloader; mitigado por sandbox de Node |
| SQLite sin encryption at rest | App personal, DB local, no contiene PII sensible |
| Metadata de yt-dlp podría ser maliciosa | Se renderiza como texto, no como HTML; React escapa |
| Python scripts ejecutan código ML | Scripts shipped con la app, no user-provided |
| Cover art descargado de internet | Se almacena como imagen estática, no se ejecuta |

---

## 4. Checklist para PR de seguridad

Antes de marcar como cerrado, implementar al menos los items de prioridad
Media:

- [ ] 2.1 — URL validation en backend del downloader
- [ ] 2.2 — Path validation en M3U export
- [ ] 2.5 — Rate limiting global por API (semáforo)
- [ ] 2.8 — CSP en tauri.conf.json

Items de prioridad Baja son nice-to-have para cuando se distribuya:

- [ ] 2.3 — Cookie file validation
- [ ] 2.4 — API key encrypted storage
- [ ] 2.6 — Subprocess path validation (se resuelve con Pixi)
- [ ] 2.7 — Pixi environment integrity (cuando se implemente ADR-037)
