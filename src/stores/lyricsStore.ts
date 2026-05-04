import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Lyrics } from "../types";

// Estado de letras del track actual. Se popula vía `useLyricsSync` cuando
// el usuario navega a un track o al tab LYRICS. Nada se persiste — la
// fuente de verdad es la DB del backend (cache via comando lyrics_fetch).

type LyricsState = {
  /** Lyrics del track actual. null mientras se está fetch-eando o si
   *  todavía no se intentó (tab LYRICS no se abrió). */
  current: Lyrics | null;
  /** trackId del cual `current` corresponde — sirve para invalidar cuando
   *  el usuario cambia de track antes de que el fetch resuelva. */
  forTrackId: number | null;
  loading: boolean;
  /** Status especial: "no encontradas" (LRCLIB devolvió 404 o no había
   *  artist/title). Distinto de `current === null`: el null sin notFound
   *  significa "no fetcheado aún", el notFound significa "fetcheamos pero
   *  nada". */
  notFound: boolean;
  error: string | null;

  fetch: (trackId: number) => Promise<void>;
  setOffset: (trackId: number, offsetMs: number) => Promise<void>;
  /** Ajusta el speedRatio (drift correction). Optimistic update igual
   *  que setOffset. */
  setSpeedRatio: (trackId: number, speedRatio: number) => Promise<void>;
  /** Reset de offset + speedRatio a valores neutros. Usado por el botón
   *  RESET. Optimistic update + persiste backend. */
  resetSync: (trackId: number) => Promise<void>;
  /** Reset al cambiar de track o cerrar el panel — evita mostrar las
   *  letras del track viejo durante un cambio. */
  clear: () => void;
};

export const useLyricsStore = create<LyricsState>((set, get) => ({
  current: null,
  forTrackId: null,
  loading: false,
  notFound: false,
  error: null,

  fetch: async (trackId) => {
    // Race-guard: si ya estamos fetch-eando para este trackId, no duplicar.
    // Si es un trackId distinto, descartar el previo (set forTrackId acá).
    if (get().forTrackId === trackId && (get().loading || get().current !== null)) {
      return;
    }
    set({
      loading: true,
      forTrackId: trackId,
      current: null,
      notFound: false,
      error: null,
    });
    try {
      const result = await invoke<Lyrics | null>("lyrics_fetch", { trackId });
      // Race-check al volver: si el usuario cambió de track durante el
      // await, descartamos este resultado.
      if (get().forTrackId !== trackId) return;
      if (result === null) {
        set({ current: null, notFound: true, loading: false });
      } else {
        set({ current: result, notFound: false, loading: false });
      }
    } catch (e) {
      if (get().forTrackId !== trackId) return;
      set({ error: String(e), loading: false });
    }
  },

  setOffset: async (trackId, offsetMs) => {
    // Optimistic update: actualizamos current.offsetMs inmediato así la UI
    // (rAF loop) responde sin esperar al round-trip a la DB.
    const current = get().current;
    if (current && current.trackId === trackId) {
      set({ current: { ...current, offsetMs } });
    }
    try {
      await invoke("lyrics_set_offset", { trackId, offsetMs });
    } catch (e) {
      // Si falla la persistencia, dejamos el optimistic update pero
      // logueamos. La próxima vez que se abra el track, leerá el offset
      // viejo de DB.
      console.warn("lyrics_set_offset failed:", e);
    }
  },

  setSpeedRatio: async (trackId, speedRatio) => {
    // Clamp en frontend para coincidir con el clamp backend (DB también
    // hace clamp pero esto evita un round-trip con valor que vamos a
    // corregir igual).
    const clamped = Math.min(2.0, Math.max(0.5, speedRatio));
    const current = get().current;
    if (current && current.trackId === trackId) {
      set({ current: { ...current, speedRatio: clamped } });
    }
    try {
      await invoke("lyrics_set_speed_ratio", { trackId, speedRatio: clamped });
    } catch (e) {
      console.warn("lyrics_set_speed_ratio failed:", e);
    }
  },

  resetSync: async (trackId) => {
    const current = get().current;
    if (current && current.trackId === trackId) {
      set({ current: { ...current, offsetMs: 0, speedRatio: 1.0 } });
    }
    try {
      await invoke("lyrics_reset_sync", { trackId });
    } catch (e) {
      console.warn("lyrics_reset_sync failed:", e);
    }
  },

  clear: () => set({
    current: null,
    forTrackId: null,
    loading: false,
    notFound: false,
    error: null,
  }),
}));
