import { create } from "zustand";
import { persist } from "zustand/middleware";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getAudioElement } from "../audio/element";
import { getAudioContext, getMasterGain } from "../audio/context";
import { useLibraryStore } from "./libraryStore";
import type { Track } from "../types";

type PlayerState = {
  currentTrackId: number | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;

  playTrack: (track: Track) => void;
  togglePlay: () => Promise<void>;
  seek: (time: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
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

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      currentTrackId: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 1,
      muted: false,

      playTrack: (track) => {
        const audio = getAudioElement();
        audio.src = convertFileSrc(track.filePath);
        set({ currentTrackId: track.id, currentTime: 0, duration: 0 });
        audio.play().catch(ignoreAbort);
        // Bootstrap el grafo Web Audio desde el primer play() — en este punto
        // tenemos un user gesture activo, así el AudioContext nace en 'running'.
        // Si el visualizer se abre después, ya hay source conectado a destination.
        const ctx = getAudioContext();
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        // El gain nace en 1.0 por default. Si el store tiene un volumen
        // persistido distinto, hay que aplicarlo ahora.
        const { volume, muted } = get();
        getMasterGain().gain.value = muted ? 0 : volume;
      },

      togglePlay: async () => {
        // Si no hay nada cargado pero la library tiene tracks, arrancamos
        // con el primero — atajo cómodo: PLAY desde cero sin tener que
        // clickear una fila.
        if (get().currentTrackId === null) {
          const first = useLibraryStore.getState().tracks[0];
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

      next: () => {
        const tracks = useLibraryStore.getState().tracks;
        const id = get().currentTrackId;
        if (id === null) return;
        const idx = tracks.findIndex((t) => t.id === id);
        const target = idx >= 0 ? tracks[idx + 1] : undefined;
        if (target) get().playTrack(target);
      },

      prev: () => {
        const tracks = useLibraryStore.getState().tracks;
        const id = get().currentTrackId;
        if (id === null) return;
        const idx = tracks.findIndex((t) => t.id === id);
        const target = idx > 0 ? tracks[idx - 1] : undefined;
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
    }),
    {
      name: "brutalist-player:player",
      partialize: (state) => ({ volume: state.volume, muted: state.muted }),
    },
  ),
);
