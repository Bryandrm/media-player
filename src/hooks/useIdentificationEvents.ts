import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useIdentificationStore,
  type BulkProgress,
  type BulkSummary,
} from "../stores/identificationStore";
import { useLibraryStore } from "../stores/libraryStore";

// Conecta los eventos `identification-*` del backend al store. Mismo patrón
// que `useDownloadEvents`: se monta una vez en App.
//
// Al completar una corrida, refrescamos la library para que los indicadores
// nuevos (ID column) y metadata canónica aparezcan inmediatos. Hacerlo aquí
// y no dentro del store mantiene el store puro (sin imports cruzados entre
// stores).

export function useIdentificationEvents() {
  useEffect(() => {
    const unlisten: UnlistenFn[] = [];
    const store = useIdentificationStore;
    const library = useLibraryStore;

    Promise.all([
      listen<BulkProgress>("identification-progress", (e) => {
        store.getState().onBulkProgress(e.payload);
      }),
      listen<BulkSummary>("identification-completed", (e) => {
        store.getState().onBulkCompleted(e.payload);
        // Refresca la library para que la columna ID + metadata canónica
        // aparezcan al instante. Una sola query al final, no una por
        // progress event (sería write amplification del re-render).
        library.getState().loadTracks();
      }),
    ]).then((fns) => unlisten.push(...fns));

    return () => {
      unlisten.forEach((fn) => fn());
    };
  }, []);
}
