import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlaylistStore } from "./playlistStore";
import type { Track, ScanReport } from "../types";

/** Progreso live del MB backfill — mirror del evento `mb-backfill-progress`. */
export type MbBackfillProgress = {
  done: number;
  total: number;
  currentTrackId: number;
  lastStatus: "updated" | "no_data" | "error";
};

/** Sumario final del MB backfill — mirror del evento `mb-backfill-completed`. */
export type MbBackfillCompleted = {
  total: number;
  updated: number;
  noData: number;
  coversUpdated: number;
  error: number;
  cancelled: boolean;
};

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

  /** Progreso live del MB backfill (genre + year + album + cover). null = no corriendo. */
  mbBackfillProgress: MbBackfillProgress | null;
  /** Summary del último MB backfill — para mostrar en toolbar hasta dismiss. */
  mbBackfillSummary: MbBackfillCompleted | null;

  setError: (e: string | null) => void;
  setSearchQuery: (q: string) => void;
  loadTracks: () => Promise<void>;
  backfillCovers: () => Promise<void>;
  backfillMetadata: () => Promise<void>;
  scanDirectory: () => Promise<void>;
  /** Importa paths (archivos o carpetas) arrastrados desde el explorador.
   *  Reusa el mismo insert idempotente que el scan. */
  importPaths: (paths: string[]) => Promise<void>;
  /** Dispara el backfill MB (genre + year + album + cover desde Cover Art
   *  Archive). Fire-and-forget en backend; progress llega via eventos
   *  `mb-backfill-progress` y `mb-backfill-completed`. */
  backfillMbMetadata: () => Promise<void>;
  /** Setea cancel flag. El task termina entre tracks. */
  cancelMbBackfill: () => Promise<void>;
  /** Inicializa el listener de eventos mb-backfill-*. Llamar UNA vez al boot. */
  initMbBackfillEvents: () => Promise<UnlistenFn>;
  /** Dismiss el summary persistente del último backfill. */
  dismissMbBackfillSummary: () => void;
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

  mbBackfillProgress: null,
  mbBackfillSummary: null,

  backfillMbMetadata: async () => {
    if (get().mbBackfillProgress !== null) return;
    set({
      error: null,
      mbBackfillSummary: null,
      // Placeholder "starting" — total=0 lo distingue del progreso real.
      mbBackfillProgress: {
        done: 0,
        total: 0,
        currentTrackId: 0,
        lastStatus: "updated",
      },
    });
    try {
      await invoke("library_backfill_mb_metadata");
    } catch (e) {
      set({
        error: String(e),
        mbBackfillProgress: null,
      });
    }
  },

  cancelMbBackfill: async () => {
    try {
      await invoke("library_cancel_mb_backfill");
    } catch (e) {
      console.warn("cancel_mb_backfill failed:", e);
    }
  },

  initMbBackfillEvents: async () => {
    const unlistenProgress = await listen<MbBackfillProgress>(
      "mb-backfill-progress",
      (event) => {
        set({ mbBackfillProgress: event.payload });
      },
    );
    const unlistenDone = await listen<MbBackfillCompleted>(
      "mb-backfill-completed",
      async (event) => {
        set({
          mbBackfillProgress: null,
          mbBackfillSummary: event.payload,
        });
        // Refrescar tracks para que metadata/cover updateados aparezcan en UI.
        if (event.payload.updated > 0 || event.payload.coversUpdated > 0) {
          await get().loadTracks();
        }
      },
    );
    return () => {
      unlistenProgress();
      unlistenDone();
    };
  },

  dismissMbBackfillSummary: () => set({ mbBackfillSummary: null }),
}));
