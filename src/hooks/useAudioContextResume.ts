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

    // En `devicechange` (cambio de output device, ej: reconectar audífonos),
    // el resume/reconnect liviano NO alcanza cuando el destination quedó clavado
    // → si está sonando, reconstruimos el pipeline (ctx nuevo = bindea al device
    // actual). Debounced: los device changes vienen en ráfaga. Sólo si
    // `isPlaying` (decisión del usuario: no molestar si está pausado).
    let rebuildTimer: number | undefined;
    const onDeviceChange = () => {
      const playing = usePlayerStore.getState().isPlaying;
      console.warn(
        `[audio-debug] devicechange: isPlaying=${playing}, ctxState=${getAudioContextState()}`,
      );
      if (!playing) return;
      if (rebuildTimer) window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => {
        if (usePlayerStore.getState().isPlaying) {
          usePlayerStore.getState().rebuildAudio();
        }
      }, 400);
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    // Prime: sin una llamada previa a enumerateDevices, WKWebView no dispara
    // `devicechange` para cambios de output device (BT). Fire-and-forget.
    navigator.mediaDevices?.enumerateDevices?.().catch(() => {});

    return () => {
      if (rebuildTimer) window.clearTimeout(rebuildTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
    };
  }, []);
}
