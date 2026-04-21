# CLAUDE.md

> Contexto operativo para Claude Code trabajando en este repo.
> Mantener corto. Las decisiones y los detalles técnicos viven en [docs/](./docs/).

---

## Qué es este proyecto

Reproductor de música local desktop con visualizador estilo MilkDrop (Butterchurn) y downloader integrado vía yt-dlp. Proyecto **personal + portfolio piece**, no producto comercial. Construido en Tauri 2 + Rust + React.

Documentos fuente de verdad:
- [docs/PLAN-reproductor-brutalist.md](./docs/PLAN-reproductor-brutalist.md) — visión, scope, roadmap.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — arquitectura técnica, contratos Tauri, pipeline de audio.
- [docs/DECISIONS.md](./docs/DECISIONS.md) — ADRs. Leer antes de proponer cambios técnicos importantes.

---

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView).
- **Frontend:** React 18 + TypeScript + Vite + Tailwind v4.
- **Estado React:** Zustand.
- **Backend:** Rust. SQLite vía `sqlx` (propuesto, ver ADR-001).
- **Audio:** HTML5 `<audio>` + Web Audio API (`MediaElementAudioSourceNode` → `AnalyserNode` → Butterchurn).
- **Externos:** `yt-dlp` y `ffmpeg` como child processes. `lofty-rs` para tags. `LRCLIB` API para letras.

---

## Principios que guían las decisiones

1. **Brutalist de verdad, no template.** Sin border-radius, sin gradients, sin shadows blur, sin iconos decorativos. Tipografía + bordes + contraste duro. Si propones una UI "más suave", estás contradiciendo la identidad del proyecto — preguntá primero.
2. **El visualizador es el protagonista.** La UI se aparta cuando suena música.
3. **Scope conservador.** Lo que no esté en [PLAN §1.3](./docs/PLAN-reproductor-brutalist.md) está fuera, incluso si parece "una mejora pequeña". Preguntar antes de añadir.
4. **El autor está aprendiendo Rust.** Preferir patrones simples (funciones libres, queries explícitas) sobre abstracciones prematuras (traits complejos, macros custom). Cuando expliques código Rust, tratá al lector como alguien que sabe programar pero no conoce idioms específicos.
5. **Separación Rust/React dura:** audio + WebGL en React; filesystem + procesos + red en Rust. Nunca al revés.

---

## Estructura del repo (objetivo, no estado actual)

Ver [PLAN §8](./docs/PLAN-reproductor-brutalist.md#8-estructura-inicial-del-repo-propuesta) para el layout completo.

```
.
├── src/                  # Frontend React
├── src-tauri/            # Backend Rust
├── docs/                 # PLAN, ARCHITECTURE, DECISIONS
├── CLAUDE.md             # este archivo
└── README.md             # pendiente — setup + disclaimer legal
```

Estado actual del repo: **sólo documentación**. La Fase 0 (setup de Tauri) aún no ha empezado.

---

## Convenciones

### Rust
- `snake_case` comandos Tauri.
- Errores: enum `AppError` con `thiserror`, serializable.
- `commands/*` son thin wrappers — lógica en módulos de dominio (`db/`, `audio/`, `downloader/`, `lyrics/`).
- Tipos compartidos con frontend en `contracts.rs`.

### TypeScript / React
- `camelCase` para variables y funciones, `PascalCase` para componentes y tipos.
- Stores Zustand por dominio (`playerStore`, `libraryStore`, `downloadStore`, `uiStore`).
- Un solo `AudioContext` singleton al root.
- Eventos de Tauri: wrapper `useTauriEvent(name, handler)`, nunca `listen()` en componentes de hoja.

### Estilo visual
- Tokens en `src/styles/tokens.css`. No inventar colores nuevos — usar variables existentes.
- Border-radius: `0` siempre. Si ves `rounded-*` en código, es bug.
- Transiciones: `50-80ms` máximo o ninguna.
- Sombras: sólo hard (`4px 4px 0 var(--border)`), nunca blur.

---

## Comandos (rellenar cuando Fase 0 arranque)

```bash
# dev
# TODO: pnpm tauri dev  (o npm/yarn según se decida)

# build
# TODO: pnpm tauri build

# tests Rust
# TODO: cargo test --manifest-path src-tauri/Cargo.toml

# lint frontend
# TODO: pnpm lint
```

---

## Cosas que **no** hacer

- No añadir features fuera del scope del PLAN sin preguntar.
- No introducir librerías pesadas cuando hay una solución nativa (evitar MUI, Chakra, Bootstrap — contradicen brutalist).
- No abstraer prematuramente: preferir tres lugares con código repetido a un helper genérico que nadie entiende.
- No mockear SQLite en tests — usar una DB temporal real (`tempfile` + migrate).
- No commitear con `yt-dlp` bundled (decisión ADR-002 pendiente; por default: detectar, no bundlear).
- No publicar binarios públicamente — el proyecto es personal/portfolio, no producto.

---

## Disclaimer legal (recordatorio)

El uso de yt-dlp puede violar ToS de servicios como YouTube. Este proyecto es de uso personal. No distribuir binarios al público. Incluir disclaimer en el README cuando se escriba.
