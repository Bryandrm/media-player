import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { IdentificationResult } from "../types";

/** El backend serializa `AppError::AcoustIdInvalidKey` como un string que
 *  incluye "API key is invalid". Lo detectamos para reabrir el modal y que el
 *  usuario corrija una key presente-pero-rechazada (vs ausente). */
function isInvalidKeyError(msg: string): boolean {
  return msg.toLowerCase().includes("api key is invalid");
}

// Estado de la feature IDENTIFY (AcoustID + Chromaprint).
// Nada se persiste — la fuente de verdad para la API key es la tabla
// `settings` del backend; los Sets/progress son runtime puro.
//
// Race-guard: el Set evita disparar dos identifies simultáneos sobre el
// mismo track, pero permite paralelizar entre tracks distintos. Eso último
// es defensivo — Fase 1 sólo dispara desde click de usuario, así que no
// hay paralelismo real.

/** Snapshot del progreso del bulk identify. null = no hay corrida activa. */
export type BulkProgress = {
  done: number;
  total: number;
  /** Track ID procesado más recientemente. Útil para resaltar la fila en
   *  la UI mientras corre. */
  currentTrackId: number;
  /** Status del último track procesado — sólo para feedback "qué pasó con
   *  el último". El status real persiste en la DB. */
  lastStatus: string;
};

/** Resumen final del bulk. Lo guardamos para mostrar el summary tipo "after
 *  scan" hasta que el usuario lance otro o navegue. */
export type BulkSummary = {
  total: number;
  identified: number;
  lowConfidence: number;
  noMatch: number;
  fingerprintFailed: number;
  apiError: number;
  cancelled: boolean;
};

type IdentificationState = {
  identifying: Set<number>;
  /** API key de AcoustID. null = no cargada desde backend; "" = cargada y vacía
   *  (usuario nunca la seteó). La distinción es importante para el flow del
   *  click en IDENTIFY: si null, primero hay que cargarla; si "", abrir modal. */
  apiKey: string | null;
  apiKeyLoaded: boolean;
  apiKeyModalOpen: boolean;
  /** Último error global — mostrado vía toast/alert simple. Por track el
   *  status de la DB ya cubre el caso (api_error, fingerprint_failed). */
  lastError: string | null;

  /** Progreso del bulk identify. null cuando no hay corrida activa. Lo
   *  popula `useIdentificationEvents` al recibir `identification-progress`. */
  bulkProgress: BulkProgress | null;
  /** Resumen de la última corrida del bulk. null si nunca corrió o se
   *  acaba de descartar (botón "DISMISS"). */
  bulkSummary: BulkSummary | null;

  loadApiKey: () => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  openApiKeyModal: () => void;
  closeApiKeyModal: () => void;

  /** Corre el cascade de identification. Después de un match aceptado,
   *  el caller debe refrescar la library (`loadTracks`) para que aparezca
   *  el indicador [ID] y la metadata canónica. */
  identify: (trackId: number) => Promise<IdentificationResult | null>;

  /** Lanza el bulk identify sobre todos los tracks elegibles
   *  (status NULL o 'api_error'). Retorna inmediatamente — el progreso
   *  llega vía eventos. */
  identifyAll: () => Promise<void>;
  /** Pide cancelar la corrida activa. El backend termina al fin de la
   *  request actual (no aborta la HTTP en curso — es low-stakes). */
  cancelAll: () => Promise<void>;

  /** Llamado por el listener cuando llega un evento progress. */
  onBulkProgress: (p: BulkProgress) => void;
  /** Llamado por el listener cuando llega un evento completed. */
  onBulkCompleted: (s: BulkSummary) => void;
  /** Limpia el `bulkSummary` (botón DISMISS en la UI). */
  dismissBulkSummary: () => void;
};

export const useIdentificationStore = create<IdentificationState>((set, get) => ({
  identifying: new Set(),
  apiKey: null,
  apiKeyLoaded: false,
  apiKeyModalOpen: false,
  lastError: null,
  bulkProgress: null,
  bulkSummary: null,

  loadApiKey: async () => {
    try {
      const key = await invoke<string | null>("identification_get_api_key");
      set({ apiKey: key ?? "", apiKeyLoaded: true });
    } catch (e) {
      console.warn("identification_get_api_key failed:", e);
      set({ apiKey: "", apiKeyLoaded: true });
    }
  },

  setApiKey: async (key: string) => {
    await invoke("identification_set_api_key", { key });
    set({ apiKey: key, apiKeyLoaded: true });
  },

  openApiKeyModal: () => set({ apiKeyModalOpen: true }),
  closeApiKeyModal: () => set({ apiKeyModalOpen: false }),

  identify: async (trackId: number) => {
    if (get().identifying.has(trackId)) return null;

    // Mutación inmutable del Set para que el selector de Zustand detecte
    // cambio (un Set mutado in-place tiene la misma referencia).
    const next = new Set(get().identifying);
    next.add(trackId);
    set({ identifying: next, lastError: null });

    try {
      const result = await invoke<IdentificationResult>("identification_identify_track", {
        trackId,
      });
      return result;
    } catch (e) {
      const msg = String(e);
      console.warn("identification_identify_track failed:", msg);
      set({ lastError: msg });
      // Key inválida (no sólo ausente): reabrimos el modal para que el usuario
      // la corrija. Sin esto quedaba trabado — el modal sólo abría si la key
      // estaba vacía, no si estaba presente-pero-mal.
      if (isInvalidKeyError(msg)) get().openApiKeyModal();
      return null;
    } finally {
      const after = new Set(get().identifying);
      after.delete(trackId);
      set({ identifying: after });
    }
  },

  identifyAll: async () => {
    if (get().bulkProgress !== null) return; // ya corriendo

    // Validaciones del lado frontend para feedback inmediato sin
    // round-trip al backend.
    const key = get().apiKey;
    if (key === null || key.trim() === "") {
      get().openApiKeyModal();
      return;
    }
    // Placeholder optimista: el botón pasa a STARTING... inmediato.
    // Sin esto, hay una ventana de 1-2s entre el click y el primer
    // progress event donde el botón sigue diciendo IDENTIFY ALL y el
    // user puede re-clickear pensando que no funcionó. total=0 es el
    // marker que la UI usa para distinguir "starting" de "running real".
    set({
      bulkProgress: { done: 0, total: 0, currentTrackId: 0, lastStatus: "starting" },
      bulkSummary: null,
      lastError: null,
    });

    try {
      await invoke("identification_identify_all");
      // Fire-and-forget: el task corre en background y va a emitir
      // progress/completed events. El placeholder se reemplaza cuando
      // llega el primer event.
    } catch (e) {
      const msg = String(e);
      console.warn("identification_identify_all failed:", msg);
      set({ bulkProgress: null, lastError: msg });
    }
  },

  cancelAll: async () => {
    try {
      await invoke("identification_cancel_all");
    } catch (e) {
      console.warn("identification_cancel_all failed:", e);
    }
  },

  onBulkProgress: (p: BulkProgress) => set({ bulkProgress: p }),

  onBulkCompleted: (s: BulkSummary) => set({
    bulkProgress: null,
    bulkSummary: s,
  }),

  dismissBulkSummary: () => set({ bulkSummary: null }),
}));
