import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Track, ScanReport } from "../types";

type LibraryState = {
  tracks: Track[];
  scanning: boolean;
  lastReport: ScanReport | null;
  error: string | null;

  setError: (e: string | null) => void;
  loadTracks: () => Promise<void>;
  backfillCovers: () => Promise<void>;
  scanDirectory: () => Promise<void>;
};

export const useLibraryStore = create<LibraryState>((set) => ({
  tracks: [],
  scanning: false,
  lastReport: null,
  error: null,

  setError: (e) => set({ error: e }),

  loadTracks: async () => {
    try {
      const list = await invoke<Track[]>("library_list_tracks");
      set({ tracks: list });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  backfillCovers: async () => {
    // Best-effort: si falla, no bloqueamos la app. Si actualiza algo, re-leemos
    // para que la UI refleje los thumbnails recién populados.
    try {
      const updated = await invoke<number>("library_backfill_covers");
      if (updated > 0) {
        const list = await invoke<Track[]>("library_list_tracks");
        set({ tracks: list });
      }
    } catch (e) {
      // Silent fail — el backfill es polish, no crítico.
      console.warn("backfill covers failed:", e);
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
      const list = await invoke<Track[]>("library_list_tracks");
      set({ lastReport: report, tracks: list });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ scanning: false });
    }
  },
}));
