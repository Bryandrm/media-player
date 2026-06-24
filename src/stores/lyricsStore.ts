import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Lyrics, MismatchResult } from "../types";

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

  /** True mientras corre `karaoke_auto_align` para algún track. Es global
   *  (no per-track) porque el flujo es one-at-a-time desde la UI — el
   *  botón AUTO-ALIGN está disabled mientras `aligning`. */
  aligning: boolean;
  /** True mientras corre mismatch detection. */
  detecting: boolean;

  /** `force` saltea el cache (incluido not_found) y re-corre el cascade —
   *  lo usa el botón REFETCH (ej: track marcado not_found antes de NetEase). */
  fetch: (trackId: number, force?: boolean) => Promise<void>;
  setOffset: (trackId: number, offsetMs: number) => Promise<void>;
  /** Ajusta el speedRatio (drift correction). Optimistic update igual
   *  que setOffset. */
  setSpeedRatio: (trackId: number, speedRatio: number) => Promise<void>;
  /** Reset de offset + speedRatio a valores neutros. Usado por el botón
   *  RESET. Optimistic update + persiste backend. */
  resetSync: (trackId: number) => Promise<void>;
  /** Corre forced alignment vía whisperx (Tauri command). Tarda ~30s-2min
   *  la primera vez por download del modelo wav2vec2. Al terminar, refetcha
   *  el lyrics del backend para que el A2 nuevo entre al store. */
  alignTrack: (trackId: number) => Promise<void>;
  /** Mismatch detection: transcribe + fonética. Tarda ~30-60s. */
  detectMismatch: (trackId: number) => Promise<void>;
  /** Lyrics Fase 2.c — persiste edición manual del usuario. El backend
   *  sobreescribe `originalSyncedLyrics` con el nuevo synced (así un
   *  RE-ALIGN posterior parte de la versión corregida) y resetea offset,
   *  speedRatio y alignedAt — el texto cambió, los ajustes viejos no
   *  aplican. Devuelve la fila fresca para reemplazar el store sin
   *  round-trip extra. */
  saveManualEdit: (
    trackId: number,
    syncedLyrics: string | null,
    plainLyrics: string | null,
  ) => Promise<void>;
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
  aligning: false,
  detecting: false,

  fetch: async (trackId, force = false) => {
    // Race-guard: si ya estamos fetch-eando para este trackId, no duplicar.
    // Si es un trackId distinto, descartar el previo (set forTrackId acá).
    // `force` salta el guard (re-fetch deliberado tras configurar la key).
    if (
      !force &&
      get().forTrackId === trackId &&
      (get().loading || get().current !== null)
    ) {
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
      const result = await invoke<Lyrics | null>("lyrics_fetch", {
        trackId,
        force,
      });
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

  alignTrack: async (trackId) => {
    if (get().aligning) return;
    set({ aligning: true, error: null });
    try {
      const res = await invoke<{ alignmentScore: number }>("karaoke_auto_align", { trackId });
      console.log(`[karaoke] alignment score: ${res.alignmentScore.toFixed(3)}`);
      // synced_lyrics fue reescrito en backend con A2. Forzamos refetch
      // limpiando el state cacheado para que el siguiente fetch lea fresh
      // de la DB (el cache-check del comando lyrics_fetch devuelve la
      // fila con el A2 nuevo).
      const current = get().current;
      if (current && current.trackId === trackId) {
        set({ current: null, forTrackId: null });
      }
      await get().fetch(trackId);
    } catch (e) {
      const msg = String(e);
      console.warn("karaoke_auto_align failed:", msg);
      set({ error: msg });
    } finally {
      set({ aligning: false });
    }
  },

  detectMismatch: async (trackId) => {
    if (get().detecting) return;
    set({ detecting: true, error: null });
    try {
      const result = await invoke<MismatchResult>("karaoke_detect_mismatch", { trackId });
      console.log(`[mismatch] overall score: ${result.overallScore.toFixed(3)}, ${result.lines.length} lines`);
      // El backend persistió mismatch_score + checked_at + mismatch_lines.
      // Reflejarlo optimista en `current` (única fuente) para que el cartel
      // QUALITY + el flag inline de líneas malas se actualicen sin refetch.
      // Al reabrir/cambiar de track, se leen los valores reales de la DB.
      const current = get().current;
      const patched =
        current && current.trackId === trackId
          ? {
              ...current,
              mismatchScore: result.overallScore,
              mismatchCheckedAt: new Date().toISOString(),
              mismatchLines: JSON.stringify(result.lines),
            }
          : current;
      set({ current: patched, detecting: false });
    } catch (e) {
      const msg = String(e);
      console.warn("karaoke_detect_mismatch failed:", msg);
      set({ error: msg, detecting: false });
    }
  },

  saveManualEdit: async (trackId, syncedLyrics, plainLyrics) => {
    try {
      const result = await invoke<Lyrics>("lyrics_save_manual_edit", {
        trackId,
        syncedLyrics,
        plainLyrics,
      });
      // Race-check: si el usuario cambió de track durante el save, no
      // pisamos lo que ya tiene el store.
      if (get().forTrackId !== null && get().forTrackId !== trackId) return;
      set({
        current: result,
        forTrackId: trackId,
        notFound: false,
        loading: false,
        error: null,
      });
    } catch (e) {
      const msg = String(e);
      console.warn("lyrics_save_manual_edit failed:", msg);
      set({ error: msg });
      throw new Error(msg);
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
