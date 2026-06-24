import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getAudioContext } from "../../audio/context";
import { getAudioElement } from "../../audio/element";
import { Button } from "../ui/Button";
import type { Track } from "../../types";

// Resolución interna del canvas. El CSS lo escala a lo ancho del contenedor;
// 2000 px de ancho da resolución suficiente para no verse borroso en pantallas
// anchas (Fase 1 MVP — la precisión por palabra con zoom llega en fases later).
const CANVAS_W = 2000;
const CANVAS_H = 240;
// Fracción del medio-alto que usa el pico más fuerte. <1 deja un margen
// arriba/abajo para que la onda no tope con los bordes del canvas.
const WAVE_V_SCALE = 0.85;

/** Lee un token de color del :root para usarlo en el canvas (los `var(--x)`
 *  no funcionan como fillStyle). */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Downsamplea el canal 0 del AudioBuffer a `buckets` picos (máx abs por
 *  bloque) para dibujar la onda. */
function computePeaks(buffer: AudioBuffer, buckets: number): number[] {
  const data = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / buckets));
  const peaks: number[] = new Array(buckets).fill(0);
  for (let i = 0; i < buckets; i++) {
    const start = i * block;
    const end = Math.min(start + block, data.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

/** T6 Fase 1 (MVP) — editor de timing de lyrics con onda de audio.
 *  Por ahora: onda del track + playhead sincronizado al playback + click-to-seek.
 *  Read-only. Las palabras/cotas arrastrables llegan en fases siguientes.
 *
 *  Usa el MISMO `<audio>` que la reproducción (getAudioElement) — el playhead
 *  sigue `currentTime` y el click setea `currentTime` del track que suena.
 *  Asume que el track del editor es el que está sonando (se abre desde
 *  LyricsView, que sigue al currentTrackId). */
export function WaveformEditor({
  track,
  onClose,
}: {
  track: Track;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<number[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Decode del audio + cálculo de peaks (una vez por track).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    peaksRef.current = null;
    (async () => {
      try {
        const resp = await fetch(convertFileSrc(track.filePath));
        const arr = await resp.arrayBuffer();
        const buf = await getAudioContext().decodeAudioData(arr);
        if (cancelled) return;
        peaksRef.current = computePeaks(buf, CANVAS_W);
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

  // Loop de render: onda (estática) + playhead (cada frame).
  useEffect(() => {
    if (status !== "ready") return;
    const canvas = canvasRef.current;
    const c2d = canvas?.getContext("2d");
    if (!canvas || !c2d) return;

    const fg = cssVar("--color-fg") || "#fff";
    const accent = cssVar("--color-accent") || "#ff3b00";
    const audio = getAudioElement();
    const durationSec = () =>
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : track.durationMs / 1000 || 1;

    let raf = 0;
    const draw = () => {
      const peaks = peaksRef.current;
      if (peaks) {
        const w = canvas.width;
        const h = canvas.height;
        const mid = h / 2;
        c2d.clearRect(0, 0, w, h);
        // Coloreo tipo progreso: las barras YA REPRODUCIDAS van en accent
        // (naranja), las que faltan en fg (blanco). El borde naranja/blanco es
        // la posición actual. Cambiamos fillStyle una sola vez al cruzar.
        const playX = (audio.currentTime / durationSec()) * w;
        // maxAmp < mid deja margen arriba/abajo (la onda no topa los bordes).
        const maxAmp = mid * WAVE_V_SCALE;
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
        // Playhead: línea blanca fina (visible contra el bg negro en cualquier
        // región, incluso en silencios sin barras).
        c2d.fillStyle = fg;
        c2d.fillRect(Math.round(playX), 0, 1, h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [status, track.durationMs]);

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const audio = getAudioElement();
    const dur =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : track.durationMs / 1000 || 1;
    audio.currentTime = frac * dur;
  };

  // Escape cierra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      <div className="flex-1 p-6 flex flex-col gap-3 overflow-auto">
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
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          onClick={onCanvasClick}
          className="w-full border-2 border-fg cursor-pointer"
          style={{ height: CANVAS_H, imageRendering: "pixelated" }}
        />
        <div className="text-muted text-xs uppercase tracking-wider">
          CLICK THE WAVEFORM TO SEEK · FASE 1 (MVP) — PALABRAS + COTAS EN FASES
          SIGUIENTES
        </div>
      </div>
    </div>
  );
}
