import { useEffect } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import { useLyricsStore } from "../stores/lyricsStore";
import { usePlayerStore } from "../stores/playerStore";

// Auto-fetch de letras al cambiar de track. Eager (no gated por visibility):
// poblar el indicador de la library a medida que el usuario reproduce, sin
// que tenga que abrir el panel manualmente para cada track.
//
// Después de cada fetch refrescamos la library: el `lyrics_fetch` actualiza
// la tabla `lyrics` en DB; `library_list_tracks` re-lee con el LEFT JOIN y
// devuelve el `lyricsStatus` actualizado para cada track. La UI rerendea con
// el indicador correcto.
//
// Costo: una request a LRCLIB por track nuevo (cache hit es no-op de red).
// Para uso personal con docenas/cientos de tracks → trivial.
export function useLyricsSync() {
  const trackId = usePlayerStore((s) => s.currentTrackId);

  useEffect(() => {
    if (trackId === null) {
      useLyricsStore.getState().clear();
      return;
    }
    void fetchAndRefreshLibrary(trackId);
  }, [trackId]);
}

async function fetchAndRefreshLibrary(trackId: number) {
  await useLyricsStore.getState().fetch(trackId);
  // Refresh aunque el fetch no haya cambiado nada en DB (cache hit) — el
  // costo es una query SQL barata. Optimizar con dirty-flag si llega a ser
  // problema, pero con libraries de cientos de tracks es despreciable.
  await useLibraryStore.getState().loadTracks();
}
