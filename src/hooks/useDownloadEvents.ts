import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDownloadStore } from "../stores/downloadStore";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaylistStore } from "../stores/playlistStore";
import type { Download } from "../types";

type ProgressPayload = {
  downloadId: number;
  progress: number;
};

type ItemPayload = {
  downloadId: number;
  current: number;
  total: number;
};

// Conecta los eventos `download-*` del backend al downloadStore. Se monta una
// vez en App. Cuando una descarga termina exitosamente, refresca la library
// para que el track recién insertado aparezca en la tabla.
export function useDownloadEvents() {
  useEffect(() => {
    const unlisten: UnlistenFn[] = [];
    const store = useDownloadStore;
    const library = useLibraryStore;

    Promise.all([
      listen<Download>("download-started", (e) => {
        store.getState().upsertDownload(e.payload);
      }),
      listen<ProgressPayload>("download-progress", (e) => {
        store.getState().updateProgress(e.payload.downloadId, e.payload.progress);
      }),
      listen<ItemPayload>("download-item", (e) => {
        store
          .getState()
          .setItemProgress(e.payload.downloadId, e.payload.current, e.payload.total);
      }),
      listen<Download>("download-postprocessing", (e) => {
        store.getState().upsertDownload(e.payload);
      }),
      listen<Download>("download-completed", (e) => {
        // Estampamos la fecha local si el backend no la mandó (en vivo va null;
        // el historial recargado sí la trae de la DB).
        store.getState().upsertDownload({
          ...e.payload,
          completedAt: e.payload.completedAt ?? new Date().toISOString(),
        });
        library.getState().loadTracks();
        // Una descarga de playlist crea/actualiza una playlist — refrescamos
        // el sidebar para que aparezca sin reload manual.
        usePlaylistStore.getState().load();
      }),
      listen<Download>("download-failed", (e) => {
        store.getState().upsertDownload({
          ...e.payload,
          completedAt: e.payload.completedAt ?? new Date().toISOString(),
        });
      }),
    ]).then((fns) => unlisten.push(...fns));

    return () => {
      unlisten.forEach((fn) => fn());
    };
  }, []);
}
