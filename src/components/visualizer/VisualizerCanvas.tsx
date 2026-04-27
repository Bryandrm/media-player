import { useEffect, useRef } from "react";
import butterchurn, { type Visualizer } from "butterchurn";
import butterchurnPresets from "butterchurn-presets";
import { getAudioContext, getAudioSource } from "../../audio/context";
import { useUiStore } from "../../stores/uiStore";

const PRESETS = butterchurnPresets.getPresets();
export const PRESET_KEYS = Object.keys(PRESETS);

const PRESET_BLEND_S = 2.7;

export function VisualizerCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualizerRef = useRef<Visualizer | null>(null);
  const presetIndex = useUiStore((s) => s.presetIndex);

  // Init: corre una sola vez. Guard contra StrictMode (que dispara el effect 2×
  // en dev) — sin guard, butterchurn crearía 2 contextos WebGL contra el mismo
  // canvas y el primero quedaría huérfano.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || visualizerRef.current) return;

    const audioCtx = getAudioContext();
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {
        // Sin gesto previo, resume() falla. La próxima reproducción lo despierta.
      });
    }

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;

    const visualizer = butterchurn.createVisualizer(audioCtx, canvas, {
      width: w,
      height: h,
      pixelRatio: dpr,
      textureRatio: 1,
    });
    // Crítico: `createVisualizer` recibe width/height en las opts pero NO
    // las aplica al canvas (al menos en v2.6.7). Sin este call, el canvas
    // se queda en 300×150 (default HTML) y todos los framebuffers internos
    // nacen incompletos → zoom-in / esquina recortada / WebGL errors.
    visualizer.setRendererSize(w, h);
    visualizer.connectAudio(getAudioSource());

    // Defensivo: aseguramos que el canvas en CSS llene el contenedor
    // (no que adopte el tamaño del buffer en pixels físicos).
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const startKey = PRESET_KEYS[presetIndex] ?? PRESET_KEYS[0];
    visualizer.loadPreset(PRESETS[startKey], 0);
    visualizerRef.current = visualizer;

    let raf = 0;
    const tick = () => {
      visualizer.render();
      raf = requestAnimationFrame(tick);
    };
    tick();

    // Observamos el CONTENEDOR, no el canvas: ciertos presets tocan el buffer
    // interno del canvas y eso confunde el clientWidth/clientHeight. El padre
    // tiene tamaño dictado por el grid → fuente de verdad estable.
    const obs = new ResizeObserver(() => {
      visualizer.setRendererSize(container.clientWidth, container.clientHeight);
      // Re-forzar el display, por si setRendererSize tocó canvas.style.
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    });
    obs.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
      visualizerRef.current = null;
    };
    // presetIndex se aplica abajo en otro effect — no recreamos el visualizer
    // cada vez que cambia el preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cambio de preset: blend time corto pero perceptible.
  useEffect(() => {
    const v = visualizerRef.current;
    if (!v) return;
    const key = PRESET_KEYS[presetIndex];
    if (!key) return;
    v.loadPreset(PRESETS[key], PRESET_BLEND_S);
  }, [presetIndex]);

  // Contenedor con `relative` + `overflow-hidden` para confinar al canvas
  // aunque Butterchurn le toque el `width`/`height` HTML attributes (lo cual
  // afectaría el intrinsic size sin esto). El canvas va `absolute inset-0`
  // y nunca puede empujar al grid column.
  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-bg"
    >
      <canvas ref={canvasRef} className="absolute inset-0 block w-full h-full" />
    </div>
  );
}
