import { useEffect } from "react";
import { useLyricsStore } from "../stores/lyricsStore";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";

// Dispara el fetch de letras lazy: sólo cuando el panel de letras está
// efectivamente visible (vista visualizer + paneMode='lyrics'). Si el
// usuario nunca abre el panel, no gastamos requests a LRCLIB. La cache en DB
// hace que reabrirlo después sea instantáneo.
export function useLyricsSync() {
  const trackId = usePlayerStore((s) => s.currentTrackId);
  const view = useUiStore((s) => s.view);
  const paneMode = useUiStore((s) => s.playerPaneMode);

  useEffect(() => {
    const lyricsVisible = view === "visualizer" && paneMode === "lyrics";
    if (!lyricsVisible) return;
    if (trackId === null) {
      useLyricsStore.getState().clear();
      return;
    }
    useLyricsStore.getState().fetch(trackId);
  }, [trackId, view, paneMode]);
}
