import { useEffect } from "react";
import { useUiStore } from "../stores/uiStore";
import { PRESET_KEYS } from "../components/visualizer/VisualizerCanvas";

const MIN_MS = 5000;
const MAX_MS = 10000;

// Cuando `autoCycle` está activo, dispara un cambio a un preset random cada
// 5-10s. Se monta sólo en VisualizerView, así no rota presets cuando el
// usuario no está mirando.
//
// El timer se re-arma en cada cambio de `presetIndex` (manual o automático).
// Eso evita que un click manual te haga un auto-cambio 1s después.
export function useAutoCyclePresets() {
  const autoCycle = useUiStore((s) => s.autoCycle);
  const presetIndex = useUiStore((s) => s.presetIndex);

  useEffect(() => {
    if (!autoCycle) return;
    const delay = MIN_MS + Math.random() * (MAX_MS - MIN_MS);
    const timer = setTimeout(() => {
      const total = PRESET_KEYS.length;
      if (total <= 1) return;
      let next = Math.floor(Math.random() * total);
      if (next === presetIndex) next = (next + 1) % total;
      useUiStore.getState().setPresetIndex(next);
    }, delay);
    return () => clearTimeout(timer);
  }, [autoCycle, presetIndex]);
}
