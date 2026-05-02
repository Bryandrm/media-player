# Brutalist Player

> Reproductor de música local desktop con visualizador estilo MilkDrop (Butterchurn) y downloader integrado vía yt-dlp. Proyecto personal + portfolio piece.

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView)
- **Frontend:** React 19 + TypeScript + Vite 7 + Tailwind v4 + Zustand 5
- **Backend:** Rust async, SQLite vía `sqlx` 0.8 (runtime-tokio), `lofty` 0.22 para tags + cover art
- **Audio:** singleton `<audio>` (fuera del JSX) → `MediaElementAudioSourceNode` → `GainNode` → destination. Butterchurn tapea el source.
- **Visualizer:** Butterchurn 2.6 + butterchurn-presets 2.4 (~100 presets base, auto-cycle 5–10s)
- **Externos:** `yt-dlp` y `ffmpeg` como child processes (deps del sistema, no bundled). LRCLIB para letras (pendiente).

## Prerequisitos

| Herramienta | Versión | Notas |
|---|---|---|
| Node | 20+ | via nvm/fnm recomendado |
| pnpm | 10+ | `npm i -g pnpm` |
| Rust | stable | `rustup-init -y --default-toolchain stable` |
| yt-dlp | cualquiera | sólo para descargas — `brew install yt-dlp` |
| ffmpeg | cualquiera | requerido por yt-dlp para extract-audio — `brew install ffmpeg` |

La app detecta yt-dlp + ffmpeg al boot y muestra un banner si faltan; el resto del player funciona igual.

## Desarrollo

```bash
pnpm install
pnpm tauri dev
```

La primera corrida compila ~300 crates de Tauri y tarda 5–10 minutos. Las siguientes son incrementales (segundos).

```bash
pnpm exec tsc --noEmit         # typecheck frontend
pnpm build                     # vite build a dist/
cd src-tauri && cargo check    # backend rápido sin runtime Tauri
```

## Estructura

```
.
├── src/           # Frontend React + TS
│   ├── audio/         singletons <audio> + AudioContext + GainNode
│   ├── components/    ui/ library/ player/ visualizer/ downloads/
│   ├── hooks/         useAudioPlayer, useKeyboardShortcuts, usePressFlash, …
│   ├── stores/        playerStore, libraryStore, uiStore, downloadStore
│   ├── lib/           format.ts, search.ts (puros)
│   └── styles/        tokens.css (design tokens brutalist)
├── src-tauri/     # Backend Rust
│   ├── src/
│   │   ├── audio/         lofty: extract_metadata + extract_cover_art
│   │   ├── commands/      thin wrappers — library, downloader, system
│   │   ├── db/            sqlx queries + migrate al boot
│   │   ├── downloader/    yt-dlp child + stdout/stderr fan-in
│   │   ├── lyrics/        (stub, pendiente — LRCLIB)
│   │   ├── contracts.rs   tipos serializados a TS
│   │   └── errors.rs      AppError + AppResult
│   └── migrations/        sqlx migrate (forward-only)
├── docs/          # Planning, architecture, decisions
├── CLAUDE.md      # Contexto operativo para Claude Code
└── README.md      # este archivo
```

Documentos fuente de verdad:
- [docs/PLAN-reproductor-brutalist.md](docs/PLAN-reproductor-brutalist.md) — visión, scope, roadmap
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — arquitectura técnica, contratos Tauri, pipeline de audio
- [docs/DECISIONS.md](docs/DECISIONS.md) — ADRs (decisiones técnicas con razón)
- [CLAUDE.md](CLAUDE.md) — convenciones + gotchas (el archivo más útil para entender footguns ya pagados)

## Estado actual

**Fase 0 — Setup** ✓
**Fase 1 — MVP funcional** ~90%

Funcionando hoy:
- Player: play/pause, seek, volumen (vía GainNode), mute, prev/next, shuffle con historial.
- Library: scan recursivo de directorio (lofty), tabla con search por tokens (AND), cover art embebido + fallback a sibling `cover.jpg`.
- Downloader: paste URL → yt-dlp con progreso en tiempo real + fase CONVERTING, idempotente (`--no-overwrites`).
- Visualizer Butterchurn side-by-side con la library, split arrastrable, auto-cycle de presets random cada 5–10s.
- Keyboard shortcuts: Space, ←/→, ↑/↓, M, N, P, S, V, F.
- Persistencia: volume, muted, shuffle, presetIndex, visualizerSplit, autoCycle (Zustand `persist`).

Pendientes Fase 1:
- Letras sincronizadas (LRCLIB) — el módulo `src-tauri/src/lyrics/` está stub.
- Crossfade entre tracks.
- Persistencia del último track / posición.

Ver [PLAN §6 — Roadmap por fases](docs/PLAN-reproductor-brutalist.md#6-roadmap-por-fases) para el plan completo.

---

## Disclaimer legal

Este proyecto es de **uso estrictamente personal** y existe como portfolio piece. **No se distribuye como producto.**

- Se integra con `yt-dlp` para descargar audio desde URLs públicas. El uso de yt-dlp para descargar material con copyright puede violar los términos de servicio de las plataformas correspondientes y/o leyes locales.
- **No se bundle-a `yt-dlp` ni `ffmpeg`** — el usuario los instala por separado bajo su propia responsabilidad.
- El autor no fomenta ni asume responsabilidad por usos que violen derechos de terceros.
- No usar este software para piratería ni redistribución no autorizada.
