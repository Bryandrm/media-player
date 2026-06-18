# Brutalist Player

> Reproductor de música local desktop con visualizador estilo MilkDrop (Butterchurn), downloader integrado vía yt-dlp, identificación canónica vía AcoustID, y karaoke con forced alignment vía WhisperX. Proyecto personal + portfolio piece.

## Stack

- **Shell:** Tauri 2 (Rust backend + WebView)
- **Frontend:** React 19 + TypeScript + Vite 7 + Tailwind v4 + Zustand 5
- **Backend:** Rust async, SQLite vía `sqlx` 0.8 (runtime-tokio), `lofty` 0.22 para tags + cover art + USLT, `reqwest` (rustls-tls) para HTTP
- **Audio:** dos singletons `<audio>` (canales A/B fuera del JSX) → channelGains → preMasterGain (vis tap) → masterGain (volume) → playPauseGain (fades) → destination. Butterchurn tapea preMasterGain.
- **Visualizer:** Butterchurn 2.6 + butterchurn-presets 2.4 (~100 presets base, auto-cycle 5–10s, persistent mount)
- **Lyrics:** cascade Embedded (USLT) → LRCLIB → NetEase (synced, free, sin key), parser LRC + A2 (per-word timestamps), panel sincronizado con rAF, drift correction (`speedRatio` + offset + ALIGN mode)
- **Identification:** `fpcalc` (Chromaprint) + AcoustID API → MBID de MusicBrainz; pisa metadata sucia con canónica
- **Karaoke:** WhisperX en align-only mode via wrapper Python para forced alignment per-palabra
- **Externos:** `yt-dlp`, `ffmpeg`, `fpcalc`, `whisperx` como deps del sistema (no bundled, opt-in según feature)

## Prerequisitos

**Required (player core):**

| Herramienta | Versión | Notas |
|---|---|---|
| Node | 20+ | via nvm/fnm recomendado |
| pnpm | 10+ | `corepack enable pnpm` (viene con Node) o `npm i -g pnpm` |
| Rust | stable | `rustup-init -y --default-toolchain stable` |

**Optional (cada uno desbloquea su feature):**

| Herramienta | Para qué | Setup |
|---|---|---|
| yt-dlp | Downloads de URLs | `brew install yt-dlp` |
| ffmpeg | Re-encoding usado por yt-dlp | `brew install ffmpeg` |
| fpcalc (Chromaprint) | Identification AcoustID | `brew install chromaprint` + [registrar app en AcoustID](https://acoustid.org/new-application) |
| WhisperX (~2GB) | Forced alignment de letras (karaoke) | `brew install pipx python@3.11`, `pipx ensurepath`, restart shell, `pipx install --python python3.11 whisperx` |

La app detecta cada dep al boot y desactiva la feature correspondiente si falta. **Sin ninguna de las opcionales, el player core (reproducción + library + visualizer + lyrics text-only) funciona idéntico.**

## Desarrollo

```bash
pnpm install
pnpm tauri dev
```

> **pnpm 10+ pide aprobar build scripts.** En el primer `pnpm install`, pnpm
> deja en _ignored builds_ a `esbuild` y `core-js`. `esbuild` necesita su
> postinstall para bajar el binario nativo, así que hay que aprobarlo o
> `pnpm tauri dev` falla en el pre-check de deps. El repo ya incluye un
> `pnpm-workspace.yaml` con `allowBuilds` resuelto (`esbuild: true`,
> `core-js: false`); si lo borrás, corré `pnpm approve-builds` y aprobá `esbuild`.

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
│   ├── components/    ui/ library/ (+ playlists) player/ visualizer/ lyrics/ eq/ downloads/
│   ├── hooks/         useAudioPlayer, useLyricsSync, useSyncedLyrics,
│   │                  usePlaybackPersist, useMediaSession, …
│   ├── stores/        playerStore (+ eqGains/eqEnabled), libraryStore, uiStore,
│   │                  lyricsStore, downloadStore, identificationStore, playlistStore
│   ├── lib/           format, search, lrcParser (puros)
│   └── styles/        tokens.css (design tokens brutalist)
├── src-tauri/     # Backend Rust
│   ├── src/
│   │   ├── audio/         lofty: extract_metadata + extract_cover_art
│   │   │   └── cleanup.rs heurísticas para metadata yt-dlp (+ tests)
│   │   ├── commands/      thin wrappers: library, downloader, lyrics, system,
│   │   │                  identification, karaoke, playlists
│   │   ├── db/            sqlx queries: tracks, lyrics, settings, playlists
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
- [docs/DECISIONS.md](docs/DECISIONS.md) — ADRs (decisiones técnicas con razón) — 34 ADRs al 2026-06-18
- [docs/LYRICS.md](docs/LYRICS.md) — plan por fases del sub-sistema de letras
- [docs/IDENTIFICATION.md](docs/IDENTIFICATION.md) — sub-sistema de identificación (AcoustID + Chromaprint)
- [docs/KARAOKE.md](docs/KARAOKE.md) — sub-sistema de karaoke (forced alignment + futuras Fases B-E)
- [CLAUDE.md](CLAUDE.md) — convenciones + gotchas (22 gotchas pagados, el archivo más útil para entender footguns)

## Estado actual

**Fase 0 — Setup** ✓ · **Fase 1 — MVP funcional** ✓ (cerrada 2026-05-02 al 100%) · **AcoustID Fase 1+2** ✓ · **Lyrics 2.a** ✓ · **Karaoke Fase A** ✓ (revertido a fake, ver abajo) · **Lyrics 2.c.1 — manual edit** ✓ · **EQ 10 bandas** ✓ · **Playlists** ✓ · **Descarga de listas + dedup + cookies** ✓ · **Gapless switch** ✓ · **Lyrics 2.c.3 — NetEase** ✓ · **Descargas: historial persistente + cancelar** ✓ · **Drag & drop import** ✓ · **Export M3U** ✓ (al 2026-06-18)

Funcionando hoy:
- **Player**: play/pause con fade gradual, seek, volume (GainNode), mute, prev/next, shuffle con historial (cap 64), crossfade configurable (off/3/6/12s) entre tracks.
- **Library**: scan recursivo de directorio (lofty) + **drag & drop** de archivos/carpetas a la ventana (import nativo de Tauri, sin SCAN), tabla con search por tokens (AND), cover art embebido + fallback a sibling `cover.jpg`. Cleanup heurístico de metadata yt-dlp + comando "CLEAN METADATA" para backfill. Columnas L (lyrics) e ID (identification) con indicadores per row.
- **Downloader**: paste URL → yt-dlp con progreso en tiempo real + fase CONVERTING, idempotente (`--no-overwrites`). Toggle **FULL PLAYLIST**: baja la lista completa y la guarda como playlist (además de "all tracks"); default OFF = un solo video aunque la URL traiga `list=`. **Historial persistente** (tabla `downloads`) con fecha, descargas de lista expandibles, y **botón CANCEL** (mata yt-dlp conservando los parciales). Reconcile de descargas huérfanas + limpieza de temporales al boot. Ver [ADR-031](docs/DECISIONS.md#adr-031--history-de-descargas-persistente--reconcile-de-huérfanas), [ADR-032](docs/DECISIONS.md#adr-032--cancelar-descarga-conservando-parciales).
- **Visualizer**: Butterchurn side-by-side con la library, split arrastrable, auto-cycle de presets random cada 5–10s, fullscreen vía `F`. Persistent mount — sin freeze al cambiar de tab.
- **Lyrics**: cascade Embedded (USLT) → LRCLIB → **NetEase** (synced, free, sin key). Panel sincronizado (rAF) con karaoke fill per-palabra (gradient HARD entre accent y fg). Click-to-seek, offset/speed/RESET, ALIGN mode (set offset clickeando línea), AUTO-ALIGN (forced alignment via WhisperX), botón REFETCH en not_found. Indicador `[L]/·/♪/—` en cada row de la library, auto-fetch on track change.
- **Identification AcoustID**: fpcalc fingerprint → MBID de MusicBrainz → pisa metadata sucia. Single-track + bulk IDENTIFY ALL con throttle 2.85 rps cancelable. Indicador ID per row (`[ID]`/`?`/`—`/`!`/`⌛`).
- **Karaoke Fase A** (infraestructura): forced alignment via WhisperX en align-only mode + parser A2 + botón AUTO-ALIGN. **Actualmente revertido a fake karaoke** (interpolación uniforme dentro de línea) porque WhisperX hereda los mismatches del LRC. Volverá cuando mejore el LRC base — 2.c.3 (NetEase) ✓ sumó cobertura synced; falta 2.c.4 (auto-fallback por confidence + auto-detect de mismatch). Ver [docs/KARAOKE.md §13](docs/KARAOKE.md#13-lecciones-aprendidas-fase-a).
- **Lyrics manual edit (2.c.1)**: botón EDIT en LyricsView → modal con textareas synced + plain. Guarda vía `lyrics_save_manual_edit`, sobreescribe `original_synced_lyrics` (preserva la edición a través de RE-ALIGNs) y resetea offset/speedRatio. Escalera de emergencia para usuario técnico, no flujo seamless aún.
- **Equalizer 10 bandas**: `BiquadFilterNode` chain ISO estándar (lowshelf + 8 peaking + highshelf), ±12dB, tab EQ con sliders verticales, BYPASS preserva preset, double-click resetea banda. Insertado entre `preMasterGain` y `masterGain` → el visualizer tapea pre-EQ (independiente). Ver [ADR-023](docs/DECISIONS.md#adr-023).
- **Playlists**: CRUD + add/remove tracks + sidebar UI + rename inline (doble-click) + reorder por drag & drop + **export a M3U** (botón M3U en hover → save dialog → extended M3U con rutas absolutas). `getQueue()` lee de la playlist seleccionada → NEXT/PREV/shuffle navegan dentro de ella. La vista de playlist se mantiene en sync con la library (identify/clean/scan/letras refrescan ambas). Smart playlists quedan para polish.
- **Toggle visualizer ↔ lyrics** dentro del split, persistido.
- **Persistencia**: último track + posición entre sesiones (sin auto-play). Volume/mute/shuffle/crossfade/preset/split/autoCycle/paneMode via Zustand `persist`.
- **Media keys**: F7/F8/F9 + AirPods + lock screen + Now Playing widget (MediaSession API). Probado en macOS, pendiente Windows.
- **Keyboard shortcuts**: Space, ←/→, ↑/↓, M, N, P, S, V, F.

**Próximo (orden acordado 2026-06-18)**: (1) quick wins restantes — **smart playlists** (drag & drop ✓ + history persistente ✓ + export M3U ✓ hechos); (2) calidad/plataforma — testing Windows/Linux (MPRIS), validar `pnpm tauri build`, tests + CI; (3) features grandes al final — Lyrics 2.c.4 (auto-fallback por confidence + auto-detect de mismatch) → karaoke real, Karaoke Fase B-E, Identification Fase 3.

Ver [PLAN §6](docs/PLAN-reproductor-brutalist.md#6-roadmap-por-fases) para el plan completo.

---

## Disclaimer legal

Este proyecto es de **uso estrictamente personal** y existe como portfolio piece. **No se distribuye como producto.**

- Se integra con `yt-dlp` para descargar audio desde URLs públicas. El uso de yt-dlp para descargar material con copyright puede violar los términos de servicio de las plataformas correspondientes y/o leyes locales.
- **No se bundle-a `yt-dlp` ni `ffmpeg`** — el usuario los instala por separado bajo su propia responsabilidad.
- El autor no fomenta ni asume responsabilidad por usos que violen derechos de terceros.
- No usar este software para piratería ni redistribución no autorizada.
