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
  /** Ruta a un cookies.txt exportado (formato Netscape). Si está seteado, tiene
   *  prioridad sobre `cookiesBrowser` (`--cookies` en vez de
   *  `--cookies-from-browser`). Funciona con el navegador abierto — único camino
   *  viable con Chromium en Windows. "" = no usar archivo. Persistido. */
  cookiesFile: string;
  setCookiesFile: (path: string) => void;

  // Acciones llamadas por el hook de eventos:
  upsertDownload: (d: Download) => void;
  updateProgress: (id: number, progress: number) => void;
  /** Item N/M de una descarga de playlist: actualiza el label y reinicia la
   *  barra (el progreso siguiente es del archivo nuevo). */
  setItemProgress: (id: number, current: number, total: number) => void;
  removeDownload: (id: number) => void;

  // Acciones de UI:
  startDownload: (url: string, playlist?: boolean) => Promise<void>;
  /** Cancela una descarga en curso (mata el yt-dlp asociado en el backend). */
  cancelDownload: (id: number) => void;
  checkDependencies: () => Promise<void>;
  /** Carga el historial persistido (tabla `downloads`) al boot. */
  loadHistory: () => Promise<void>;
  /** Borra del historial las descargas terminales (backend + estado). */
  clearHistory: () => Promise<void>;
};

export const useDownloadStore = create<DownloadState>()(
  persist(
    (set, get) => ({
  downloads: [],
  deps: null,
  submitting: false,
  error: null,
  cookiesBrowser: "",
  cookiesFile: "",

  setCookiesBrowser: (browser) => set({ cookiesBrowser: browser }),
  setCookiesFile: (path) => set({ cookiesFile: path }),

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

  removeDownload: (id) => {
    set((state) => ({
      downloads: state.downloads.filter((d) => d.id !== id),
    }));
    // Borrar también del historial persistido (best-effort).
    invoke("download_delete", { id }).catch((e) =>
      console.warn("download_delete failed:", e),
    );
  },

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
        cookiesFile: get().cookiesFile || null,
      });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ submitting: false });
    }
  },

  cancelDownload: (id) => {
    // El backend mata yt-dlp; el evento terminal (download-completed con status
    // cancelled, o failed) actualiza la fila. Best-effort.
    invoke("download_cancel", { downloadId: id }).catch((e) =>
      console.warn("download_cancel failed:", e),
    );
  },

  checkDependencies: async () => {
    try {
      const deps = await invoke<DependencyStatus>("check_dependencies");
      set({ deps });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadHistory: async () => {
    try {
      const history = await invoke<Download[]>("download_list_history");
      set({ downloads: history });
    } catch (e) {
      console.warn("download_list_history failed:", e);
    }
  },

  clearHistory: async () => {
    try {
      await invoke("download_clear_history");
      // Quitar las terminales del estado; conservar las en curso.
      set((state) => ({
        downloads: state.downloads.filter(
          (d) =>
            d.status === "downloading" ||
            d.status === "postprocessing" ||
            d.status === "queued",
        ),
      }));
    } catch (e) {
      console.warn("download_clear_history failed:", e);
    }
  },
    }),
    {
      name: "brutalist-player:downloads",
      // Sólo la config de cookies se persiste — el resto es runtime state.
      partialize: (state) => ({
        cookiesBrowser: state.cookiesBrowser,
        cookiesFile: state.cookiesFile,
      }),
    },
  ),
);
