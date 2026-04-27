import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useDownloadStore } from "../stores/downloadStore";
import { useLibraryStore } from "../stores/libraryStore";
import type { Download } from "../types";

type ProgressPayload = {
  downloadId: number;
  progress: number;
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
      listen<Download>("download-postprocessing", (e) => {
        store.getState().upsertDownload(e.payload);
      }),
      listen<Download>("download-completed", (e) => {
        store.getState().upsertDownload(e.payload);
        library.getState().loadTracks();
      }),
      listen<Download>("download-failed", (e) => {
        store.getState().upsertDownload(e.payload);
      }),
    ]).then((fns) => unlisten.push(...fns));

    return () => {
      unlisten.forEach((fn) => fn());
    };
  }, []);
}
