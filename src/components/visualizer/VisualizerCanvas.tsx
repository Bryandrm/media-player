import { useEffect, useRef } from "react";
import butterchurn, { type Visualizer } from "butterchurn";
import butterchurnPresets from "butterchurn-presets";
import { getAudioContext, getVisualizerTap } from "../../audio/context";
import { useUiStore } from "../../stores/uiStore";

const PRESETS = butterchurnPresets.getPresets();
export const PRESET_KEYS = Object.keys(PRESETS);

const PRESET_BLEND_S = 2.7;

// Persistent mount: este componente se monta UNA VEZ (cuando el usuario
// visita VISUALIZER por primera vez) y queda montado hasta cerrar la app.
// Esconde via CSS (parent con `invisible pointer-events-none` o display:none)
// cuando el usuario navega afuera. El rAF loop se pausa en background para
// no quemar CPU/GPU mientras nadie lo ve.
//
// Por qué persistir:
//   `butterchurn.createVisualizer()` + `loadPreset()` compilan shaders WebGL
//   sincronamente en el main thread, ~100-300ms de freeze por mount. Hacer
//   eso en cada tab change era inaceptable. Mantener el WebGL context vivo
//   tiene un costo de memoria (~50MB GPU+JS combinado), aceptable para un
//   reproductor desktop personal.
export function VisualizerCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualizerRef = useRef<Visualizer | null>(null);
  const presetIndex = useUiStore((s) => s.presetIndex);
  const view = useUiStore((s) => s.view);
  const paneMode = useUiStore((s) => s.playerPaneMode);
  // Visible cuando el canvas está efectivamente en pantalla. Cuando false,
  // pausamos el rAF loop. ResizeObserver además skipea sizes 0 — un padre
  // con `display: none` reporta clientWidth=0 y setRendererSize(0,0) sería
  // trabajo innecesario que se pagaría al volver.
  const visible = view === "visualizer" && paneMode === "visualizer";

  // Init effect — corre una sola vez. Crea visualizer, conecta audio, carga
  // preset inicial, attacha ResizeObserver. NO arranca el rAF loop — eso lo
  // hace el effect de visibilidad de abajo.
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
    // Tapeamos `preMasterGain` (la mezcla de los dos canales) en vez del
    // source de un canal puntual — durante un crossfade ambos canales
    // contribuyen al audio output, y queremos que el visualizer reaccione
    // a la mezcla, no sólo al canal activo. Ver audio/context.ts.
    visualizer.connectAudio(getVisualizerTap());

    // Defensivo: aseguramos que el canvas en CSS llene el contenedor
    // (no que adopte el tamaño del buffer en pixels físicos).
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const startKey = PRESET_KEYS[presetIndex] ?? PRESET_KEYS[0];
    visualizer.loadPreset(PRESETS[startKey], 0);
    visualizerRef.current = visualizer;

    // Observamos el CONTENEDOR, no el canvas: ciertos presets tocan el buffer
    // interno del canvas y eso confunde el clientWidth/clientHeight. El padre
    // tiene tamaño dictado por el grid → fuente de verdad estable.
    //
    // Skip si w/h son 0 (parent con display:none). setRendererSize(0,0)
    // shrinkearía los framebuffers y al volver tocaría re-allocar — barato
    // pero innecesario; mejor evitarlo del todo.
    const obs = new ResizeObserver(() => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw === 0 || ch === 0) return;
      visualizer.setRendererSize(cw, ch);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
    });
    obs.observe(container);

    return () => {
      obs.disconnect();
      visualizerRef.current = null;
    };
    // presetIndex se aplica abajo en otro effect — no recreamos el visualizer
    // cada vez que cambia el preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // rAF loop — gated por `visible`. Cuando el canvas no se ve (otra tab,
  // paneMode lyrics, etc), el último frame queda estático en el bitmap del
  // canvas y no quemamos CPU/GPU calculando frames invisibles.
  //
  // Nota: rAF no se auto-pausa cuando un elemento está `visibility: hidden`
  // o display:none — sólo se pausa cuando la pestaña entera está oculta
  // (Page Visibility API). Por eso necesitamos esta gate explícita.
  useEffect(() => {
    const v = visualizerRef.current;
    if (!v || !visible) return;
    let raf = 0;
    const tick = () => {
      v.render();
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  // Cambio de preset: blend time corto pero perceptible. `loadPreset` compila
  // shaders síncronamente — sólo lo disparamos cuando la UI puede recibir el
  // resultado (presetIndex sólo cambia vía clicks en PresetSelector que es
  // inaccesible cuando no estamos visibles, o vía auto-cycle que está gated
  // por visible en useAutoCyclePresets).
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
