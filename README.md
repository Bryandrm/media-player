# Brutalist Player

> Reproductor de música local desktop con visualizador estilo MilkDrop (Butterchurn) y downloader integrado vía yt-dlp. Proyecto personal + portfolio piece.

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView)
- **Frontend:** React 19 + TypeScript + Vite 7 + Tailwind v4 + Zustand 5
- **Backend:** Rust async, SQLite vía `sqlx` 0.8 (runtime-tokio), `lofty` 0.22 para tags + cover art + USLT, `reqwest` (rustls-tls) para HTTP
- **Audio:** dos singletons `<audio>` (canales A/B fuera del JSX) → channelGains → preMasterGain (vis tap) → masterGain (volume) → playPauseGain (fades) → destination. Butterchurn tapea preMasterGain.
- **Visualizer:** Butterchurn 2.6 + butterchurn-presets 2.4 (~100 presets base, auto-cycle 5–10s, persistent mount)
- **Lyrics:** LRCLIB API + USLT embebido en tags ID3, parser LRC en TS, panel sincronizado con rAF
- **Externos:** `yt-dlp` y `ffmpeg` como child processes (deps del sistema, no bundled)

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
pnpm exec tsc --noEmit                     # typecheck frontend
pnpm build                                 # vite build a dist/
cd src-tauri && cargo check                # backend rápido sin runtime Tauri
cd src-tauri && cargo test --lib           # tests Rust (audio::cleanup, etc)
```

> **Nota:** cambios en código Rust requieren matar y volver a levantar `pnpm tauri dev`. Vite hace HMR del frontend; el binario Rust es un proceso aparte que sigue el código compilado al startup.

## Estructura

```
.
├── src/           # Frontend React + TS
│   ├── audio/         singletons audio A/B + AudioContext + 4 GainNodes
│   ├── components/    ui/ library/ player/ visualizer/ lyrics/ downloads/
│   ├── hooks/         useAudioPlayer, useLyricsSync, useSyncedLyrics,
│   │                  usePlaybackPersist, useMediaSession, …
│   ├── stores/        playerStore, libraryStore, uiStore, lyricsStore, downloadStore
│   ├── lib/           format, search, lrcParser (puros)
│   └── styles/        tokens.css (design tokens brutalist)
├── src-tauri/     # Backend Rust
│   ├── src/
│   │   ├── audio/         lofty: extract_metadata + extract_cover_art
│   │   │   └── cleanup.rs heurísticas para metadata yt-dlp (+ tests)
│   │   ├── commands/      thin wrappers: library, downloader, lyrics, system
│   │   ├── db/            sqlx queries: tracks, lyrics
│   │   ├── downloader/    yt-dlp child + stdout/stderr fan-in
│   │   ├── lyrics/        cascade: embedded.rs (USLT) + lrclib.rs (get + search)
│   │   ├── contracts.rs   tipos serializados a TS
│   │   └── errors.rs      AppError + AppResult
│   └── migrations/        sqlx migrate (forward-only)
├── docs/          # Planning, architecture, decisions, lyrics
├── CLAUDE.md      # Contexto operativo para Claude Code
└── README.md      # este archivo
```

Documentos fuente de verdad:
- [docs/PLAN-reproductor-brutalist.md](docs/PLAN-reproductor-brutalist.md) — visión, scope, roadmap
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — arquitectura técnica, contratos Tauri, pipeline de audio, lyrics
- [docs/DECISIONS.md](docs/DECISIONS.md) — ADRs (decisiones técnicas con razón)
- [docs/LYRICS.md](docs/LYRICS.md) — plan por fases del sub-sistema de letras
- [CLAUDE.md](CLAUDE.md) — convenciones + gotchas (el archivo más útil para entender footguns ya pagados)

## Estado actual

**Fase 0 — Setup** ✓ · **Fase 1 — MVP funcional** ✓ (cerrada 2026-05-02 al 100%)

Funcionando hoy:
- **Player**: play/pause con fade gradual, seek, volume (GainNode), mute, prev/next, shuffle con historial (cap 64), crossfade configurable (off/3/6/12s) entre tracks.
- **Library**: scan recursivo de directorio (lofty), tabla con search por tokens (AND), cover art embebido + fallback a sibling `cover.jpg`. Cleanup heurístico de metadata yt-dlp + comando "CLEAN METADATA" para backfill.
- **Downloader**: paste URL → yt-dlp con progreso en tiempo real + fase CONVERTING, idempotente (`--no-overwrites`).
- **Visualizer**: Butterchurn side-by-side con la library, split arrastrable, auto-cycle de presets random cada 5–10s, fullscreen vía `F`. Persistent mount — sin freeze al cambiar de tab.
- **Lyrics**: LRCLIB + USLT embebido. Panel sincronizado (rAF), click-to-seek, offset adjustable. Indicador `[L]/·/♪/—` en cada row de la library, auto-fetch on track change.
- **Toggle visualizer ↔ lyrics** dentro del split, persistido.
- **Persistencia**: último track + posición entre sesiones (sin auto-play). Volume/mute/shuffle/crossfade/preset/split/autoCycle/paneMode via Zustand `persist`.
- **Media keys**: F7/F8/F9 + AirPods + lock screen + Now Playing widget (MediaSession API). Probado en macOS, pendiente Windows.
- **Keyboard shortcuts**: Space, ←/→, ↑/↓, M, N, P, S, V, F.

**Próximo (Fase 3):** AcoustID + Chromaprint para identificación canónica del audio — elimina los problemas de metadata sucia + drift por versiones distintas que combatimos con heurísticas. Big project; ver [LYRICS.md Fase 3](docs/LYRICS.md).

Ver [PLAN §6](docs/PLAN-reproductor-brutalist.md#6-roadmap-por-fases) para el plan completo.

---

## Disclaimer legal

Este proyecto es de **uso estrictamente personal** y existe como portfolio piece. **No se distribuye como producto.**

- Se integra con `yt-dlp` para descargar audio desde URLs públicas. El uso de yt-dlp para descargar material con copyright puede violar los términos de servicio de las plataformas correspondientes y/o leyes locales.
- **No se bundle-a `yt-dlp` ni `ffmpeg`** — el usuario los instala por separado bajo su propia responsabilidad.
- El autor no fomenta ni asume responsabilidad por usos que violen derechos de terceros.
- No usar este software para piratería ni redistribución no autorizada.
