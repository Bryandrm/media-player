import { useEffect, useMemo, useRef } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { usePlayerStore } from "../../stores/playerStore";
import { useSyncedLyrics } from "../../hooks/useSyncedLyrics";
import { effectiveTimestampMs, parseLrc, type LrcLine } from "../../lib/lrcParser";
import { getAudioElement } from "../../audio/element";
import { Button } from "../ui/Button";

// Vista LYRICS. Estados que cubre:
//   - sin track cargado    → mensaje placeholder
//   - loading              → "fetching lyrics…"
//   - error                → mensaje en accent
//   - not_found            → "NO LYRICS AVAILABLE"
//   - instrumental         → "♪ INSTRUMENTAL ♪"
//   - found + plain only   → texto plano, sin highlight
//   - found + synced       → vista sincronizada con auto-scroll
//
// Auto-scroll usa scrollIntoView({block:"center", behavior:"smooth"}). Si el
// usuario scrollea manual, el próximo cambio de línea lo "yank-ea" de vuelta.
// Acceptable para MVP — Fase 2 puede agregar "pausa auto-scroll si el usuario
// intervino".

export function LyricsView() {
  const trackId = usePlayerStore((s) => s.currentTrackId);
  const lyrics = useLyricsStore((s) => s.current);
  const loading = useLyricsStore((s) => s.loading);
  const notFound = useLyricsStore((s) => s.notFound);
  const error = useLyricsStore((s) => s.error);
  const setOffset = useLyricsStore((s) => s.setOffset);
  const tracks = useLibraryStore((s) => s.tracks);

  const track = useMemo(
    () => (trackId === null ? null : tracks.find((t) => t.id === trackId) ?? null),
    [trackId, tracks],
  );

  // Parse del blob LRC al cambiar el contenido. Memoizado para no re-parsear
  // por cada render del rAF loop.
  const parsed = useMemo(() => {
    if (!lyrics?.syncedLyrics) return null;
    return parseLrc(lyrics.syncedLyrics);
  }, [lyrics?.syncedLyrics]);

  const userOffset = lyrics?.offsetMs ?? 0;
  const lrcOffset = parsed?.metadata.offsetMs ?? 0;
  // Total que aplicamos al audio.currentTime para encontrar la línea actual.
  const effectiveOffset = lrcOffset + userOffset;

  const lines = parsed?.lines ?? [];
  const activeIndex = useSyncedLyrics(lines, effectiveOffset);

  const activeLineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeIndex < 0) return;
    activeLineRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [activeIndex]);

  const onLineClick = (line: LrcLine) => {
    const audio = getAudioElement();
    audio.currentTime =
      effectiveTimestampMs(line, lrcOffset, userOffset) / 1000;
  };

  const adjustOffset = (delta: number) => {
    if (trackId === null) return;
    setOffset(trackId, userOffset + delta);
  };

  const resetOffset = () => {
    if (trackId === null) return;
    setOffset(trackId, 0);
  };

  // === RENDER ===

  if (trackId === null || track === null) {
    return (
      <CenteredMessage>SELECT A TRACK TO SEE ITS LYRICS</CenteredMessage>
    );
  }

  if (loading) {
    return <CenteredMessage>FETCHING LYRICS…</CenteredMessage>;
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-accent text-xs uppercase tracking-wider px-6 text-center">
        ERROR: {error}
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-xs uppercase tracking-wider">
        <div className="text-fg text-base">NO LYRICS AVAILABLE</div>
        <div className="text-muted">TRIED: EMBEDDED · LRCLIB</div>
      </div>
    );
  }

  // Instrumental: source set pero ambos blobs null. LRCLIB lo confirmó como
  // track sin letras (distinto a "no encontramos nada").
  if (lyrics && !lyrics.syncedLyrics && !lyrics.plainLyrics) {
    return (
      <div className="h-full flex items-center justify-center text-fg text-2xl uppercase tracking-widest">
        ♪ INSTRUMENTAL ♪
      </div>
    );
  }

  // Plain-only: sin synced, sólo texto. No hay highlight de línea actual.
  if (lyrics && !parsed && lyrics.plainLyrics) {
    return (
      <div className="h-full flex flex-col">
        <Header source={lyrics.source} mode="plain" confidence={lyrics.confidence} />
        <div className="flex-1 overflow-y-auto px-8 py-6 whitespace-pre-wrap text-sm leading-relaxed text-center">
          {lyrics.plainLyrics}
        </div>
      </div>
    );
  }

  // Synced view.
  if (parsed && lines.length > 0) {
    return (
      <div className="h-full flex flex-col">
        <Header source={lyrics?.source ?? null} mode="synced" confidence={lyrics?.confidence ?? null} />

        {/* py-32 da espacio arriba/abajo para que la línea activa pueda
            quedar centrada vertical incluso al inicio/fin del track. */}
        <div className="flex-1 overflow-y-auto px-8 py-32 text-center">
          {lines.map((line, i) => {
            const distance = i - activeIndex;
            const isActive = distance === 0;
            const isJustPassed = distance === -1;
            const isPast = distance < -1;

            // Estilos por estado. El brutalist no usa transiciones largas:
            // 100ms de transition-colors da suavidad sin sentirse animado.
            let cls =
              "py-1 cursor-pointer transition-colors duration-100 ease-out";
            if (isActive) {
              cls += " text-accent text-2xl font-bold uppercase tracking-wider";
            } else if (isJustPassed) {
              cls += " text-fg text-base";
            } else if (isPast) {
              cls += " text-muted text-sm";
            } else {
              // Futura — fg con menos peso visual que la justJustPassed.
              cls += " text-fg/70 text-base";
            }

            return (
              <div
                key={i}
                ref={isActive ? activeLineRef : null}
                className={cls}
                onClick={() => onLineClick(line)}
              >
                {/* Líneas vacías en LRC son silencios — render visible como
                    "·" para mantener el ritmo visual sin saltos de espacio. */}
                {line.text || "·"}
              </div>
            );
          })}
        </div>

        {/* Offset controls. Brutalist buttons size="sm". */}
        <div className="px-6 py-2 border-t-2 border-fg flex items-center gap-2 text-xs uppercase tracking-wider">
          <span className="text-muted min-w-[110px]">
            OFFSET: {userOffset >= 0 ? "+" : ""}
            {userOffset}MS
          </span>
          <Button size="sm" onClick={() => adjustOffset(-100)}>-100</Button>
          <Button size="sm" onClick={() => adjustOffset(-10)}>-10</Button>
          <Button size="sm" onClick={() => adjustOffset(10)}>+10</Button>
          <Button size="sm" onClick={() => adjustOffset(100)}>+100</Button>
          <Button size="sm" onClick={resetOffset}>RESET</Button>
        </div>
      </div>
    );
  }

  // Fallback inesperado: tenemos algo en lyrics pero no encajó en ninguna
  // rama. Caso defensivo — no debería pasar en práctica.
  return <CenteredMessage>NO LYRICS DATA</CenteredMessage>;
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-muted text-xs uppercase tracking-wider">
      {children}
    </div>
  );
}

function Header({
  source,
  mode,
  confidence,
}: {
  source: string | null;
  mode: "synced" | "plain";
  confidence: number | null;
}) {
  const lowConfidence = confidence !== null && confidence < 0.8;
  return (
    <div className="px-6 py-2 border-b-2 border-fg text-xs uppercase tracking-wider flex justify-between items-center">
      <span className="text-muted">
        {mode === "synced" ? "SYNCED" : "PLAIN ONLY"} — {source ?? "UNKNOWN"}
      </span>
      {lowConfidence && (
        <span className="text-accent">
          ⚠ LOW CONFIDENCE ({Math.round((confidence ?? 0) * 100)}%)
        </span>
      )}
    </div>
  );
}
