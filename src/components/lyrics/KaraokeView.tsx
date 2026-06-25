import { useEffect, useMemo, useRef } from "react";
import { useUiStore } from "../../stores/uiStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { usePlayerStore } from "../../stores/playerStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useSyncedLyrics } from "../../hooks/useSyncedLyrics";
import { parseLrc, type LrcLine } from "../../lib/lrcParser";
import { getAudioElement } from "../../audio/element";
import { formatTime } from "../../lib/format";
import { CoverArt } from "../player/CoverArt";
import { Button } from "../ui/Button";

// Ref estable de "sin líneas" — al pasarla cuando el overlay está cerrado,
// useSyncedLyrics corta temprano (no agrega listeners ni corre su rAF).
const NO_LINES: LrcLine[] = [];

// Ventana (ms) en la que aparece la barra de countdown antes de la próxima
// línea. Sólo se muestra en gaps reales (instrumentales): requiere que la
// línea activa tenga un fin explícito (A2 / aligned) y que ya lo hayamos
// pasado — así no titila entre cada par de líneas cantadas seguidas.
const COUNTDOWN_WINDOW_MS = 4000;

// Tokeniza una línea conservando los espacios como tokens propios (para que el
// browser pueda envolver entre palabras). Igual criterio que LyricsView —
// repetido a propósito (CLAUDE.md: tres lugares con código repetido > helper
// genérico prematuro).
function splitTokens(text: string): string[] {
  return text.split(/(\s+)/).filter((s) => s.length > 0);
}

/** Karaoke mode — Fase B. Overlay fullscreen "para fiesta": letras gigantes
 *  centradas con sweep per-word (reusa `useSyncedLyrics`), línea pasada arriba
 *  + próxima abajo, countdown en gaps instrumentales y progress bar abajo.
 *  Trigger: botón KARAOKE en LyricsView o tecla `K`. Salida: Escape / EXIT. */
export function KaraokeView() {
  const open = useUiStore((s) => s.karaokeOpen);
  const setKaraokeOpen = useUiStore((s) => s.setKaraokeOpen);
  const lyrics = useLyricsStore((s) => s.current);
  const trackId = usePlayerStore((s) => s.currentTrackId);
  const tracks = useLibraryStore((s) => s.tracks);

  const track = useMemo(
    () => (trackId === null ? null : tracks.find((t) => t.id === trackId) ?? null),
    [trackId, tracks],
  );

  // Mismo parse + offsets que LyricsView.
  const parsed = useMemo(
    () => (lyrics?.syncedLyrics ? parseLrc(lyrics.syncedLyrics) : null),
    [lyrics?.syncedLyrics],
  );
  const lines = parsed?.lines ?? [];
  const hasSynced = lines.length > 0;
  const userOffset = lyrics?.offsetMs ?? 0;
  const speedRatio = lyrics?.speedRatio ?? 1.0;
  const lrcOffset = parsed?.metadata.offsetMs ?? 0;

  // El hook escribe `--word-progress` por palabra en la línea activa cada frame
  // (vía activeLineRef). Cuando el overlay está cerrado pasamos NO_LINES → el
  // hook no hace nada.
  const activeLineRef = useRef<HTMLDivElement>(null);
  const activeIndex = useSyncedLyrics(
    open ? lines : NO_LINES,
    lrcOffset,
    userOffset,
    speedRatio,
    activeLineRef,
  );

  // Refs para actualizar countdown + progress por frame sin re-render de React.
  const countdownWrapRef = useRef<HTMLDivElement>(null);
  const countdownBarRef = useRef<HTMLDivElement>(null);
  const countdownLabelRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const timeLabelRef = useRef<HTMLDivElement>(null);

  // Escape cierra (K lo togglea desde los shortcuts globales).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setKaraokeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setKaraokeOpen]);

  // rAF: progress bar (abajo) + countdown (gaps). Lee audio.currentTime directo
  // → más fluido que el timeupdate (~250ms) del store. Se re-crea cuando cambia
  // la línea activa (para recomputar el gap a la próxima).
  useEffect(() => {
    if (!open) return;
    const audio = getAudioElement();
    const toEff = (raw: number) => (raw + lrcOffset) * speedRatio + userOffset;
    const effOf = (l: LrcLine) =>
      toEff(l.wordTimestampsMs?.[0] ?? l.timestampMs);

    const active = activeIndex >= 0 ? lines[activeIndex] : null;
    const next = lines[activeIndex + 1] ?? null;
    const activeEnd =
      active?.lastWordEndMs != null ? toEff(active.lastWordEndMs) : null;
    const nextStart = next ? effOf(next) : null;

    let raf = 0;
    const tick = () => {
      const now = audio.currentTime * 1000;
      const dur =
        (Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : track?.durationMs) || 1;

      if (progressBarRef.current) {
        progressBarRef.current.style.width = `${Math.min(100, (now / dur) * 100)}%`;
      }
      if (timeLabelRef.current) {
        timeLabelRef.current.textContent = `${formatTime(now / 1000)} / ${formatTime(dur / 1000)}`;
      }

      // Countdown: sólo en un gap real (fin de línea explícito ya pasado) y en
      // los últimos COUNTDOWN_WINDOW_MS antes de la próxima línea.
      let show = false;
      if (nextStart != null && activeEnd != null && now >= activeEnd) {
        const ttn = nextStart - now;
        if (ttn > 0 && ttn <= COUNTDOWN_WINDOW_MS) {
          show = true;
          if (countdownBarRef.current) {
            countdownBarRef.current.style.width = `${(1 - ttn / COUNTDOWN_WINDOW_MS) * 100}%`;
          }
          if (countdownLabelRef.current) {
            countdownLabelRef.current.textContent = `NEXT LINE IN ${(ttn / 1000).toFixed(1)}S`;
          }
        }
      }
      if (countdownWrapRef.current) {
        countdownWrapRef.current.style.visibility = show ? "visible" : "hidden";
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, activeIndex, lines, lrcOffset, userOffset, speedRatio, track?.durationMs]);

  if (!open) return null;

  const prevLine = activeIndex - 1 >= 0 ? lines[activeIndex - 1] : null;
  const activeLine = activeIndex >= 0 ? lines[activeIndex] : null;
  const nextLine = lines[activeIndex + 1] ?? null;

  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col select-none">
      {/* Header minimal: cover + artista — título. */}
      <div className="flex items-center gap-4 px-8 py-4 border-b-2 border-fg shrink-0">
        <CoverArt path={track?.coverArtPath} size="sm" />
        <div className="flex-1 min-w-0 truncate uppercase tracking-wider text-sm">
          {track ? `${track.artist} — ${track.title}` : "—"}
        </div>
        <Button size="sm" onClick={() => setKaraokeOpen(false)}>
          EXIT ✕
        </Button>
      </div>

      {/* Centro: línea pasada / countdown / línea activa gigante / próxima. */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-8 px-8 overflow-hidden text-center">
        {hasSynced ? (
          <>
            <div className="h-8 w-full text-muted text-xl uppercase tracking-wider truncate">
              {prevLine?.text || ""}
            </div>

            <div
              ref={countdownWrapRef}
              className="w-full max-w-3xl flex flex-col items-center gap-2"
              style={{ visibility: "hidden" }}
            >
              <div
                ref={countdownLabelRef}
                className="text-accent text-sm uppercase tracking-widest"
              >
                NEXT LINE
              </div>
              <div className="w-full h-2 border-2 border-fg">
                <div
                  ref={countdownBarRef}
                  className="h-full bg-accent"
                  style={{ width: "0%" }}
                />
              </div>
            </div>

            <div
              ref={activeLineRef}
              className="font-display font-bold uppercase tracking-wider leading-tight text-5xl md:text-6xl max-w-5xl"
            >
              {activeLine && activeLine.text.trim() ? (
                splitTokens(activeLine.text).map((tok, k) =>
                  /^\s+$/.test(tok) ? (
                    tok
                  ) : (
                    <span key={k} className="karaoke-word">
                      {tok}
                    </span>
                  ),
                )
              ) : (
                <span className="text-muted">♪</span>
              )}
            </div>

            <div className="h-10 w-full text-fg/60 text-2xl uppercase tracking-wider truncate">
              {nextLine?.text || ""}
            </div>
          </>
        ) : (
          <div className="text-muted uppercase tracking-wider text-sm">
            NO SYNCED LYRICS FOR THIS TRACK
          </div>
        )}
      </div>

      {/* Progress bar abajo + tiempo. */}
      <div className="px-8 py-4 border-t-2 border-fg shrink-0 flex items-center gap-4">
        <div className="flex-1 h-2 border-2 border-fg">
          <div ref={progressBarRef} className="h-full bg-accent" style={{ width: "0%" }} />
        </div>
        <div
          ref={timeLabelRef}
          className="text-xs tabular-nums text-muted shrink-0"
        >
          0:00 / 0:00
        </div>
      </div>
    </div>
  );
}
