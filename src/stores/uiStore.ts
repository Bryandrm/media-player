import { create } from "zustand";
import { persist } from "zustand/middleware";

export type View = "library" | "visualizer" | "downloads" | "eq";

/** Tab activa del sidebar izquierdo en la vista LIBRARY:
 *   - "playlists": lista de playlists (default).
 *   - "details": panel de inspección del track actual. */
export type SidebarTab = "playlists" | "details";

/** Modo del panel izquierdo del VisualizerView. El visualizer y las letras
 *  son views alternativas del track actual — la library queda en el panel
 *  derecho del split. Persistido para que el último modo elegido sobreviva
 *  al reload. */
export type PlayerPaneMode = "visualizer" | "lyrics";

type UiState = {
  view: View;
  presetIndex: number;
  /** Fracción del ancho asignada al panel izquierdo (visualizer/lyrics) en
   *  VisualizerView (0.2..0.8). */
  visualizerSplit: number;
  /** Auto-cycle de presets random cada 5-10s mientras estás en el visualizer. */
  autoCycle: boolean;
  playerPaneMode: PlayerPaneMode;
  /** Tab activa del sidebar en la vista LIBRARY (playlists vs details). */
  sidebarTab: SidebarTab;

  setView: (v: View) => void;
  setPresetIndex: (i: number) => void;
  setVisualizerSplit: (r: number) => void;
  setAutoCycle: (v: boolean) => void;
  setPlayerPaneMode: (m: PlayerPaneMode) => void;
  setSidebarTab: (t: SidebarTab) => void;
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
      playerPaneMode: "visualizer",
      sidebarTab: "playlists",

      setView: (v) => set({ view: v }),
      setPresetIndex: (i) => set({ presetIndex: i }),
      setVisualizerSplit: (r) =>
        set({ visualizerSplit: Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, r)) }),
      setAutoCycle: (v) => set({ autoCycle: v }),
      setPlayerPaneMode: (m) => set({ playerPaneMode: m }),
      setSidebarTab: (t) => set({ sidebarTab: t }),
    }),
    {
      name: "brutalist-player:ui",
      // Bump cuando cambia un default que ya tenemos persistido en
      // localStorage del usuario (ej: pasamos de split 0.6 a 0.4). Sin esto
      // los usuarios existentes se quedan con el valor viejo guardado.
      // Agregar campos nuevos NO requiere bump — Zustand merge usa el
      // initial value cuando el campo falta en la persisted state.
      version: 1,
      partialize: (state) => ({
        presetIndex: state.presetIndex,
        visualizerSplit: state.visualizerSplit,
        autoCycle: state.autoCycle,
        playerPaneMode: state.playerPaneMode,
        sidebarTab: state.sidebarTab,
      }),
    },
  ),
);
