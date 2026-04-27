import { useEffect } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";

const VOLUME_STEP = 0.05;
const SEEK_STEP_S = 5;

function toggleCanvasFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  const canvas = document.querySelector("canvas");
  if (canvas) canvas.requestFullscreen().catch(() => {});
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const s = usePlayerStore.getState();
      const hasTrack = s.currentTrackId !== null;

      switch (e.key) {
        case " ":
          // Space dispara togglePlay siempre — si no hay track cargado, la
          // store action arranca con el primero de la library.
          e.preventDefault();
          s.togglePlay();
          break;
        case "ArrowLeft":
          if (!hasTrack) return;
          e.preventDefault();
          s.seek(Math.max(0, s.currentTime - SEEK_STEP_S));
          break;
        case "ArrowRight":
          if (!hasTrack) return;
          e.preventDefault();
          s.seek(Math.min(s.duration, s.currentTime + SEEK_STEP_S));
          break;
        case "ArrowUp":
          e.preventDefault();
          s.setVolume(s.volume + VOLUME_STEP);
          break;
        case "ArrowDown":
          e.preventDefault();
          s.setVolume(s.volume - VOLUME_STEP);
          break;
        case "n":
        case "N":
          s.next();
          break;
        case "p":
        case "P":
          s.prev();
          break;
        case "m":
        case "M":
          s.toggleMute();
          break;
        case "v":
        case "V": {
          const ui = useUiStore.getState();
          ui.setView(ui.view === "visualizer" ? "library" : "visualizer");
          break;
        }
        case "f":
        case "F":
          if (useUiStore.getState().view === "visualizer") {
            e.preventDefault();
            toggleCanvasFullscreen();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
