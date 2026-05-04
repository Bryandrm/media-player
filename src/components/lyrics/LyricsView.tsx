import { useEffect, useMemo, useRef, useState } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { usePlayerStore } from "../../stores/playerStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { useSyncedLyrics } from "../../hooks/useSyncedLyrics";
import { effectiveTimestampMs, parseLrc, type LrcLine } from "../../lib/lrcParser";
import { getAudioElement } from "../../audio/element";
import { Button } from "../ui/Button";

// Step de drift correction. ±0.5% por click — granularidad fina pero
// perceptible. Si el usuario tiene drift muy grande, varios clicks llegan
// rápido al ajuste correcto sin overshoot.
const SPEED_RATIO_STEP = 0.005;

// Splittea una línea en tokens de palabra + espacio para el karaoke fill
// per-word. Devuelve cada palabra con su offset acumulado en la línea
// (necesario para que la CSS calcule cuándo se debe rellenar). Los espacios
// se devuelven como tokens "isSpace=true" — se renderizan como texto plano
// para que el browser tenga oportunidad de envolver entre palabras.
type LineToken = { text: string; offset: number; isSpace: boolean };
function splitLineIntoTokens(text: string): LineToken[] {
  // Capturamos los whitespace runs como separadores propios. `filter` saca
  // los empty strings que aparecen al inicio/fin si la string empieza/termina
  // con whitespace.
  const segments = text.split(/(\s+)/).filter((s) => s.length > 0);
  const tokens: LineToken[] = [];
  let offset = 0;
  for (const seg of segments) {
    const isSpace = /^\s+$/.test(seg);
    tokens.push({ text: seg, offset, isSpace });
    offset += seg.length;
  }
  return tokens;
}

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
  const aligning = useLyricsStore((s) => s.aligning);
  const setOffset = useLyricsStore((s) => s.setOffset);
  const setSpeedRatio = useLyricsStore((s) => s.setSpeedRatio);
  const resetSync = useLyricsStore((s) => s.resetSync);
  const alignTrack = useLyricsStore((s) => s.alignTrack);
  const tracks = useLibraryStore((s) => s.tracks);
  const whisperxAvailable = useDownloadStore((s) => s.deps?.whisperx ?? false);

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
  const speedRatio = lyrics?.speedRatio ?? 1.0;
  const lrcOffset = parsed?.metadata.offsetMs ?? 0;

  const lines = parsed?.lines ?? [];
  const activeLineRef = useRef<HTMLDivElement>(null);
  // El hook actualiza `--progress` (0..1) en activeLineRef cada frame
  // sin pasar por React state — el karaoke fill se anima fluido vía CSS
  // sin re-renderizar el subtree de líneas.
  const activeIndex = useSyncedLyrics(lines, lrcOffset, userOffset, speedRatio, activeLineRef);

  // Modo "ALIGN": el próximo click en una línea ajusta el offset para que
  // esa línea coincida con el audio.currentTime actual (en vez de seek-ear).
  // Toggle one-shot — vuelve a false después de un click. Brutalist: hacer
  // explícito con un botón en vez de usar modifier keys (Shift+click no es
  // discoverable, sobre todo en una app desktop sin tooltips ricos).
  const [alignMode, setAlignMode] = useState(false);

  useEffect(() => {
    if (activeIndex < 0) return;
    activeLineRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [activeIndex]);

  const onLineClick = (line: LrcLine) => {
    if (alignMode && trackId !== null) {
      // SET OFFSET HERE: el usuario nos dice "esta línea es la que está
      // sonando AHORA". Calculamos el offset que hace que el timestamp
      // efectivo de esa línea iguale el audio.currentTime actual.
      // Resolviendo: audioMs = (rawTs + lrcOffset) * speedRatio + newUserOffset
      //              newUserOffset = audioMs - (rawTs + lrcOffset) * speedRatio
      // `rawTs` = timestamp de la primera palabra (cuando hay alineación)
      // o del marker de línea (fallback). Mismo principio que el cursor:
      // para líneas alineadas usamos la verdad de whisperx, no el LRC.
      const rawTs = line.wordTimestampsMs?.[0] ?? line.timestampMs;
      const audio = getAudioElement();
      const audioMs = audio.currentTime * 1000;
      const newOffset = Math.round(
        audioMs - (rawTs + lrcOffset) * speedRatio,
      );
      setOffset(trackId, newOffset);
      setAlignMode(false);
      return;
    }
    const audio = getAudioElement();
    audio.currentTime =
      effectiveTimestampMs(line, lrcOffset, userOffset, speedRatio) / 1000;
  };

  const adjustOffset = (delta: number) => {
    if (trackId === null) return;
    setOffset(trackId, userOffset + delta);
  };

  const adjustSpeedRatio = (delta: number) => {
    if (trackId === null) return;
    setSpeedRatio(trackId, speedRatio + delta);
  };

  const onReset = () => {
    if (trackId === null) return;
    resetSync(trackId);
  };

  const onAutoAlign = () => {
    if (trackId === null || aligning) return;
    void alignTrack(trackId);
  };

  // Escape sale del modo ALIGN sin aplicar nada.
  useEffect(() => {
    if (!alignMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAlignMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [alignMode]);

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
        <div className="flex-1 overflow-y-auto px-8 py-6 whitespace-pre-wrap text-sm leading-relaxed text-center font-display">
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
            quedar centrada vertical incluso al inicio/fin del track.
            font-display = Space Grotesk para las líneas — más legible a
            tamaños grandes que la mono default del body. Los controles
            de offset/speed siguen en mono (heredan del body). */}
        <div className="flex-1 overflow-y-auto px-8 py-32 text-center font-display">
          {lines.map((line, i) => {
            const distance = i - activeIndex;
            const isActive = distance === 0;
            const isJustPassed = distance === -1;
            const isPast = distance < -1;

            // Estilos por estado. El brutalist no usa transiciones largas:
            // 100ms de transition-colors da suavidad sin sentirse animado.
            // La línea activa NO usa `text-accent` — el color real lo da
            // el linear-gradient de `karaoke-line` que se va rellenando.
            let cls =
              "py-1 cursor-pointer transition-colors duration-100 ease-out";
            if (isActive) {
              cls += " karaoke-line text-2xl font-bold uppercase tracking-wider";
            } else if (isJustPassed) {
              cls += " text-fg text-base";
            } else if (isPast) {
              cls += " text-muted text-sm";
            } else {
              // Futura — fg con menos peso visual que la justJustPassed.
              cls += " text-fg/70 text-base";
            }

            // Texto display: líneas vacías son silencios, render como "·"
            // para mantener ritmo visual sin saltos.
            const displayText = line.text || "·";
            // Sólo la línea activa se splitea en palabras para el karaoke
            // fill. Las otras se renderizan como texto plano — ahorra DOM
            // nodes (cientos de spans) sin perder funcionalidad.
            return (
              <div
                key={i}
                ref={isActive ? activeLineRef : null}
                className={cls}
                onClick={() => onLineClick(line)}
              >
                {isActive
                  ? splitLineIntoTokens(displayText).map((tok, k) =>
                      tok.isSpace ? (
                        // Espacios como texto plano — el browser los usa
                        // como break opportunities al envolver.
                        tok.text
                      ) : (
                        // `--word-progress` lo escribe useSyncedLyrics
                        // cada frame por palabra. JS hace el cálculo
                        // (linear o A2 según haya wordTimestampsMs); CSS
                        // sólo renderea el gradient.
                        <span key={k} className="karaoke-word">
                          {tok.text}
                        </span>
                      ),
                    )
                  : displayText}
              </div>
            );
          })}
        </div>

        {/* Sync controls. Brutalist buttons size="sm". shrink-0 es
            crítico — sin él, cuando la lista de líneas es larga, el
            flex-shrink default comprime esta barra y los botones quedan
            tapados/fuera del viewport. Mismo issue que sufrimos con el
            Header de arriba.

            Layout: dos filas (offset, drift+align) para no overflowear
            horizontal en panes angostos. */}
        <div className="shrink-0 px-6 py-2 border-t-2 border-fg flex flex-col gap-2 text-xs uppercase tracking-wider">
          <div className="flex items-center gap-2">
            <span className="text-muted min-w-[110px]">
              OFFSET: {userOffset >= 0 ? "+" : ""}
              {userOffset}MS
            </span>
            <Button size="sm" onClick={() => adjustOffset(-1000)}>-1S</Button>
            <Button size="sm" onClick={() => adjustOffset(-100)}>-100</Button>
            <Button size="sm" onClick={() => adjustOffset(-10)}>-10</Button>
            <Button size="sm" onClick={() => adjustOffset(10)}>+10</Button>
            <Button size="sm" onClick={() => adjustOffset(100)}>+100</Button>
            <Button size="sm" onClick={() => adjustOffset(1000)}>+1S</Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-muted min-w-[110px]">
              SPEED: {(speedRatio * 100).toFixed(1)}%
            </span>
            <Button size="sm" onClick={() => adjustSpeedRatio(-SPEED_RATIO_STEP)}>SLOWER</Button>
            <Button size="sm" onClick={() => adjustSpeedRatio(SPEED_RATIO_STEP)}>FASTER</Button>
            {/* ALIGN: toggle one-shot. El próximo click en una línea
                ajusta el offset para alinearla con audio.currentTime.
                Visible por contraste — variant active cuando está on. */}
            <Button
              size="sm"
              variant={alignMode ? "active" : "default"}
              onClick={() => setAlignMode((v) => !v)}
            >
              {alignMode ? "ALIGN: CLICK A LINE" : "ALIGN"}
            </Button>
            <Button size="sm" onClick={onReset}>RESET</Button>
            {/* AUTO-ALIGN: forced alignment via WhisperX. Visible sólo si
                whisperx está instalado. Tarda ~30s-2min — UI no se bloquea
                pero el botón muestra "ALIGNING..." mientras corre. Texto
                cambia a RE-ALIGN una vez que aligned_at está poblado. */}
            {whisperxAvailable && (
              <Button
                size="sm"
                onClick={onAutoAlign}
                disabled={aligning || trackId === null}
                title={
                  lyrics?.alignedAt
                    ? `Last aligned: ${lyrics.alignedAt}`
                    : "Run whisperx forced alignment"
                }
              >
                {aligning
                  ? "ALIGNING..."
                  : lyrics?.alignedAt
                    ? "RE-ALIGN"
                    : "AUTO-ALIGN"}
              </Button>
            )}
          </div>
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
    <div className="shrink-0 px-6 py-2 border-b-2 border-fg text-xs uppercase tracking-wider flex justify-between items-center">
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
