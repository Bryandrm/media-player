import { useEffect } from "react";
import { usePlayerStore } from "../stores/playerStore";
import {
  getAudioContextState,
  recoverAudioRouting,
} from "../audio/context";

/** Auto-sana los casos LIVIANOS de "la canción avanza pero no suena": el
 *  AudioContext quedó `suspended`/`interrupted` tras sleep / idle largo (lo
 *  resuelve `recoverAudioRouting` = resume + reconnect de fuentes). El caso
 *  PESADO (destination clavado en el output viejo tras cambiar de device) NO se
 *  arregla acá — es una limitación de proceso de WKWebView, ver Gotcha #32 / B2;
 *  el recovery es el botón RESET AUDIO (restart).
 *
 *  Triggers: foco/visibilidad de la ventana (cuando volvés a la app). Si el
 *  player se cree sonando (`isPlaying`), recupera el ruteo.
 *
 *  **No** escuchamos `devicechange` ni primeamos con `enumerateDevices()`:
 *  enumerar devices toca las APIs de cámara en macOS (warning de Continuity
 *  Camera + acceso innecesario para un reproductor de música), y de todos modos
 *  el caso pesado no se resuelve en proceso. Foco/visibilidad cubren el regreso
 *  a la app.
 *
 *  Lee `isPlaying` con `getState()` (no suscripción) — corre on-event. Se monta
 *  una vez en App. */
export function useAudioContextResume() {
  useEffect(() => {
    const recoverIfPlaying = (source: string) => {
      const playing = usePlayerStore.getState().isPlaying;
      // [audio-debug] temporal — diagnosticar suspend vs running-pero-mudo.
      console.warn(
        `[audio-debug] ${source}: isPlaying=${playing}, ctxState=${getAudioContextState()}`,
      );
      if (playing) recoverAudioRouting();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") recoverIfPlaying("visibility");
    };
    const onFocus = () => recoverIfPlaying("focus");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
