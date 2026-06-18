import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlaylistStore } from "./playlistStore";
import type { Track, ScanReport } from "../types";

type LibraryState = {
  tracks: Track[];
  scanning: boolean;
  lastReport: ScanReport | null;
  error: string | null;
  /** Query del search input. No se persiste — ephemeral por sesión. */
  searchQuery: string;
  /** True mientras corre el comando de backfill metadata — evita doble click. */
  cleaning: boolean;
  /** Cantidad de tracks updateados por el último backfill. null = nunca corrió. */
  lastCleanedCount: number | null;

  setError: (e: string | null) => void;
  setSearchQuery: (q: string) => void;
  loadTracks: () => Promise<void>;
  backfillCovers: () => Promise<void>;
  backfillMetadata: () => Promise<void>;
  scanDirectory: () => Promise<void>;
  /** Importa paths (archivos o carpetas) arrastrados desde el explorador.
   *  Reusa el mismo insert idempotente que el scan. */
  importPaths: (paths: string[]) => Promise<void>;
};

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  scanning: false,
  lastReport: null,
  error: null,
  searchQuery: "",
  cleaning: false,
  lastCleanedCount: null,

  setError: (e) => set({ error: e }),
  setSearchQuery: (q) => set({ searchQuery: q }),

  loadTracks: async () => {
    try {
      const list = await invoke<Track[]>("library_list_tracks");
      set({ tracks: list });
      // Mantener en sync el cache de la playlist seleccionada. La vista de
      // playlist (PlaylistSidebar → tracksOfSelected) es un cache aparte que
      // viene de un JOIN con los mismos campos derivados (lyrics_status, ID).
      // Si no lo refrescamos acá, identificar/limpiar/escanear/fetchear letras
      // actualiza la library pero deja la playlist con datos viejos. Como TODOS
      // esos flujos pasan por loadTracks(), este es el único punto de sync.
      const { selectedId, reloadSelectedTracks } = usePlaylistStore.getState();
      if (selectedId !== null) await reloadSelectedTracks();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  backfillCovers: async () => {
    // Best-effort: si falla, no bloqueamos la app. Si actualiza algo, re-leemos
    // para que la UI refleje los thumbnails recién populados.
    try {
      const updated = await invoke<number>("library_backfill_covers");
      if (updated > 0) await get().loadTracks();
    } catch (e) {
      // Silent fail — el backfill es polish, no crítico.
      console.warn("backfill covers failed:", e);
    }
  },

  backfillMetadata: async () => {
    // Aplica cleanup heurístico (audio/cleanup.rs) a tracks ya descargados —
    // útil cuando bumpeamos las heurísticas o cuando hay tracks viejos
    // descargados antes de que existiera el cleanup. Sólo afecta tracks
    // con `source_type = 'downloaded'`.
    set({ cleaning: true, error: null });
    try {
      const updated = await invoke<number>("library_backfill_metadata");
      if (updated > 0) await get().loadTracks();
      set({ lastCleanedCount: updated });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ cleaning: false });
    }
  },

  scanDirectory: async () => {
    set({ error: null });
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      set({ scanning: true });
      const report = await invoke<ScanReport>("library_scan_directory", {
        path: picked,
      });
      set({ lastReport: report });
      await get().loadTracks();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ scanning: false });
    }
  },

  importPaths: async (paths) => {
    if (paths.length === 0) return;
    set({ error: null, scanning: true });
    try {
      const report = await invoke<ScanReport>("library_import_paths", { paths });
      set({ lastReport: report });
      await get().loadTracks();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ scanning: false });
    }
  },
}));
