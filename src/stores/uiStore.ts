import { create } from "zustand";
import { persist } from "zustand/middleware";

export type View = "library" | "visualizer" | "downloads";

type UiState = {
  view: View;
  presetIndex: number;

  setView: (v: View) => void;
  setPresetIndex: (i: number) => void;
};

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      view: "library",
      presetIndex: 0,

      setView: (v) => set({ view: v }),
      setPresetIndex: (i) => set({ presetIndex: i }),
    }),
    {
      name: "brutalist-player:ui",
      partialize: (state) => ({ presetIndex: state.presetIndex }),
    },
  ),
);
