import { create } from "zustand";
import { persist } from "zustand/middleware";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getAudioElement } from "../audio/element";
import { getAudioContext, getMasterGain } from "../audio/context";
import { filterTracks } from "../lib/search";
import { useLibraryStore } from "./libraryStore";
import type { Track } from "../types";

type PlayerState = {
  currentTrackId: number | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  /** Stack de trackIds reproducidos, más recientes al final. Se usa para que
   *  `prev` en modo shuffle te lleve al track previo real, no a otro random.
   *  No se persiste — un reload reinicia el stack. */
  playHistory: number[];

  playTrack: (track: Track) => void;
  togglePlay: () => Promise<void>;
  seek: (time: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  next: () => void;
  prev: () => void;

  // Internal sync — wired by useAudioPlayer. Prefijo `_` para indicar
  // que no son acciones de UI: las llama el adaptador de eventos.
  _onTimeUpdate: (t: number) => void;
  _onDuration: (d: number) => void;
  _onPlay: () => void;
  _onPause: () => void;
  _onEnded: () => void;
};

const ignoreAbort = (e: unknown) => {
  if ((e as DOMException)?.name === "AbortError") return;
  console.error("audio play failed:", e);
};

const HISTORY_CAP = 64;

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {
      // Carga + reproduce un track sin tocar el playHistory. La usan tanto
      // playTrack (que primero pushea al historial) como prev (que pop-ea).
      const loadAndPlay = (track: Track) => {
        const audio = getAudioElement();
        audio.src = convertFileSrc(track.filePath);
        set({ currentTrackId: track.id, currentTime: 0, duration: 0 });
        audio.play().catch(ignoreAbort);
        // Bootstrap del grafo Web Audio desde el primer play() — en este
        // punto tenemos user gesture activo, AudioContext nace en 'running'.
        const ctx = getAudioContext();
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const { volume, muted } = get();
        getMasterGain().gain.value = muted ? 0 : volume;
      };

      // Devuelve un track random distinto al actual. Usado por next() en
      // modo shuffle. La pool es la queue actual (respeta filtro de search).
      const pickRandomTrack = (
        queue: Track[],
        currentId: number | null,
      ): Track | undefined => {
        if (queue.length === 0) return undefined;
        if (queue.length === 1) return queue[0];
        let candidate: Track;
        do {
          candidate = queue[Math.floor(Math.random() * queue.length)];
        } while (candidate.id === currentId);
        return candidate;
      };

      // La "queue" efectiva es siempre el subset filtrado por el search
      // actual. Buscar "rock" → next/prev navegan sólo entre los matches.
      // Si no hay query, queue === todos los tracks.
      const getQueue = (): Track[] => {
        const { tracks, searchQuery } = useLibraryStore.getState();
        return filterTracks(tracks, searchQuery);
      };

      return {
        currentTrackId: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        muted: false,
        shuffle: false,
        playHistory: [],

        playTrack: (track) => {
          // Antes de cambiar, archivamos el track actual al historial. Si
          // estás clickeando el mismo track de nuevo, no duplicamos.
          const currentId = get().currentTrackId;
          if (currentId !== null && currentId !== track.id) {
            const next = [...get().playHistory, currentId];
            set({
              playHistory:
                next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next,
            });
          }
          loadAndPlay(track);
        },

        togglePlay: async () => {
          if (get().currentTrackId === null) {
            // Si hay search activo, arranca con el primer match — más
            // consistente con lo que el usuario está viendo.
            const first = getQueue()[0];
            if (first) get().playTrack(first);
            return;
          }
          const audio = getAudioElement();
          if (audio.paused) {
            try {
              await audio.play();
            } catch (e) {
              ignoreAbort(e);
            }
          } else {
            audio.pause();
          }
        },

        seek: (time) => {
          if (!isFinite(time)) return;
          getAudioElement().currentTime = time;
        },

        setVolume: (v) => {
          const clamped = Math.max(0, Math.min(1, v));
          if (!get().muted) getMasterGain().gain.value = clamped;
          set({ volume: clamped });
        },

        toggleMute: () => {
          const next = !get().muted;
          getMasterGain().gain.value = next ? 0 : get().volume;
          set({ muted: next });
        },

        toggleShuffle: () => set({ shuffle: !get().shuffle }),

        next: () => {
          const id = get().currentTrackId;
          if (id === null) return;
          const queue = getQueue();

          if (get().shuffle) {
            const target = pickRandomTrack(queue, id);
            if (target) get().playTrack(target);
            return;
          }

          const idx = queue.findIndex((t) => t.id === id);
          const target = idx >= 0 ? queue[idx + 1] : undefined;
          if (target) get().playTrack(target);
        },

        prev: () => {
          const id = get().currentTrackId;
          if (id === null) return;

          // En shuffle, prev despega del historial (el último track previo
          // realmente reproducido). El historial NO se filtra — si bajaste
          // un track antes de buscar, prev te lleva ahí aunque el filtro
          // ahora lo excluya.
          if (get().shuffle) {
            const history = get().playHistory;
            const lastId = history[history.length - 1];
            if (lastId !== undefined) {
              const tracks = useLibraryStore.getState().tracks;
              const target = tracks.find((t) => t.id === lastId);
              if (target) {
                set({ playHistory: history.slice(0, -1) });
                loadAndPlay(target);
                return;
              }
            }
          }

          const queue = getQueue();
          const idx = queue.findIndex((t) => t.id === id);
          const target = idx > 0 ? queue[idx - 1] : undefined;
          if (target) get().playTrack(target);
        },

        _onTimeUpdate: (t) => set({ currentTime: t }),
        _onDuration: (d) => set({ duration: d }),
        _onPlay: () => set({ isPlaying: true }),
        _onPause: () => set({ isPlaying: false }),
        _onEnded: () => {
          set({ isPlaying: false });
          get().next();
        },
      };
    },
    {
      name: "brutalist-player:player",
      partialize: (state) => ({
        volume: state.volume,
        muted: state.muted,
        shuffle: state.shuffle,
      }),
    },
  ),
);
