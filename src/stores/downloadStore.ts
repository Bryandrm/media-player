import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { DependencyStatus, Download } from "../types";

type DownloadState = {
  downloads: Download[];
  deps: DependencyStatus | null;
  submitting: boolean;
  error: string | null;
  /** Navegador del que yt-dlp lee cookies (`--cookies-from-browser`) para
   *  acceder a playlists privadas / videos con restricción de edad. "" = sin
   *  cookies (descarga anónima). Persistido. */
  cookiesBrowser: string;
  setCookiesBrowser: (browser: string) => void;

  // Acciones llamadas por el hook de eventos:
  upsertDownload: (d: Download) => void;
  updateProgress: (id: number, progress: number) => void;
  /** Item N/M de una descarga de playlist: actualiza el label y reinicia la
   *  barra (el progreso siguiente es del archivo nuevo). */
  setItemProgress: (id: number, current: number, total: number) => void;
  removeDownload: (id: number) => void;

  // Acciones de UI:
  startDownload: (url: string, playlist?: boolean) => Promise<void>;
  checkDependencies: () => Promise<void>;
};

export const useDownloadStore = create<DownloadState>()(
  persist(
    (set, get) => ({
  downloads: [],
  deps: null,
  submitting: false,
  error: null,
  cookiesBrowser: "",

  setCookiesBrowser: (browser) => set({ cookiesBrowser: browser }),

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

  setItemProgress: (id, current, total) =>
    set((state) => ({
      downloads: state.downloads.map((d) =>
        d.id === id
          ? { ...d, title: `ITEM ${current}/${total}`, progress: 0 }
          : d,
      ),
    })),

  removeDownload: (id) =>
    set((state) => ({
      downloads: state.downloads.filter((d) => d.id !== id),
    })),

  startDownload: async (url, playlist = false) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    set({ submitting: true, error: null });
    try {
      // El backend emite eventos durante la descarga; este invoke resuelve
      // recién al terminar. No esperamos al return — la UI ya se actualiza
      // por los eventos `download-started/progress/item/completed`.
      await invoke<Download>("download_track", {
        url: trimmed,
        playlist,
        cookiesBrowser: get().cookiesBrowser || null,
      });
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
    }),
    {
      name: "brutalist-player:downloads",
      // Sólo el browser de cookies se persiste — el resto es runtime state.
      partialize: (state) => ({ cookiesBrowser: state.cookiesBrowser }),
    },
  ),
);
