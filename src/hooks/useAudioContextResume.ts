import { useEffect } from "react";
import { usePlayerStore } from "../stores/playerStore";
import {
  ensureAudioContextRunning,
  getAudioContextState,
} from "../audio/context";

/** Auto-sana el bug "dejo el player abierto, vuelvo, la canción avanza pero no
 *  suena". macOS/WKWebView suspende el AudioContext tras sleep / idle largo /
 *  cambio de output device (ej: desconectar/reconectar Bluetooth); el `<audio>`
 *  sigue su timeline pero el grafo de Web Audio está dormido → silencio.
 *
 *  Triggers de recuperación: al volver foco/visibilidad a la ventana, y al
 *  cambiar el set de output devices (`devicechange` — cubre el reconectar
 *  audífonos sin tocar el foco). Si el player se cree sonando (`isPlaying`),
 *  reanuda el contexto.
 *
 *  Lee `isPlaying` con `getState()` (no suscripción) — corre on-event. Se monta
 *  una vez en App. */
export function useAudioContextResume() {
  useEffect(() => {
    const resumeIfPlaying = (source: string) => {
      const playing = usePlayerStore.getState().isPlaying;
      // [audio-debug] temporal — diagnosticar suspend vs running-pero-mudo.
      console.warn(
        `[audio-debug] ${source}: isPlaying=${playing}, ctxState=${getAudioContextState()}`,
      );
      if (playing) ensureAudioContextRunning();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resumeIfPlaying("visibility");
    };
    const onFocus = () => resumeIfPlaying("focus");
    const onDeviceChange = () => resumeIfPlaying("devicechange");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
    };
  }, []);
}
