import { create } from "zustand";
import { persist } from "zustand/middleware";

export type View = "library" | "visualizer" | "downloads";

type UiState = {
  view: View;
  presetIndex: number;
  /** Fracción del ancho asignada al canvas en VisualizerView (0.2..0.8). */
  visualizerSplit: number;
  /** Auto-cycle de presets random cada 5-10s mientras estás en el visualizer. */
  autoCycle: boolean;

  setView: (v: View) => void;
  setPresetIndex: (i: number) => void;
  setVisualizerSplit: (r: number) => void;
  setAutoCycle: (v: boolean) => void;
};

const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      view: "library",
      presetIndex: 0,
      visualizerSplit: 0.4,
      autoCycle: false,

      setView: (v) => set({ view: v }),
      setPresetIndex: (i) => set({ presetIndex: i }),
      setVisualizerSplit: (r) =>
        set({ visualizerSplit: Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, r)) }),
      setAutoCycle: (v) => set({ autoCycle: v }),
    }),
    {
      name: "brutalist-player:ui",
      // Bump cuando cambia un default que ya tenemos persistido en
      // localStorage del usuario (ej: pasamos de split 0.6 a 0.4). Sin esto
      // los usuarios existentes se quedan con el valor viejo guardado.
      version: 1,
      partialize: (state) => ({
        presetIndex: state.presetIndex,
        visualizerSplit: state.visualizerSplit,
        autoCycle: state.autoCycle,
      }),
    },
  ),
);
