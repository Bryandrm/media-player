import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getAudioContext } from "../../audio/context";
import { getAudioElement } from "../../audio/element";
import { Button } from "../ui/Button";
import type { A2Word, LrcLine } from "../../lib/lrcParser";
import type { Track } from "../../types";

// Resolución interna de cada canvas (el CSS lo escala a lo ancho).
const OVERVIEW_W = 2000;
const OVERVIEW_H = 110;
const DETAIL_W = 2000;
const DETAIL_H = 220;
// Fracción del medio-alto que usa el pico más fuerte (margen arriba/abajo).
const WAVE_V_SCALE = 0.85;
// Padding de tiempo alrededor de la línea en el detalle (contexto).
const WINDOW_PAD_MS = 400;
// Zona de agarre (en px CSS) de las cotas izquierda/derecha de una caja.
const EDGE_PX = 7;
// Duración mínima de una palabra al hacer resize (evita cotas cruzadas).
const MIN_DUR_MS = 50;
// Alto (px internos = px CSS, el canvas no escala en Y) de la franja-handle
// arriba de cada caja: ahí está el label de la palabra y es la zona de MOVER.
// El resto del cuerpo de la caja queda clickeable para SEEK.
const HANDLE_H = 34;
// Borde superior de las cajas (px).
const BOX_TOP = 6;

type DragMode = "move" | "l" | "r";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Picos (máx abs por bucket) del canal 0, opcionalmente sobre un rango de
 *  samples — para el zoom del detalle. */
function computePeaks(
  buffer: AudioBuffer,
  buckets: number,
  startSample = 0,
  endSample = buffer.length,
): number[] {
  const data = buffer.getChannelData(0);
  const s = Math.max(0, Math.floor(startSample));
  const e = Math.min(data.length, Math.floor(endSample));
  const span = Math.max(1, e - s);
  const block = Math.max(1, Math.floor(span / buckets));
  const peaks = new Array(buckets).fill(0);
  for (let i = 0; i < buckets; i++) {
    const bs = s + i * block;
    const be = Math.min(bs + block, e);
    let max = 0;
    for (let j = bs; j < be; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

type WordSeg = { text: string; startMs: number; endMs: number };

/** Deriva los segmentos de palabra de una línea A2: start = timestamp de la
 *  palabra; end = end EXPLÍCITO si lo hay (editor → gaps), sino start de la
 *  siguiente (o el end de línea para la última). */
function lineWordSegs(line: LrcLine, lineEndMs: number): WordSeg[] {
  const ts = line.wordTimestampsMs;
  if (!ts || ts.length === 0) return [];
  const words = line.text.split(/\s+/).filter(Boolean);
  const ends = line.wordEndTimestampsMs;
  const segs: WordSeg[] = [];
  for (let i = 0; i < ts.length; i++) {
    const startMs = ts[i];
    const explicit = ends?.[i];
    const endMs =
      explicit != null
        ? explicit
        : i + 1 < ts.length
          ? ts[i + 1]
          : line.lastWordEndMs ?? lineEndMs;
    segs.push({ text: words[i] ?? "", startMs, endMs });
  }
  return segs;
}

/** Push en cascada hacia ADELANTE (Fase 4b): asegura que ninguna palabra
 *  después de `i` empiece antes de que termine la anterior; las desplaza
 *  manteniendo su duración. Corta en la primera que ya no colisiona. */
function rippleForward(segs: WordSeg[], i: number) {
  let prevEnd = segs[i].endMs;
  for (let j = i + 1; j < segs.length; j++) {
    if (segs[j].startMs < prevEnd) {
      const dur = segs[j].endMs - segs[j].startMs;
      segs[j].startMs = prevEnd;
      segs[j].endMs = prevEnd + dur;
      prevEnd = segs[j].endMs;
    } else break;
  }
}

/** Push en cascada hacia ATRÁS: ninguna palabra antes de `i` termina después
 *  de que empiece la siguiente; las desplaza manteniendo su duración. */
function rippleBackward(segs: WordSeg[], i: number) {
  let nextStart = segs[i].startMs;
  for (let j = i - 1; j >= 0; j--) {
    if (segs[j].endMs > nextStart) {
      const dur = segs[j].endMs - segs[j].startMs;
      segs[j].endMs = nextStart;
      segs[j].startMs = nextStart - dur;
      nextStart = segs[j].startMs;
    } else break;
  }
}

/** Dibuja una onda (picos espejados al centro) con coloreo de progreso:
 *  reproducido en accent, resto en fg. `playFrac` ∈ [0,1] (o fuera de rango
 *  para todo-un-color). */
function drawWave(
  c2d: CanvasRenderingContext2D,
  peaks: number[],
  w: number,
  h: number,
  playFrac: number,
  accent: string,
  fg: string,
) {
  const mid = h / 2;
  const maxAmp = mid * WAVE_V_SCALE;
  const playX = playFrac * w;
  c2d.fillStyle = accent;
  let switched = false;
  for (let x = 0; x < peaks.length; x++) {
    if (!switched && x > playX) {
      c2d.fillStyle = fg;
      switched = true;
    }
    const amp = peaks[x] * maxAmp;
    c2d.fillRect(x, mid - amp, 1, amp * 2 || 1);
  }
}

/** T6 — editor de timing de lyrics con waveform.
 *  Fase 1: overview de la canción. Fase 2: detalle por línea con las palabras
 *  como cajas sobre la onda (read-only). El arrastre de cotas llega en Fase 3.
 */
export function WaveformEditor({
  track,
  lines,
  initialLineIdx,
  onSaveLine,
  onClose,
}: {
  track: Track;
  lines: LrcLine[];
  initialLineIdx: number;
  onSaveLine: (line: LrcLine, segs: A2Word[]) => Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const overviewPeaksRef = useRef<number[] | null>(null);
  const detailPeaksRef = useRef<number[] | null>(null);
  const overviewCanvas = useRef<HTMLCanvasElement>(null);
  const detailCanvas = useRef<HTMLCanvasElement>(null);
  // Fase 3 — segmentos editables de la línea actual (copia mutable que el
  // drag modifica; el rAF la dibuja). Se resetea al cambiar de línea. En un
  // ref para no re-renderizar React en cada pointermove.
  const editSegsRef = useRef<WordSeg[]>([]);
  const dragRef = useRef<{
    idx: number;
    mode: DragMode;
    grabMs: number;
    origStart: number;
    origEnd: number;
  } | null>(null);
  // Caja/cota bajo el cursor (para resaltar el handle en hover).
  const hoverRef = useRef<{ idx: number; mode: DragMode } | null>(null);
  // Spans de la letra de abajo + última palabra activa (para resaltar sin
  // re-renderizar React en cada frame).
  const wordSpanRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const lastActiveWordRef = useRef<number>(-1);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [lineIdx, setLineIdx] = useState(() =>
    Math.max(0, Math.min(initialLineIdx, lines.length - 1)),
  );

  const clampedIdx = Math.max(0, Math.min(lineIdx, lines.length - 1));
  const line = lines[clampedIdx] as LrcLine | undefined;

  // Ventana de tiempo [startMs, endMs] que muestra el detalle para la línea.
  const win = useMemo(() => {
    if (!line) return null;
    const startMs = line.wordTimestampsMs?.[0] ?? line.timestampMs;
    const next = lines[clampedIdx + 1];
    const nextStart = next?.wordTimestampsMs?.[0] ?? next?.timestampMs;
    const endMs = line.lastWordEndMs ?? nextStart ?? startMs + 4000;
    return {
      startMs: Math.max(0, startMs - WINDOW_PAD_MS),
      endMs: endMs + WINDOW_PAD_MS,
      lineEndMs: endMs,
    };
  }, [line, clampedIdx, lines]);

  const wordSegs = useMemo(
    () => (line && win ? lineWordSegs(line, win.lineEndMs) : []),
    [line, win],
  );

  // Reset de los segmentos editables cuando cambia la línea (o el decode).
  useEffect(() => {
    editSegsRef.current = wordSegs.map((s) => ({ ...s }));
    dragRef.current = null;
    hoverRef.current = null;
    // wordSpanRefs lo repueblan los ref callbacks (no limpiar acá: correría
    // después del commit y borraría los refs recién seteados).
    lastActiveWordRef.current = -1;
  }, [wordSegs]);

  // Decode del audio + peaks del overview (una vez por track).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    bufferRef.current = null;
    overviewPeaksRef.current = null;
    detailPeaksRef.current = null;
    (async () => {
      try {
        const resp = await fetch(convertFileSrc(track.filePath));
        const arr = await resp.arrayBuffer();
        const buf = await getAudioContext().decodeAudioData(arr);
        if (cancelled) return;
        bufferRef.current = buf;
        overviewPeaksRef.current = computePeaks(buf, OVERVIEW_W);
        setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          console.error("[waveform] decode failed:", e);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [track.filePath]);

  // Peaks del detalle: se recalculan al cambiar la ventana (línea) o al decodar.
  useEffect(() => {
    if (status !== "ready" || !bufferRef.current || !win) return;
    const buf = bufferRef.current;
    const sr = buf.sampleRate;
    detailPeaksRef.current = computePeaks(
      buf,
      DETAIL_W,
      (win.startMs / 1000) * sr,
      (win.endMs / 1000) * sr,
    );
  }, [status, win]);

  // Loop de render (overview + detalle).
  useEffect(() => {
    if (status !== "ready") return;
    const oc = overviewCanvas.current?.getContext("2d");
    const dc = detailCanvas.current?.getContext("2d");
    if (!oc || !dc) return;
    const fg = cssVar("--color-fg") || "#fff";
    const accent = cssVar("--color-accent") || "#ff3b00";
    const muted = cssVar("--color-muted") || "#888";
    const audio = getAudioElement();
    const durSec = () =>
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : track.durationMs / 1000 || 1;

    let raf = 0;
    const draw = () => {
      const nowMs = audio.currentTime * 1000;

      // --- Overview ---
      const ov = overviewPeaksRef.current;
      if (ov) {
        oc.clearRect(0, 0, OVERVIEW_W, OVERVIEW_H);
        drawWave(oc, ov, OVERVIEW_W, OVERVIEW_H, nowMs / (durSec() * 1000), accent, fg);
        // Playhead.
        oc.fillStyle = fg;
        oc.fillRect(Math.round((nowMs / (durSec() * 1000)) * OVERVIEW_W), 0, 1, OVERVIEW_H);
        // Marcador de la ventana del detalle (dónde está el zoom).
        if (win) {
          const totalMs = durSec() * 1000;
          const x1 = (win.startMs / totalMs) * OVERVIEW_W;
          const x2 = (win.endMs / totalMs) * OVERVIEW_W;
          oc.strokeStyle = muted;
          oc.lineWidth = 2;
          oc.strokeRect(x1, 1, Math.max(2, x2 - x1), OVERVIEW_H - 2);
        }
      }

      // --- Detalle ---
      const dp = detailPeaksRef.current;
      if (dp && win) {
        const span = win.endMs - win.startMs || 1;
        const toX = (ms: number) => ((ms - win.startMs) / span) * DETAIL_W;
        dc.clearRect(0, 0, DETAIL_W, DETAIL_H);
        drawWave(dc, dp, DETAIL_W, DETAIL_H, (nowMs - win.startMs) / span, accent, fg);
        // Cajas de palabra (outline + texto). Las cotas (bordes) serán
        // arrastrables en Fase 3.
        dc.lineWidth = 2;
        dc.font = "16px monospace";
        dc.textBaseline = "top";
        const dragging = dragRef.current;
        const hover = hoverRef.current;
        const segs = editSegsRef.current;
        const boxH = DETAIL_H - 12;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          const x1 = toX(seg.startMs);
          const x2 = toX(seg.endMs);
          const bw = Math.max(1, x2 - x1);
          const active = dragging?.idx === i;
          const handleOpaque = active || hover?.idx === i;
          // Caja: outline full-height (accent si se está arrastrando).
          dc.strokeStyle = active ? accent : fg;
          dc.strokeRect(x1, BOX_TOP, bw, boxH);
          // Franja-handle de arriba (zona de MOVER): translúcida, opaca en
          // hover/drag — la idea del "icono translúcido" que pediste.
          dc.globalAlpha = handleOpaque ? 0.9 : 0.28;
          dc.fillStyle = accent;
          dc.fillRect(x1, BOX_TOP, bw, HANDLE_H);
          dc.globalAlpha = 1;
          // Label de la palabra en la franja.
          if (bw > 14 && seg.text) {
            dc.fillStyle = fg;
            dc.save();
            dc.beginPath();
            dc.rect(x1 + 2, BOX_TOP + 1, bw - 4, HANDLE_H - 2);
            dc.clip();
            dc.fillText(seg.text, x1 + 5, BOX_TOP + 9);
            dc.restore();
          }
          // Cota resaltada en hover (discoverability del resize).
          if (hover?.idx === i && (hover.mode === "l" || hover.mode === "r")) {
            dc.fillStyle = accent;
            const ex = hover.mode === "l" ? x1 : x2;
            dc.fillRect(ex - 1, BOX_TOP, 3, boxH);
          }
        }

        // Resalta la palabra activa en la letra de abajo según el timing
        // EDITADO (así arrastrar cambia el highlight en vivo). DOM directo
        // para no re-renderizar React cada frame.
        let activeWord = -1;
        for (let i = 0; i < segs.length; i++) {
          if (nowMs >= segs[i].startMs && nowMs < segs[i].endMs) {
            activeWord = i;
            break;
          }
        }
        if (activeWord !== lastActiveWordRef.current) {
          const spans = wordSpanRefs.current;
          const prev = lastActiveWordRef.current;
          if (prev >= 0 && spans[prev]) spans[prev]!.style.color = fg;
          if (activeWord >= 0 && spans[activeWord])
            spans[activeWord]!.style.color = accent;
          lastActiveWordRef.current = activeWord;
        }
        // Playhead del detalle (si cae dentro de la ventana).
        const px = toX(nowMs);
        if (px >= 0 && px <= DETAIL_W) {
          dc.fillStyle = accent;
          dc.fillRect(Math.round(px), 0, 2, DETAIL_H);
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [status, win, wordSegs, track.durationMs]);

  const seekOverview = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const audio = getAudioElement();
    const dur =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : track.durationMs / 1000 || 1;
    audio.currentTime = frac * dur;
  };

  // --- Interacción del detalle (Fase 3) ---
  // Mapea un pointer event a ms + x/y en px CSS. (El canvas no escala en Y →
  // yCss coincide con la coordenada interna del canvas.)
  const detailPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!win) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const xCss = e.clientX - rect.left;
    const yCss = e.clientY - rect.top;
    const frac = Math.max(0, Math.min(1, xCss / rect.width));
    return {
      ms: win.startMs + frac * (win.endMs - win.startMs),
      xCss,
      yCss,
      rectW: rect.width,
    };
  };

  // ¿Qué caja/cota hay bajo el puntero? Cotas izq/der = resize (toda la altura
  // de la caja); franja-handle de arriba = move; cuerpo = null (→ seek).
  const hitTest = (
    xCss: number,
    yCss: number,
    rectW: number,
  ): { idx: number; mode: DragMode } | null => {
    if (!win) return null;
    const span = win.endMs - win.startMs || 1;
    const toCss = (ms: number) => ((ms - win.startMs) / span) * rectW;
    const boxBottom = DETAIL_H - 6;
    if (yCss < BOX_TOP || yCss > boxBottom) return null;
    const segs = editSegsRef.current;
    for (let i = 0; i < segs.length; i++) {
      const x1 = toCss(segs[i].startMs);
      const x2 = toCss(segs[i].endMs);
      if (Math.abs(xCss - x1) <= EDGE_PX) return { idx: i, mode: "l" };
      if (Math.abs(xCss - x2) <= EDGE_PX) return { idx: i, mode: "r" };
      if (xCss > x1 && xCss < x2) {
        // Sólo la franja de arriba (el label) mueve; el resto = seek.
        return yCss <= BOX_TOP + HANDLE_H ? { idx: i, mode: "move" } : null;
      }
    }
    return null;
  };

  const onDetailPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = detailPointer(e);
    if (!p) return;
    const hit = hitTest(p.xCss, p.yCss, p.rectW);
    if (hit) {
      const seg = editSegsRef.current[hit.idx];
      dragRef.current = {
        idx: hit.idx,
        mode: hit.mode,
        grabMs: p.ms,
        origStart: seg.startMs,
        origEnd: seg.endMs,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else {
      // Zona vacía → seek.
      getAudioElement().currentTime = p.ms / 1000;
    }
  };

  const onDetailPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = detailPointer(e);
    if (!p || !win) return;
    const drag = dragRef.current;
    if (drag) {
      const segs = editSegsRef.current;
      const seg = segs[drag.idx];
      const delta = p.ms - drag.grabMs;
      if (drag.mode === "move") {
        // Mueve manteniendo duración; clamp dentro de la ventana.
        const dur = drag.origEnd - drag.origStart;
        const start = Math.max(
          win.startMs,
          Math.min(drag.origStart + delta, win.endMs - dur),
        );
        seg.startMs = start;
        seg.endMs = start + dur;
        // Empuja vecinas en la dirección del movimiento (cualquiera de las dos).
        rippleForward(segs, drag.idx);
        rippleBackward(segs, drag.idx);
      } else if (drag.mode === "l") {
        seg.startMs = Math.max(
          win.startMs,
          Math.min(p.ms, seg.endMs - MIN_DUR_MS),
        );
        rippleBackward(segs, drag.idx);
      } else {
        seg.endMs = Math.min(win.endMs, Math.max(p.ms, seg.startMs + MIN_DUR_MS));
        rippleForward(segs, drag.idx);
      }
    } else {
      // Feedback de cursor + hover (sin arrastrar).
      const hit = hitTest(p.xCss, p.yCss, p.rectW);
      hoverRef.current = hit;
      e.currentTarget.style.cursor = hit
        ? hit.mode === "move"
          ? "grab"
          : "ew-resize"
        : "pointer";
    }
  };

  const onDetailPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // pointer ya liberado — no pasa nada
      }
    }
    hoverRef.current = null;
  };

  // Escape cierra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasWords = wordSegs.length > 0;

  const onSaveClick = async () => {
    if (!line || !hasWords || saving) return;
    setSaving(true);
    try {
      await onSaveLine(
        line,
        editSegsRef.current.map((s) => ({ ...s })),
      );
    } catch {
      // el store ya logueó/seteó el error
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-bg flex flex-col">
      <div className="flex items-center justify-between px-6 py-3 border-b-2 border-fg shrink-0">
        <div className="uppercase tracking-wider text-sm">
          TIMING EDITOR — {track.artist} — {track.title}
        </div>
        <Button size="sm" onClick={onClose}>
          CLOSE
        </Button>
      </div>

      <div className="flex-1 p-6 flex flex-col gap-4 overflow-auto">
        {status === "loading" && (
          <div className="text-muted text-xs uppercase tracking-wider">
            DECODING AUDIO…
          </div>
        )}
        {status === "error" && (
          <div className="text-accent text-xs uppercase tracking-wider">
            FAILED TO DECODE AUDIO
          </div>
        )}

        {/* Overview — canción completa. Click = seek. El recuadro gris marca
            la ventana que muestra el detalle. */}
        <div className="flex flex-col gap-1">
          <div className="text-muted text-xs uppercase tracking-wider">
            OVERVIEW — CLICK TO SEEK
          </div>
          <canvas
            ref={overviewCanvas}
            width={OVERVIEW_W}
            height={OVERVIEW_H}
            onClick={seekOverview}
            className="w-full border-2 border-fg cursor-pointer"
            style={{ height: OVERVIEW_H, imageRendering: "pixelated" }}
          />
        </div>

        {/* Nav de líneas. */}
        <div className="flex items-center gap-3 text-sm uppercase tracking-wider">
          <Button
            size="sm"
            onClick={() => setLineIdx(clampedIdx - 1)}
            disabled={clampedIdx <= 0}
          >
            ◂ PREV
          </Button>
          <span className="text-muted">
            LINE {clampedIdx + 1}/{lines.length}
          </span>
          <Button
            size="sm"
            onClick={() => setLineIdx(clampedIdx + 1)}
            disabled={clampedIdx >= lines.length - 1}
          >
            NEXT ▸
          </Button>
          <span className="flex-1 min-w-0 text-fg normal-case tracking-normal truncate">
            {line?.text || "·"}
          </span>
          <Button
            size="sm"
            variant="active"
            onClick={onSaveClick}
            disabled={!hasWords || saving}
          >
            {saving ? "SAVING…" : "SAVE LINE"}
          </Button>
        </div>

        {/* Detalle — zoom a la línea con las palabras como cajas. Click = seek. */}
        <div className="flex flex-col gap-1">
          <div className="text-muted text-xs uppercase tracking-wider">
            DETAIL — DRAG WORD LABEL (TOP) = MOVE · DRAG EDGES = RESIZE · CLICK
            WAVEFORM = SEEK · NOT SAVED YET (FASE 4)
          </div>
          <canvas
            ref={detailCanvas}
            width={DETAIL_W}
            height={DETAIL_H}
            onPointerDown={onDetailPointerDown}
            onPointerMove={onDetailPointerMove}
            onPointerUp={onDetailPointerUp}
            onPointerLeave={onDetailPointerUp}
            className="w-full border-2 border-fg"
            style={{ height: DETAIL_H, imageRendering: "pixelated", touchAction: "none" }}
          />
          {!hasWords && status === "ready" && (
            <div className="text-muted text-xs uppercase tracking-wider">
              NO PER-WORD TIMING FOR THIS LINE — RUN AUTO-ALIGN FOR WORD BOXES
            </div>
          )}
        </div>

        {/* Letra de la línea — la palabra activa se resalta según el timing
            EDITADO (arrastrar cambia el highlight en vivo). */}
        <div className="flex flex-col gap-1">
          <div className="text-muted text-xs uppercase tracking-wider">
            LYRICS — ACTIVE WORD HIGHLIGHTS BY THE EDITED TIMING
          </div>
          <div className="px-2 py-4 font-display text-3xl uppercase tracking-wider text-center flex flex-wrap gap-x-3 gap-y-1 justify-center">
            {hasWords ? (
              wordSegs.map((s, i) => (
                <span
                  key={i}
                  ref={(el) => {
                    wordSpanRefs.current[i] = el;
                  }}
                  className="text-fg"
                >
                  {s.text}
                </span>
              ))
            ) : (
              <span className="text-muted text-base normal-case tracking-normal">
                {line?.text || "·"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
