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
// Ventana mínima (ms) a la que se puede acercar el overview con el zoom.
const MIN_VIEW_MS = 1200;
// Píxeles de arrastre que distinguen un click (seek) de un drag (pan).
const PAN_THRESHOLD_PX = 3;

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
  // Stride: en bloques grandes muestreamos como máximo ~200 samples por barra
  // (max-abs de muestreo ≈ pico real para dibujar). Evita recorrer millones de
  // muestras síncronamente → mata el freeze al abrir el editor.
  const step = Math.max(1, Math.floor(block / 200));
  const peaks = new Array(buckets).fill(0);
  for (let i = 0; i < buckets; i++) {
    const bs = s + i * block;
    const be = Math.min(bs + block, e);
    let max = 0;
    for (let j = bs; j < be; j += step) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

/** Remuestrea `full` (picos de toda la canción, 1 bucket ≈ 1ms) a la ventana
 *  visible [startMs,endMs] dentro de `out` (Float32Array de OVERVIEW_W). Cada
 *  barra de salida toma el máximo de los buckets que caen en su sub-rango → el
 *  zoom/pan re-muestrea en el rAF sin re-leer el AudioBuffer (barato). */
function resampleInto(
  full: number[],
  fullSpanMs: number,
  startMs: number,
  endMs: number,
  out: Float32Array,
) {
  const F = full.length;
  const n = out.length;
  const span = endMs - startMs || 1;
  for (let i = 0; i < n; i++) {
    const t0 = startMs + (i / n) * span;
    const t1 = startMs + ((i + 1) / n) * span;
    let a = Math.floor((t0 / fullSpanMs) * F);
    let b = Math.ceil((t1 / fullSpanMs) * F);
    if (a < 0) a = 0;
    if (b > F) b = F;
    if (b <= a) b = a + 1;
    let max = 0;
    for (let j = a; j < b && j < F; j++) {
      const v = full[j];
      if (v > max) max = v;
    }
    out[i] = max;
  }
}

/** Delta de rueda normalizado a ~px. `deltaMode` 1=líneas, 2=páginas (mouse
 *  wheels viejos / algunos navegadores) → se escalan a px aprox para que la
 *  sensibilidad sea pareja entre trackpad y rueda. Cae a deltaX si no hay Y. */
function normalizeWheelY(e: WheelEvent): number {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  return (e.deltaY || e.deltaX) * unit;
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

/** Mueve toda la línea (todas las palabras) por `deltaMs`, desde un snapshot
 *  `orig` (para no acumular drift). */
function moveSegs(segs: WordSeg[], orig: WordSeg[], deltaMs: number) {
  for (let i = 0; i < segs.length; i++) {
    segs[i].startMs = orig[i].startMs + deltaMs;
    segs[i].endMs = orig[i].endMs + deltaMs;
  }
}

/** Dibuja una onda (picos espejados al centro) con coloreo de progreso:
 *  reproducido en accent, resto en fg. `playFrac` ∈ [0,1] (o fuera de rango
 *  para todo-un-color). */
function drawWave(
  c2d: CanvasRenderingContext2D,
  peaks: ArrayLike<number>,
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
  // Picos de TODA la canción (≈1 bucket/ms). El overview (full o zoom) se
  // dibuja remuestreando esto en el rAF → zoom/pan sin re-leer el buffer.
  const fullPeaksRef = useRef<number[] | null>(null);
  const bufDurMsRef = useRef<number>(0);
  // Buffers reusados para el remuestreo (evitan GC por frame).
  const ovDrawBufRef = useRef<Float32Array>(new Float32Array(OVERVIEW_W));
  const detailDrawBufRef = useRef<Float32Array>(new Float32Array(DETAIL_W));
  // Pan lateral del detalle (ms): corre la ventana de la línea sin cambiar de
  // línea ni zoomear. Se resetea a 0 al cambiar de línea.
  const detailOffsetRef = useRef<number>(0);
  // Pan pending del detalle (igual que el overview: drag = pan, click = seek).
  const detailPanRef = useRef<{
    startClientX: number;
    startOffset: number;
    moved: boolean;
  } | null>(null);
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
  // FOLLOW = el detalle sigue la línea que suena; LOOP = repite la ventana de
  // la línea actual. Mutuamente excluyentes. En refs para que el rAF los lea
  // sin re-crear el loop, + state para el estilo de los botones.
  const [follow, setFollow] = useState(false);
  const [loop, setLoop] = useState(false);
  const followRef = useRef(false);
  const loopRef = useRef(false);
  followRef.current = follow;
  loopRef.current = loop;
  // Línea bajo el cursor en el overview: ref para el highlight del canvas
  // (por frame) + state para el tooltip HTML con la letra.
  const ovHoverRef = useRef<number | null>(null);
  const [ovHover, setOvHover] = useState<{ idx: number; xCss: number } | null>(
    null,
  );
  // Drag de la línea seleccionada en el overview (mover / estirar inicio/fin).
  const ovDragRef = useRef<{
    mode: "move" | "l" | "r";
    grabMs: number;
    orig: WordSeg[];
  } | null>(null);
  // Pan del overview (arrastrar la onda cuando está zoomeada) — pending hasta
  // que el movimiento supere el umbral; si no se movió, el pointerup hace seek.
  const ovPanRef = useRef<{
    startClientX: number;
    startView: { startMs: number; endMs: number };
    moved: boolean;
  } | null>(null);
  // Ventana visible del overview: null = canción completa; si no, [start,end].
  // Es un REF (no state) — el rAF lo lee en vivo y pan/zoom no re-renderizan
  // React. El % de zoom y el botón FULL VIEW se actualizan vía DOM/handlers.
  const viewRef = useRef<{ startMs: number; endMs: number } | null>(null);
  // Span (que muestra el % de zoom) — se actualiza por frame vía textContent.
  const zoomLabelRef = useRef<HTMLSpanElement>(null);

  const clampedIdx = Math.max(0, Math.min(lineIdx, lines.length - 1));
  const line = lines[clampedIdx] as LrcLine | undefined;

  // Extensión [startMs, endMs] de cada línea para el timeline del overview.
  const lineExtents = useMemo(
    () =>
      lines.map((l, i) => {
        const startMs = l.wordTimestampsMs?.[0] ?? l.timestampMs;
        const next = lines[i + 1];
        const nextStart = next?.wordTimestampsMs?.[0] ?? next?.timestampMs;
        const endMs = l.lastWordEndMs ?? nextStart ?? startMs + 3000;
        return { startMs, endMs };
      }),
    [lines],
  );

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
    detailOffsetRef.current = 0;
    detailPanRef.current = null;
    // wordSpanRefs lo repueblan los ref callbacks (no limpiar acá: correría
    // después del commit y borraría los refs recién seteados).
    lastActiveWordRef.current = -1;
  }, [wordSegs]);

  // Decode del audio + peaks del overview (una vez por track).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    bufferRef.current = null;
    fullPeaksRef.current = null;
    viewRef.current = null;
    (async () => {
      try {
        const resp = await fetch(convertFileSrc(track.filePath));
        const arr = await resp.arrayBuffer();
        const buf = await getAudioContext().decodeAudioData(arr);
        if (cancelled) return;
        bufferRef.current = buf;
        // ≈1 bucket/ms (acotado por la longitud del buffer) → el overview
        // remuestrea esto para cualquier nivel de zoom sin recalcular.
        const durMs = buf.duration * 1000;
        bufDurMsRef.current = durMs;
        const fullBuckets = Math.min(
          buf.length,
          Math.max(OVERVIEW_W, Math.ceil(durMs)),
        );
        fullPeaksRef.current = computePeaks(buf, fullBuckets);
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

      // LOOP: al llegar al fin de la ventana de la línea, volver al inicio.
      if (loopRef.current && win && !audio.paused && nowMs >= win.endMs) {
        audio.currentTime = win.startMs / 1000;
      } else if (followRef.current && !loopRef.current) {
        // FOLLOW: seleccionar la línea que está sonando (líneas ascendentes).
        let act = clampedIdx;
        for (let i = 0; i < lineExtents.length; i++) {
          if (lineExtents[i].startMs <= nowMs) act = i;
          else break;
        }
        if (act !== clampedIdx) setLineIdx(act);
      }

      // --- Overview (canción completa o ventana zoomeada) ---
      const full = fullPeaksRef.current;
      const totalMs = durSec() * 1000;
      const view = viewRef.current;
      if (full && bufDurMsRef.current > 0) {
        const r0 = view ? view.startMs : 0;
        const r1 = view ? view.endMs : totalMs;
        const rspan = r1 - r0 || 1;
        const ovX = (ms: number) => ((ms - r0) / rspan) * OVERVIEW_W;
        const ovBuf = ovDrawBufRef.current;
        resampleInto(full, bufDurMsRef.current, r0, r1, ovBuf);
        oc.clearRect(0, 0, OVERVIEW_W, OVERVIEW_H);
        drawWave(oc, ovBuf, OVERVIEW_W, OVERVIEW_H, (nowMs - r0) / rspan, accent, fg);
        // Indicador de zoom: % = canción / ventana visible (100% = full).
        if (zoomLabelRef.current) {
          zoomLabelRef.current.textContent = `${Math.round((totalMs / rspan) * 100)}%`;
        }
        // Timeline de líneas: tick al inicio de cada línea. La hovereada se
        // resalta con un recuadro; la seleccionada con borde fg.
        oc.lineWidth = 1;
        for (let i = 0; i < lineExtents.length; i++) {
          oc.fillStyle = muted;
          oc.fillRect(Math.round(ovX(lineExtents[i].startMs)), 0, 1, OVERVIEW_H);
        }
        const hov = ovHoverRef.current;
        if (hov != null && lineExtents[hov]) {
          const e = lineExtents[hov];
          oc.fillStyle = accent;
          oc.globalAlpha = 0.25;
          oc.fillRect(ovX(e.startMs), 0, Math.max(2, ovX(e.endMs) - ovX(e.startMs)), OVERVIEW_H);
          oc.globalAlpha = 1;
        }
        // Playhead.
        oc.fillStyle = fg;
        oc.fillRect(Math.round(ovX(nowMs)), 0, 1, OVERVIEW_H);
        // Región de la línea SELECCIONADA (en vivo, según editSegs) — caja fg
        // con cotas accent en los bordes (arrastrable: cuerpo=mover, bordes=
        // estirar). Fallback a `win` si no hay palabras.
        const segs = editSegsRef.current;
        const selStart = segs.length ? segs[0].startMs : win?.startMs;
        const selEnd = segs.length ? segs[segs.length - 1].endMs : win?.endMs;
        if (selStart != null && selEnd != null) {
          const sx1 = ovX(selStart);
          const sx2 = ovX(selEnd);
          oc.strokeStyle = fg;
          oc.lineWidth = 2;
          oc.strokeRect(sx1, 1, Math.max(2, sx2 - sx1), OVERVIEW_H - 2);
          if (segs.length) {
            oc.fillStyle = accent;
            oc.fillRect(sx1 - 1, 0, 3, OVERVIEW_H);
            oc.fillRect(sx2 - 2, 0, 3, OVERVIEW_H);
          }
        }
      }

      // --- Detalle (ventana de la línea, desplazable lateralmente por pan) ---
      if (full && win && bufDurMsRef.current > 0) {
        const off = detailOffsetRef.current;
        const w0 = win.startMs + off;
        const w1 = win.endMs + off;
        const span = w1 - w0 || 1;
        const toX = (ms: number) => ((ms - w0) / span) * DETAIL_W;
        const dBuf = detailDrawBufRef.current;
        resampleInto(full, bufDurMsRef.current, w0, w1, dBuf);
        dc.clearRect(0, 0, DETAIL_W, DETAIL_H);
        drawWave(dc, dBuf, DETAIL_W, DETAIL_H, (nowMs - w0) / span, accent, fg);
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

  const songMs = () => {
    const audio = getAudioElement();
    const dur =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : track.durationMs / 1000 || 1;
    return dur * 1000;
  };

  // Rango de tiempo que muestra el overview (zoom o canción completa).
  const ovRange = () => viewRef.current ?? { startMs: 0, endMs: songMs() };

  // Setea la ventana visible clampeada: span >= total → FULL (null); respeta
  // MIN_VIEW_MS y mantiene [0,total]. Es un ref, así que el rAF lo toma solo.
  const setView = (startMs: number, endMs: number) => {
    const total = songMs();
    let s = startMs;
    let e = endMs;
    let span = e - s;
    if (span >= total) {
      viewRef.current = null;
      return;
    }
    if (span < MIN_VIEW_MS) {
      const c = (s + e) / 2;
      s = c - MIN_VIEW_MS / 2;
      e = c + MIN_VIEW_MS / 2;
      span = MIN_VIEW_MS;
    }
    if (s < 0) {
      e -= s;
      s = 0;
    }
    if (e > total) {
      s -= e - total;
      e = total;
      if (s < 0) s = 0;
    }
    viewRef.current = { startMs: s, endMs: e };
  };

  // Zoom centrado en `pivotMs` por un factor (<1 acerca, >1 aleja).
  const zoomAt = (pivotMs: number, factor: number) => {
    const r = ovRange();
    const span = r.endMs - r.startMs;
    const newSpan = Math.max(MIN_VIEW_MS, Math.min(songMs(), span * factor));
    // Mantener el pivote fijo en su posición relativa dentro de la ventana.
    const rel = span > 0 ? (pivotMs - r.startMs) / span : 0.5;
    const ns = pivotMs - rel * newSpan;
    setView(ns, ns + newSpan);
  };

  // Mapea un evento del overview a (ms, xCss, rectW) según el rango visible.
  const overviewAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xCss = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, xCss / rect.width));
    const r = ovRange();
    return {
      ms: r.startMs + frac * (r.endMs - r.startMs),
      xCss,
      rectW: rect.width,
    };
  };

  // Índice de la línea cuyo extent contiene `ms` (líneas ascendentes): última
  // con start <= ms. -1 si ninguna.
  const ovLineAt = (ms: number): number => {
    let idx = -1;
    for (let i = 0; i < lineExtents.length; i++) {
      if (lineExtents[i].startMs <= ms) idx = i;
      else break;
    }
    return idx;
  };

  // Extent [start,end] EN PX CSS de la región de la línea seleccionada en el
  // overview (en vivo, según editSegs). null si no hay palabras.
  const selRegionCss = (rectW: number) => {
    const segs = editSegsRef.current;
    if (!segs.length) return null;
    const r = ovRange();
    const span = r.endMs - r.startMs || 1;
    return {
      x1: ((segs[0].startMs - r.startMs) / span) * rectW,
      x2: ((segs[segs.length - 1].endMs - r.startMs) / span) * rectW,
    };
  };

  const onOverviewPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { ms, xCss, rectW } = overviewAt(e);
    const reg = hasWords ? selRegionCss(rectW) : null;
    // Sobre la región de la línea seleccionada → drag (mover/estirar).
    if (reg) {
      let mode: "move" | "l" | "r" | null = null;
      if (Math.abs(xCss - reg.x1) <= EDGE_PX) mode = "l";
      else if (Math.abs(xCss - reg.x2) <= EDGE_PX) mode = "r";
      else if (xCss > reg.x1 && xCss < reg.x2) mode = "move";
      if (mode) {
        ovDragRef.current = {
          mode,
          grabMs: ms,
          orig: editSegsRef.current.map((s) => ({ ...s })),
        };
        setFollow(false);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    // Si no: pendiente de pan/seek. Si el puntero se mueve > umbral → pan
    // (cuando hay zoom); si no, en el pointerup hace seek (navegar la timeline).
    // No preventDefault: deja pasar el dblclick (zoom).
    ovPanRef.current = {
      startClientX: e.clientX,
      startView: ovRange(),
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onOverviewPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { ms, xCss, rectW } = overviewAt(e);
    const pan = ovPanRef.current;
    if (pan) {
      const rect = e.currentTarget.getBoundingClientRect();
      const dxPx = e.clientX - pan.startClientX;
      if (Math.abs(dxPx) > PAN_THRESHOLD_PX) pan.moved = true;
      // Sólo paneamos si hay zoom (en full view no hay a dónde moverse).
      if (pan.moved && viewRef.current) {
        const span = pan.startView.endMs - pan.startView.startMs;
        const dMs = -(dxPx / rect.width) * span;
        setView(pan.startView.startMs + dMs, pan.startView.endMs + dMs);
        e.currentTarget.style.cursor = "grabbing";
      }
      return;
    }
    const drag = ovDragRef.current;
    if (drag) {
      // MOVER la línea: traslada TODAS las palabras por el mismo delta — las
      // palabras mantienen su duración y distribución (NO se escalan). Clamp a
      // las líneas vecinas. (El fin de línea como contenedor independiente se
      // define en el próximo paso, según se aclare.)
      const segs = editSegsRef.current;
      const orig = drag.orig;
      const prevEnd = lineExtents[clampedIdx - 1]?.endMs ?? 0;
      const nextStart = lineExtents[clampedIdx + 1]?.startMs ?? songMs();
      const oStart = orig[0].startMs;
      const oEnd = orig[orig.length - 1].endMs;
      let d = ms - drag.grabMs;
      d = Math.max(prevEnd - oStart, Math.min(d, nextStart - oEnd));
      moveSegs(segs, orig, d);
      return;
    }
    // Hover (tooltip) cuando no se arrastra.
    const idx = ovLineAt(ms);
    ovHoverRef.current = idx >= 0 ? idx : null;
    setOvHover(idx >= 0 ? { idx, xCss } : null);
    // Cursor: cotas de la línea seleccionada = resize; su cuerpo = grab; con
    // zoom el resto = grab (paneable); en full view = pointer (seek).
    const reg = hasWords ? selRegionCss(rectW) : null;
    let cursor = viewRef.current ? "grab" : "pointer";
    if (reg) {
      if (Math.abs(xCss - reg.x1) <= EDGE_PX || Math.abs(xCss - reg.x2) <= EDGE_PX)
        cursor = "ew-resize";
      else if (xCss > reg.x1 && xCss < reg.x2) cursor = "grab";
    }
    e.currentTarget.style.cursor = cursor;
  };

  const onOverviewPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (ovDragRef.current) {
      ovDragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ya liberado
      }
      return;
    }
    const pan = ovPanRef.current;
    if (pan) {
      ovPanRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ya liberado
      }
      // No se movió → fue un click: seek + seleccionar la línea (navegar la
      // timeline). El zoom es por doble-click, no por click.
      if (!pan.moved) {
        const { ms } = overviewAt(e);
        getAudioElement().currentTime = ms / 1000;
        const idx = ovLineAt(ms);
        if (idx >= 0) {
          setFollow(false);
          setLineIdx(idx);
        }
      }
    }
  };

  // Doble-click = zoom IN centrado en el punto (SHIFT = zoom OUT). El zoom fino
  // continuo es con la rueda; FULL VIEW vuelve a la canción completa.
  const onOverviewDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    ovPanRef.current = null;
    const { ms } = overviewAt(e);
    zoomAt(ms, e.shiftKey ? 2 : 0.5);
    const idx = ovLineAt(ms);
    if (idx >= 0) {
      setFollow(false);
      setLineIdx(idx);
    }
  };

  // Rueda sobre el overview: zoom in/out centrado en el cursor; SHIFT+rueda =
  // pan horizontal. Listener nativo con { passive: false } para poder
  // preventDefault (evita que la página scrollee). Sólo lee refs → no stale.
  useEffect(() => {
    const cv = overviewCanvas.current;
    if (!cv) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = cv.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const r = ovRange();
      const span = r.endMs - r.startMs;
      if (ev.shiftKey) {
        const dMs = (normalizeWheelY(ev) / rect.width) * span;
        setView(r.startMs + dMs, r.endMs + dMs);
      } else {
        const cursorMs = r.startMs + frac * span;
        // Suave: exp(dy·k) con dy capeado por evento. El trackpad dispara
        // ráfagas de eventos con deltaY grande → sin cap saltaba 100%→1000%.
        const dy = Math.max(-50, Math.min(50, normalizeWheelY(ev)));
        zoomAt(cursorMs, Math.exp(dy * 0.0018));
      }
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [status]);

  const onOverviewLeave = () => {
    ovHoverRef.current = null;
    setOvHover(null);
  };

  // --- Interacción del detalle (Fase 3) ---
  // Ventana visible del detalle = la de la línea + el pan lateral.
  const detailW0 = () => (win ? win.startMs + detailOffsetRef.current : 0);
  const detailW1 = () => (win ? win.endMs + detailOffsetRef.current : 0);

  // Clampa el offset del detalle para que la ventana visible quede en [0,song].
  const clampDetailOffset = (off: number) => {
    if (!win) return 0;
    const minOff = -win.startMs;
    const maxOff = songMs() - win.endMs;
    if (maxOff < minOff) return 0;
    return Math.max(minOff, Math.min(maxOff, off));
  };

  // Mapea un pointer event a ms + x/y en px CSS. (El canvas no escala en Y →
  // yCss coincide con la coordenada interna del canvas.)
  const detailPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!win) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const xCss = e.clientX - rect.left;
    const yCss = e.clientY - rect.top;
    const frac = Math.max(0, Math.min(1, xCss / rect.width));
    const w0 = detailW0();
    const w1 = detailW1();
    return {
      ms: w0 + frac * (w1 - w0),
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
    const w0 = detailW0();
    const span = detailW1() - w0 || 1;
    const toCss = (ms: number) => ((ms - w0) / span) * rectW;
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
      // Zona vacía → pendiente de pan/seek: si se arrastra paneamos lateral;
      // si no, en el pointerup hace seek.
      detailPanRef.current = {
        startClientX: e.clientX,
        startOffset: detailOffsetRef.current,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onDetailPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = detailPanRef.current;
    if (pan && win) {
      const rect = e.currentTarget.getBoundingClientRect();
      const dxPx = e.clientX - pan.startClientX;
      if (Math.abs(dxPx) > PAN_THRESHOLD_PX) pan.moved = true;
      if (pan.moved) {
        const span = win.endMs - win.startMs;
        const off = pan.startOffset - (dxPx / rect.width) * span;
        detailOffsetRef.current = clampDetailOffset(off);
        e.currentTarget.style.cursor = "grabbing";
      }
      return;
    }
    const p = detailPointer(e);
    if (!p || !win) return;
    const w0 = detailW0();
    const w1 = detailW1();
    const drag = dragRef.current;
    if (drag) {
      const segs = editSegsRef.current;
      const seg = segs[drag.idx];
      const delta = p.ms - drag.grabMs;
      if (drag.mode === "move") {
        // Mueve manteniendo duración; clamp dentro de la ventana visible.
        const dur = drag.origEnd - drag.origStart;
        const start = Math.max(w0, Math.min(drag.origStart + delta, w1 - dur));
        seg.startMs = start;
        seg.endMs = start + dur;
        // Empuja vecinas en la dirección del movimiento (cualquiera de las dos).
        rippleForward(segs, drag.idx);
        rippleBackward(segs, drag.idx);
      } else if (drag.mode === "l") {
        seg.startMs = Math.max(w0, Math.min(p.ms, seg.endMs - MIN_DUR_MS));
        rippleBackward(segs, drag.idx);
      } else {
        seg.endMs = Math.min(w1, Math.max(p.ms, seg.startMs + MIN_DUR_MS));
        rippleForward(segs, drag.idx);
      }
    } else {
      // Feedback de cursor + hover (sin arrastrar). Zona vacía = grab (paneable).
      const hit = hitTest(p.xCss, p.yCss, p.rectW);
      hoverRef.current = hit;
      e.currentTarget.style.cursor = hit
        ? hit.mode === "move"
          ? "grab"
          : "ew-resize"
        : "grab";
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
      hoverRef.current = null;
      return;
    }
    const pan = detailPanRef.current;
    if (pan) {
      detailPanRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ya liberado
      }
      // No se movió → click = seek.
      if (!pan.moved) {
        const p = detailPointer(e);
        if (p) getAudioElement().currentTime = p.ms / 1000;
      }
    }
    hoverRef.current = null;
  };

  // Rueda sobre el detalle: pan lateral (sin zoom). Listener nativo passive:false.
  useEffect(() => {
    const cv = detailCanvas.current;
    if (!cv) return;
    const onWheel = (ev: WheelEvent) => {
      if (!win) return;
      ev.preventDefault();
      const rect = cv.getBoundingClientRect();
      const span = win.endMs - win.startMs;
      const dMs = (normalizeWheelY(ev) / rect.width) * span;
      detailOffsetRef.current = clampDetailOffset(detailOffsetRef.current + dMs);
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [status, win]);

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

        {/* Overview — timeline de líneas. Click = seek; doble-click = zoom in
            (shift = out); rueda = zoom; shift+rueda o arrastrar = pan. */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3 text-muted text-xs uppercase tracking-wider">
            <span>
              OVERVIEW — CLICK=SEEK · DBLCLICK=ZOOM (SHIFT=OUT) · WHEEL=ZOOM ·
              SHIFT+WHEEL/DRAG=PAN
            </span>
            <Button
              size="sm"
              variant={follow ? "active" : "default"}
              onClick={() => {
                setFollow((v) => !v);
                setLoop(false);
              }}
            >
              FOLLOW
            </Button>
            <Button
              size="sm"
              variant={loop ? "active" : "default"}
              onClick={() => {
                setLoop((v) => !v);
                setFollow(false);
              }}
            >
              LOOP LINE
            </Button>
            <Button
              size="sm"
              onClick={() => {
                viewRef.current = null;
              }}
            >
              FULL VIEW
            </Button>
            <span className="text-fg tabular-nums">
              ZOOM <span ref={zoomLabelRef}>100%</span>
            </span>
          </div>
          <div className="relative">
            <canvas
              ref={overviewCanvas}
              width={OVERVIEW_W}
              height={OVERVIEW_H}
              onPointerDown={onOverviewPointerDown}
              onPointerMove={onOverviewPointerMove}
              onPointerUp={onOverviewPointerUp}
              onDoubleClick={onOverviewDoubleClick}
              onPointerLeave={(e) => {
                onOverviewPointerUp(e);
                onOverviewLeave();
              }}
              className="w-full border-2 border-fg cursor-pointer block"
              style={{
                height: OVERVIEW_H,
                imageRendering: "pixelated",
                touchAction: "none",
              }}
            />
            {ovHover && lines[ovHover.idx] && (
              <div
                className="pointer-events-none absolute -top-1 -translate-x-1/2 -translate-y-full whitespace-nowrap bg-bg border-2 border-fg px-2 py-1 text-fg text-xs"
                style={{ left: ovHover.xCss }}
              >
                {lines[ovHover.idx].text || "·"}
              </div>
            )}
          </div>
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
            = SEEK · DRAG EMPTY / WHEEL = PAN
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
