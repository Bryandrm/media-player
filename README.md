# Brutalist Player

> Reproductor de música local desktop con visualizador estilo MilkDrop (Butterchurn) y downloader integrado vía yt-dlp. Proyecto personal + portfolio piece.

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView)
- **Frontend:** React 19 + TypeScript + Vite 7
- **Backend:** Rust (async, SQLite vía `sqlx` — propuesto, ver [ADR-001](docs/DECISIONS.md#adr-001))
- **Audio:** Web Audio API + Butterchurn (WebGL)
- **Externos:** `yt-dlp`, `ffmpeg`, `lofty-rs`, LRCLIB

## Prerequisitos

| Herramienta | Versión | Notas |
|---|---|---|
| Node | 20+ | via nvm/fnm recomendado |
| pnpm | 10+ | `npm i -g pnpm` |
| Rust | stable | `rustup-init -y --default-toolchain stable` |
| yt-dlp | cualquiera | sólo para funcionalidad de descarga (Fase 1+) |
| ffmpeg | cualquiera | sólo para funcionalidad de descarga (Fase 1+) |

## Desarrollo

```bash
pnpm install
pnpm tauri dev
```

La primera corrida compila ~300 crates de Tauri y tarda 5–10 minutos. Las siguientes son incrementales (segundos).

## Estructura

```
.
├── src/           # Frontend React + TS
├── src-tauri/     # Backend Rust
├── docs/          # Planning, architecture, decisions
├── CLAUDE.md      # Contexto operativo para Claude Code
└── README.md      # este archivo
```

Documentos fuente de verdad:
- [docs/PLAN-reproductor-brutalist.md](docs/PLAN-reproductor-brutalist.md) — visión, scope, roadmap
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — arquitectura técnica, contratos Tauri
- [docs/DECISIONS.md](docs/DECISIONS.md) — ADRs (decisiones técnicas con razón)

## Estado actual

**Fase 0 — Setup** (en progreso)

- [x] Scaffold Tauri 2 + React + TS + Vite
- [x] Estructura de docs (PLAN, ARCHITECTURE, DECISIONS, CLAUDE)
- [ ] Smoke test del pipeline de audio (`convertFileSrc` + Web Audio)
- [ ] Tailwind v4 + design tokens brutalist
- [ ] SQLite + primera migración
- [ ] Estructura de módulos Rust (`db`, `audio`, `downloader`, `metadata`)

Ver [PLAN §6 — Roadmap por fases](docs/PLAN-reproductor-brutalist.md#6-roadmap-por-fases) para el plan completo.

---

## Disclaimer legal

Este proyecto es de **uso estrictamente personal** y existe como portfolio piece. **No se distribuye como producto.**

- Se integra con `yt-dlp` para descargar audio desde URLs públicas. El uso de yt-dlp para descargar material con copyright puede violar los términos de servicio de las plataformas correspondientes y/o leyes locales.
- **No se bundle-a `yt-dlp` ni `ffmpeg`** — el usuario los instala por separado bajo su propia responsabilidad.
- El autor no fomenta ni asume responsabilidad por usos que violen derechos de terceros.
- No usar este software para piratería ni redistribución no autorizada.
