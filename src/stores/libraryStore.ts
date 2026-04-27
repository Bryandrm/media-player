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
