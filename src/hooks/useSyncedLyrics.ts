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
//
// Karaoke fill (`progressRef`): para el efecto 0→100% dentro de la línea
// activa, actualizamos una CSS var `--progress` directamente en el DOM
// cada frame, **sin pasar por React state**. setState 60fps causa
// re-renders del subtree entero — el approach via DOM evita ese costo.

// Si no hay siguiente línea (estamos en la última), interpolamos sobre
// este fallback de 5s. Da una animación de salida natural en vez de
// quedarse plantado en 0% para siempre.
const TRAILING_LINE_DURATION_MS = 5000;

export function useSyncedLyrics(
  lines: LrcLine[],
  lrcOffsetMs: number,
  userOffsetMs: number,
  speedRatio: number = 1.0,
  progressRef?: React.RefObject<HTMLElement | null>,
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

    // Computa el timestamp efectivo de una línea en tiempo de AUDIO (no LRC).
    // Misma fórmula que `effectiveTimestampMs` del parser, en línea para no
    // pagar la importación + clamp en el rAF loop.
    //
    // Cuando la línea viene de un forced alignment (tiene wordTimestampsMs),
    // usamos el timestamp de la PRIMERA PALABRA en lugar del de la línea.
    // Razón: el line.timestampMs viene de LRCLIB y puede tener drift acumulado
    // o estar mal alineado al audio del usuario; whisperx nos dio cuándo
    // EMPIEZA REALMENTE la primera palabra. Sin este cambio, el cursor avanza
    // a la línea (mostrándola como activa) antes de que se cante, y el desfase
    // se acumula a lo largo del track.
    const effectiveOf = (line: LrcLine): number => {
      const rawTs = line.wordTimestampsMs?.[0] ?? line.timestampMs;
      return (rawTs + lrcOffsetMs) * speedRatio + userOffsetMs;
    };

    /** Actualiza `--word-progress` (0..1) en cada `.karaoke-word` de la
     *  línea activa. Dos modos según si el LRC es A2 (aligned) o estándar:
     *   - A2: usa `wordTimestampsMs[i]` como bound start de cada palabra.
     *     End = bound start de la próxima palabra, o de la próxima línea
     *     para la última.
     *   - Linear: distribuye la línea uniforme por chars (aproximación —
     *     misma matemática que la versión vieja con --char-offset). */
    const updateProgress = (cursor: number, currentMs: number) => {
      if (!progressRef?.current || cursor < 0) return;
      const wordSpans = progressRef.current.querySelectorAll<HTMLElement>(
        ".karaoke-word",
      );
      if (wordSpans.length === 0) return;

      const line = lines[cursor];
      const nextLineEff =
        cursor + 1 < lines.length
          ? effectiveOf(lines[cursor + 1])
          : effectiveOf(line) + TRAILING_LINE_DURATION_MS;

      const wordTs = line.wordTimestampsMs;
      if (wordTs && wordTs.length > 0) {
        // === Modo A2 / forced-aligned ===
        for (let i = 0; i < wordSpans.length; i++) {
          // Bound start: timestamp de la palabra. Si por alguna razón hay
          // menos timestamps que spans (defensivo), usar el último o
          // line.timestampMs como fallback.
          const rawStart = wordTs[i] ?? wordTs[wordTs.length - 1] ?? line.timestampMs;
          const startEff = (rawStart + lrcOffsetMs) * speedRatio + userOffsetMs;
          // Bound end:
          //   - próxima palabra, si la hay → fill termina cuando arranca la
          //     siguiente palabra (transición continua entre palabras).
          //   - última palabra Y tenemos lastWordEndMs (forced alignment con
          //     trailing end marker) → usamos el end real, palabra para de
          //     llenarse cuando el cantante termina de cantarla. Sin esto,
          //     la última palabra seguía rellenándose durante el silencio
          //     hasta la próxima línea (visible al usuario como "letra
          //     avanza durante espacio vacío").
          //   - última palabra SIN lastWordEndMs (LRC manual / pre-fix) →
          //     fallback a nextLineEff. Compatible con A2 viejo.
          let endEff: number;
          if (i + 1 < wordTs.length) {
            endEff = (wordTs[i + 1] + lrcOffsetMs) * speedRatio + userOffsetMs;
          } else if (line.lastWordEndMs !== undefined) {
            endEff =
              (line.lastWordEndMs + lrcOffsetMs) * speedRatio + userOffsetMs;
          } else {
            endEff = nextLineEff;
          }
          const span = Math.max(1, endEff - startEff);
          const wp = Math.max(0, Math.min(1, (currentMs - startEff) / span));
          wordSpans[i].style.setProperty("--word-progress", String(wp));
        }
      } else {
        // === Modo linear (LRC estándar) ===
        // Reproducimos la misma matemática que el CSS calc anterior:
        //   fillChars = clamp(0, lineProgress*total - charOffset, wordLength)
        //   wp = fillChars / wordLength
        // Iteramos las palabras en orden y mantenemos un charOffset
        // acumulado para mapear span ↔ posición en la línea.
        const text = line.text;
        const total = Math.max(1, text.length);
        const lineMs = effectiveOf(line);
        const lineSpan = Math.max(1, nextLineEff - lineMs);
        const lineProgress = Math.max(
          0,
          Math.min(1, (currentMs - lineMs) / lineSpan),
        );

        // Tokenize manteniendo separadores para tracking del offset.
        const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
        let charOffset = 0;
        let wordIdx = 0;
        for (const token of tokens) {
          if (/^\s+$/.test(token)) {
            charOffset += token.length;
            continue;
          }
          if (wordIdx >= wordSpans.length) break;
          const wordLen = Math.max(1, token.length);
          const fillChars = Math.max(
            0,
            Math.min(wordLen, lineProgress * total - charOffset),
          );
          const wp = fillChars / wordLen;
          wordSpans[wordIdx].style.setProperty("--word-progress", String(wp));
          wordIdx++;
          charOffset += token.length;
        }
      }
    };

    const update = () => {
      const currentMs = audio.currentTime * 1000;
      let cursor = cursorRef.current;
      // Avanzar mientras la próxima línea ya pasó (en tiempo de audio).
      while (cursor + 1 < lines.length && effectiveOf(lines[cursor + 1]) <= currentMs) {
        cursor++;
      }
      // Retroceder si el usuario hizo seek hacia atrás.
      while (cursor >= 0 && effectiveOf(lines[cursor]) > currentMs) {
        cursor--;
      }
      if (cursor !== cursorRef.current) {
        cursorRef.current = cursor;
        setActiveIndex(cursor);
      }
      updateProgress(cursor, currentMs);
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
  }, [lines, lrcOffsetMs, userOffsetMs, speedRatio, progressRef]);

  return activeIndex;
}
