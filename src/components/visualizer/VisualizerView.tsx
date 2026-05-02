import { useEffect, useRef } from "react";
import { useUiStore } from "../../stores/uiStore";
import { useAutoCyclePresets } from "../../hooks/useAutoCyclePresets";
import { LibraryTable } from "../library/LibraryTable";
import { PresetSelector } from "./PresetSelector";
import { VisualizerCanvas } from "./VisualizerCanvas";

export function VisualizerView() {
  const split = useUiStore((s) => s.visualizerSplit);
  const setSplit = useUiStore((s) => s.setVisualizerSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // El cycle sólo corre mientras esta vista está montada → cuando navegás
  // a LIBRARY/DOWNLOADS el timer se cancela y al volver re-arranca.
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
      // grid: canvas | divider (4px) | library. minmax(0, ...) permite que
      // los grid items achiquen por debajo de su min-content (clave para que
      // el split funcione cuando metés más allá del 50%).
      style={{
        gridTemplateColumns: `minmax(0, ${split}fr) 4px minmax(0, ${1 - split}fr)`,
      }}
    >
      <div className="flex flex-col min-h-0 min-w-0">
        <div className="flex-1 min-h-0 min-w-0">
          <VisualizerCanvas />
        </div>
        <PresetSelector />
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
