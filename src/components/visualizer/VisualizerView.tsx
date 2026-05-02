import { useEffect, useRef } from "react";
import { useUiStore, type PlayerPaneMode } from "../../stores/uiStore";
import { useAutoCyclePresets } from "../../hooks/useAutoCyclePresets";
import { LibraryTable } from "../library/LibraryTable";
import { LyricsView } from "../lyrics/LyricsView";
import { PresetSelector } from "./PresetSelector";
import { VisualizerCanvas } from "./VisualizerCanvas";

export function VisualizerView() {
  const split = useUiStore((s) => s.visualizerSplit);
  const setSplit = useUiStore((s) => s.setVisualizerSplit);
  const paneMode = useUiStore((s) => s.playerPaneMode);
  const setPaneMode = useUiStore((s) => s.setPlayerPaneMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Auto-cycle de presets corre incluso cuando paneMode='lyrics' (canvas
  // unmounted) — `setPresetIndex` actualiza el store igual; el canvas
  // recoge el preset nuevo al re-mountarse cuando el usuario vuelve a
  // paneMode='visualizer'.
  useAutoCyclePresets();

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const c = containerRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      setSplit((e.clientX - rect.left) / rect.width);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setSplit]);

  const onDividerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    // Sin esto, el drag selecciona texto en la library mientras movés.
    document.body.style.userSelect = "none";
  };

  return (
    <div
      ref={containerRef}
      className="h-full grid min-h-0"
      // grid: panel-izq | divider (4px) | library. minmax(0, ...) permite
      // que los grid items achiquen por debajo de su min-content (clave
      // para que el split funcione cuando metés más allá del 50%).
      style={{
        gridTemplateColumns: `minmax(0, ${split}fr) 4px minmax(0, ${1 - split}fr)`,
      }}
    >
      <div className="flex flex-col min-h-0 min-w-0">
        <PaneToggle mode={paneMode} setMode={setPaneMode} />
        {/* Canvas + PresetSelector siempre mounted: hidden via display:none
            cuando paneMode='lyrics'. Sin esto, cada toggle re-creaba el
            WebGL context + recompilaba shaders del preset (~100-300ms
            freeze). Con `display: none` el canvas conserva su estado y el
            rAF loop se pausa via `visible` flag en VisualizerCanvas. */}
        <div
          className={
            paneMode === "visualizer"
              ? "flex-1 min-h-0 min-w-0 flex flex-col"
              : "hidden"
          }
        >
          <div className="flex-1 min-h-0 min-w-0">
            <VisualizerCanvas />
          </div>
          <PresetSelector />
        </div>
        {paneMode === "lyrics" && (
          <div className="flex-1 min-h-0 min-w-0">
            <LyricsView />
          </div>
        )}
      </div>
      <div
        onMouseDown={onDividerDown}
        className="bg-fg hover:bg-accent active:bg-accent cursor-col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
      />
      <div className="min-w-0">
        <LibraryTable />
      </div>
    </div>
  );
}

// Toggle inline con el mismo look que las Tabs principales — variant active
// = fondo blanco / texto negro (consistente con `<Button variant="active">`
// y los tabs activos). Sin press-flash explícito: la transición de variant
// ya provee feedback al click.
function PaneToggle({
  mode,
  setMode,
}: {
  mode: PlayerPaneMode;
  setMode: (m: PlayerPaneMode) => void;
}) {
  const items: Array<{ id: PlayerPaneMode; label: string }> = [
    { id: "visualizer", label: "VISUALIZER" },
    { id: "lyrics", label: "LYRICS" },
  ];
  return (
    <nav className="flex border-b-2 border-fg shrink-0">
      {items.map((it) => {
        const active = mode === it.id;
        // Tailwind v4 alphabetical CSS layer ordering: `bg-bg` cae después
        // de `bg-accent` en el output → si concatenamos hover override,
        // `bg-bg` siempre gana. Por eso elegimos UN set completo según el
        // estado en vez de overrides parciales (mismo patrón que <Button>).
        const cls = active
          ? "flex-1 px-4 py-2 text-xs font-bold tracking-wider uppercase bg-fg text-bg transition-colors duration-100 ease-out"
          : "flex-1 px-4 py-2 text-xs font-bold tracking-wider uppercase bg-bg text-fg hover:bg-accent hover:text-bg transition-colors duration-100 ease-out";
        return (
          <button key={it.id} onClick={() => setMode(it.id)} className={cls}>
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}
