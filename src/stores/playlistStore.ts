import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { Playlist, Track } from "../types";

// Estado de playlists del usuario. La fuente de verdad es la DB del backend;
// cacheamos `playlists` y `tracksOfSelected` en memoria.
//
// `selectedId` decide qué tracks renderea la LibraryTable:
//   - null            → todos los tracks de la library (libraryStore.tracks)
//   - id de playlist  → tracksOfSelected (los de esa playlist)
//
// `selectedId` se persiste para que sobreviva al reload — útil si el usuario
// estaba dentro de una playlist específica cuando cerró la app.

type PlaylistState = {
  playlists: Playlist[];
  selectedId: number | null;
  /** Tracks de la playlist seleccionada. Refresca cuando cambia selectedId
   *  o cuando se hace add/remove. */
  tracksOfSelected: Track[];
  loadingTracks: boolean;
  error: string | null;

  load: () => Promise<void>;
  create: (name: string) => Promise<Playlist | null>;
  remove: (id: number) => Promise<void>;
  rename: (id: number, name: string) => Promise<void>;
  select: (id: number | null) => Promise<void>;
  addTrack: (playlistId: number, trackId: number) => Promise<void>;
  removeTrack: (playlistId: number, trackId: number) => Promise<void>;
  /** Reordena los tracks de una playlist. `trackIds` es la lista completa en
   *  el nuevo orden (la arma el drag & drop de LibraryTable). */
  reorder: (playlistId: number, trackIds: number[]) => Promise<void>;
  /** Fuerza refetch de los tracks de la playlist seleccionada. Util cuando
   *  agregamos/quitamos un track y queremos que la tabla se actualice. */
  reloadSelectedTracks: () => Promise<void>;
};

export const usePlaylistStore = create<PlaylistState>()(
  persist(
    (set, get) => ({
      playlists: [],
      selectedId: null,
      tracksOfSelected: [],
      loadingTracks: false,
      error: null,

      load: async () => {
        try {
          const list = await invoke<Playlist[]>("playlist_list");
          set({ playlists: list });
          // Si la selección persistida ya no existe (playlist borrada en
          // otra sesión), volver a null.
          const sel = get().selectedId;
          if (sel !== null && !list.some((p) => p.id === sel)) {
            set({ selectedId: null, tracksOfSelected: [] });
          } else if (sel !== null) {
            await get().reloadSelectedTracks();
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      create: async (name) => {
        const trimmed = name.trim();
        if (trimmed === "") return null;
        try {
          const created = await invoke<Playlist>("playlist_create", {
            name: trimmed,
          });
          set({ playlists: [...get().playlists, created].sort(byName) });
          return created;
        } catch (e) {
          set({ error: String(e) });
          return null;
        }
      },

      remove: async (id) => {
        try {
          await invoke("playlist_delete", { playlistId: id });
          const next = get().playlists.filter((p) => p.id !== id);
          set({ playlists: next });
          if (get().selectedId === id) {
            set({ selectedId: null, tracksOfSelected: [] });
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      rename: async (id, name) => {
        const trimmed = name.trim();
        if (trimmed === "") return;
        try {
          await invoke("playlist_rename", { playlistId: id, name: trimmed });
          set({
            playlists: get()
              .playlists.map((p) => (p.id === id ? { ...p, name: trimmed } : p))
              .sort(byName),
          });
        } catch (e) {
          set({ error: String(e) });
        }
      },

      select: async (id) => {
        set({ selectedId: id });
        if (id === null) {
          set({ tracksOfSelected: [] });
          return;
        }
        await get().reloadSelectedTracks();
      },

      addTrack: async (playlistId, trackId) => {
        try {
          await invoke("playlist_add_track", { playlistId, trackId });
          // Bumpear track_count optimista — el backend ya commiteó.
          set({
            playlists: get().playlists.map((p) =>
              p.id === playlistId ? { ...p, trackCount: p.trackCount + 1 } : p,
            ),
          });
          if (get().selectedId === playlistId) {
            await get().reloadSelectedTracks();
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      removeTrack: async (playlistId, trackId) => {
        try {
          await invoke("playlist_remove_track", { playlistId, trackId });
          set({
            playlists: get().playlists.map((p) =>
              p.id === playlistId
                ? { ...p, trackCount: Math.max(0, p.trackCount - 1) }
                : p,
            ),
          });
          if (get().selectedId === playlistId) {
            await get().reloadSelectedTracks();
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      reorder: async (playlistId, trackIds) => {
        // Optimista: reordenamos el cache local ya (drag se siente instantáneo)
        // y persistimos en background. Si el backend falla, revertimos al orden
        // real con un refetch.
        const byId = new Map(get().tracksOfSelected.map((t) => [t.id, t]));
        const reordered = trackIds
          .map((id) => byId.get(id))
          .filter((t): t is Track => t !== undefined);
        set({ tracksOfSelected: reordered });
        try {
          await invoke("playlist_reorder", { playlistId, trackIds });
        } catch (e) {
          set({ error: String(e) });
          await get().reloadSelectedTracks();
        }
      },

      reloadSelectedTracks: async () => {
        const id = get().selectedId;
        if (id === null) {
          set({ tracksOfSelected: [] });
          return;
        }
        set({ loadingTracks: true });
        try {
          const tracks = await invoke<Track[]>("playlist_get_tracks", {
            playlistId: id,
          });
          set({ tracksOfSelected: tracks });
        } catch (e) {
          set({ error: String(e) });
        } finally {
          set({ loadingTracks: false });
        }
      },
    }),
    {
      name: "brutalist-player:playlists",
      // Sólo persistimos la selección — la lista en sí se refetcha al boot.
      partialize: (state) => ({ selectedId: state.selectedId }),
    },
  ),
);

function byName(a: Playlist, b: Playlist): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}
