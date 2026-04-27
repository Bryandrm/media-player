import { create } from "zustand";
import { persist } from "zustand/middleware";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getAudioElement } from "../audio/element";
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
      },

      togglePlay: async () => {
        if (get().currentTrackId === null) return;
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
        getAudioElement().volume = clamped;
        set({ volume: clamped });
      },

      toggleMute: () => {
        const next = !get().muted;
        getAudioElement().muted = next;
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
