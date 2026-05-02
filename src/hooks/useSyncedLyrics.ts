import { useEffect, useRef, useState } from "react";
import { getAudioElement } from "../audio/element";
import type { LrcLine } from "../lib/lrcParser";

// Loop de sincronización: dado un array de líneas con timestamps, devuelve
// el índice de la línea actualmente activa (la última cuyo timestamp ≤ tiempo
// actual). Recalcula via requestAnimationFrame mientras el audio reproduce.
//
// Por qué rAF y no `timeupdate`: el evento timeupdate del HTMLMediaElement
// dispara cada ~250ms — para letras sincronizadas se siente lento, la línea
// cambia con lag perceptible. rAF corre a ~60Hz (16ms) y es muchísimo más
// responsivo. El costo de CPU es despreciable: la operación interna es sólo
// comparación de números.
//
// Cursor incremental (en vez de binary search por frame): O(1) amortizado
// durante reproducción lineal. En seek el cursor se resetea y avanza desde
// el principio, lo cual es O(n) por una vez pero imperceptible para n<1000.

export function useSyncedLyrics(
  lines: LrcLine[],
  effectiveOffsetMs: number,
): number {
  const [activeIndex, setActiveIndex] = useState(-1);
  const cursorRef = useRef(-1);

  useEffect(() => {
    const audio = getAudioElement();
    if (lines.length === 0) {
      setActiveIndex(-1);
      cursorRef.current = -1;
      return;
    }

    let rafId = 0;
    let running = false;

    const update = () => {
      const currentMs = audio.currentTime * 1000 - effectiveOffsetMs;
      let cursor = cursorRef.current;
      // Avanzar mientras la próxima línea ya pasó.
      while (cursor + 1 < lines.length && lines[cursor + 1].timestampMs <= currentMs) {
        cursor++;
      }
      // Retroceder si el usuario hizo seek hacia atrás.
      while (cursor >= 0 && lines[cursor].timestampMs > currentMs) {
        cursor--;
      }
      if (cursor !== cursorRef.current) {
        cursorRef.current = cursor;
        setActiveIndex(cursor);
      }
    };

    const tick = () => {
      update();
      if (running) rafId = requestAnimationFrame(tick);
    };

    const onPlay = () => {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(tick);
    };
    const onPause = () => {
      running = false;
      cancelAnimationFrame(rafId);
      // Update una vez más para reflejar la línea actual al pausar (sin
      // esto, el highlight queda desactualizado vs audio.currentTime).
      update();
    };
    const onSeeked = () => {
      // Reset del cursor: el while-loop puede tener que ir muy hacia atrás
      // tras un seek; arrancar desde -1 cuesta lo mismo en O(n).
      cursorRef.current = -1;
      update();
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("seeked", onSeeked);

    // Estado inicial: si el audio está reproduciendo cuando montamos
    // (típico al abrir el tab LYRICS mid-canción), arrancar el rAF loop.
    if (!audio.paused) onPlay();
    update();

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("seeked", onSeeked);
    };
  }, [lines, effectiveOffsetMs]);

  return activeIndex;
}
