import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { DependencyStatus, Download } from "../types";

type DownloadState = {
  downloads: Download[];
  deps: DependencyStatus | null;
  submitting: boolean;
  error: string | null;

  // Acciones llamadas por el hook de eventos:
  upsertDownload: (d: Download) => void;
  updateProgress: (id: number, progress: number) => void;
  removeDownload: (id: number) => void;

  // Acciones de UI:
  startDownload: (url: string) => Promise<void>;
  checkDependencies: () => Promise<void>;
};

export const useDownloadStore = create<DownloadState>((set) => ({
  downloads: [],
  deps: null,
  submitting: false,
  error: null,

  upsertDownload: (d) =>
    set((state) => {
      const existing = state.downloads.findIndex((x) => x.id === d.id);
      if (existing === -1) return { downloads: [d, ...state.downloads] };
      const next = state.downloads.slice();
      next[existing] = d;
      return { downloads: next };
    }),

  updateProgress: (id, progress) =>
    set((state) => ({
      downloads: state.downloads.map((d) =>
        d.id === id ? { ...d, progress } : d,
      ),
    })),

  removeDownload: (id) =>
    set((state) => ({
      downloads: state.downloads.filter((d) => d.id !== id),
    })),

  startDownload: async (url) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    set({ submitting: true, error: null });
    try {
      // El backend emite eventos durante la descarga; este invoke resuelve
      // recién al terminar. No esperamos al return — la UI ya se actualiza
      // por los eventos `download-started/progress/completed`.
      await invoke<Download>("download_track", { url: trimmed });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ submitting: false });
    }
  },

  checkDependencies: async () => {
    try {
      const deps = await invoke<DependencyStatus>("check_dependencies");
      set({ deps });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
