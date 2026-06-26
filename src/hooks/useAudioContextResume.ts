import { useEffect } from "react";
import { usePlayerStore } from "../stores/playerStore";
import {
  getAudioContextState,
  recoverAudioRouting,
} from "../audio/context";

/** Auto-sana el bug "dejo el player abierto, vuelvo, la canción avanza pero no
 *  suena". macOS/WKWebView, ante sleep / idle largo / cambio de output device
 *  (ej: desconectar/reconectar Bluetooth), deja el audio mudo de dos formas:
 *   - el AudioContext queda `suspended`/`interrupted` (lo cubre el resume), o
 *   - el ctx sigue `running` pero el `MediaElementSource` apunta al device
 *     viejo → avanza pero no suena. Para este caso hay que **reconectar las
 *     fuentes**, no solo resumir → por eso usamos `recoverAudioRouting`.
 *
 *  Triggers: foco/visibilidad de la ventana + `devicechange` (cambio del set de
 *  output devices — cubre reconectar audífonos sin tocar el foco). Si el player
 *  se cree sonando (`isPlaying`), recupera el ruteo.
 *
 *  **Priming de `devicechange`:** WKWebView NO emite `devicechange` hasta que se
 *  llamó al menos una vez a `enumerateDevices()`. Sin esto el evento nunca
 *  dispara y el reconectar automático ante cambio de BT no se entera.
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
    const onDeviceChange = () => recoverIfPlaying("devicechange");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    // Prime: sin una llamada previa a enumerateDevices, WKWebView no dispara
    // `devicechange` para cambios de output device (BT). Fire-and-forget.
    navigator.mediaDevices?.enumerateDevices?.().catch(() => {});

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
