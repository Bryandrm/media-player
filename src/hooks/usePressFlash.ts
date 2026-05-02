import { useCallback, useEffect, useRef, useState } from "react";

// Duración del flash blanco después de un click. CSS `:active` puro no
// alcanza con tap-to-click de trackpad de macOS (el state dura ~5ms y el
// usuario no llega a verlo). Acá lo mantenemos N ms via JS.
const PRESS_FLASH_MS = 150;

/** Pressed feedback que sobrevive a clicks ultra-rápidos (tap-to-click).
 *  Devuelve `pressed: boolean` y `trigger()` para llamar en `onPointerDown`. */
export function usePressFlash() {
  const [pressed, setPressed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const trigger = useCallback(() => {
    // Si ya hay un timer corriendo (re-click rápido), reseteamos para que
    // el flash se vea continuo y no se corte a la mitad.
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setPressed(true);
    timerRef.current = window.setTimeout(() => {
      setPressed(false);
      timerRef.current = null;
    }, PRESS_FLASH_MS);
  }, []);

  return { pressed, trigger };
}
