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

// Umbral de confianza para el hybrid fill (Mejora 1 — calidad karaoke).
// Palabras con `wordScores[i] < SCORE_THRESHOLD` tienen un timestamp de
// whisperx poco confiable (wav2vec2 está entrenado en habla, no en canto):
// usarlo directo hace que el fill SALTE. En cambio, su ventana de fill se
// interpola linealmente (por longitud de caracteres) entre las palabras
// confiables vecinas — el resultado fluye suave. 0.3 es el punto de partida;
// ajustable con uso real.
const SCORE_THRESHOLD = 0.3;

// Interpolación lineal de `time` para una posición `pos` dada una lista de
// anchors (posiciones `xs` ascendentes ↔ tiempos `ys`). Fuera de rango
// clampea al extremo. Usado por el hybrid fill para derivar el start de
// palabras de baja confianza desde sus vecinas confiables.
function interpAnchor(pos: number, xs: number[], ys: number[]): number {
  if (xs.length === 0) return 0;
  if (pos <= xs[0]) return ys[0];
  if (pos >= xs[xs.length - 1]) return ys[ys.length - 1];
  let j = 1;
  while (j < xs.length && xs[j] < pos) j++;
  const x0 = xs[j - 1];
  const x1 = xs[j];
  const y0 = ys[j - 1];
  const y1 = ys[j];
  const t = x1 === x0 ? 0 : (pos - x0) / (x1 - x0);
  return y0 + (y1 - y0) * t;
}

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
        // === Modo A2 / forced-aligned (con hybrid fill por confianza) ===
        const n = wordSpans.length;
        const toEff = (raw: number) =>
          (raw + lrcOffsetMs) * speedRatio + userOffsetMs;

        // Anchor de fin de la línea (en tiempo de audio):
        //   - lastWordEndMs (trailing marker) → end real de la última palabra.
        //   - sino → nextLineEff. Compatible con A2 viejo / manual.
        const lineEndEff =
          line.lastWordEndMs !== undefined
            ? toEff(line.lastWordEndMs)
            : nextLineEff;

        // Start "crudo" de cada palabra según whisperx + posición acumulada en
        // caracteres (para la interpolación de las palabras de baja confianza).
        // La longitud la tomamos del span renderizado (su textContent es la
        // palabra exacta que se muestra). +1 por el espacio entre palabras.
        const rawStart: number[] = new Array(n);
        const charStart: number[] = new Array(n);
        let acc = 0;
        for (let i = 0; i < n; i++) {
          const raw = wordTs[i] ?? wordTs[wordTs.length - 1] ?? line.timestampMs;
          rawStart[i] = toEff(raw);
          charStart[i] = acc;
          acc += (wordSpans[i].textContent?.length ?? 1) + 1;
        }
        const totalChars = acc;

        // Una palabra es "confiable" si no hay scores (A2 viejo → todo
        // confiable) o su score >= umbral. La palabra 0 se trata SIEMPRE como
        // anchor de inicio: su timestamp es el line marker que usa el cursor,
        // así mantenemos consistencia con effectiveOf.
        const trusted = (i: number): boolean => {
          const s = line.wordScores?.[i];
          return s === undefined || !Number.isFinite(s) || s >= SCORE_THRESHOLD;
        };

        // Anchors confiables: (posición en chars ↔ tiempo). Inicio = palabra 0,
        // fin = lineEndEff. Las palabras confiables intermedias suman su anchor.
        const anchorsPos: number[] = [0];
        const anchorsTime: number[] = [rawStart[0]];
        for (let i = 1; i < n; i++) {
          if (trusted(i)) {
            anchorsPos.push(charStart[i]);
            anchorsTime.push(rawStart[i]);
          }
        }
        anchorsPos.push(totalChars);
        anchorsTime.push(lineEndEff);
        // Forzar monotonía no-decreciente de los tiempos (un anchor confiable
        // con timestamp ligeramente fuera de orden no debe invertir el eje).
        for (let k = 1; k < anchorsTime.length; k++) {
          if (anchorsTime[k] < anchorsTime[k - 1]) {
            anchorsTime[k] = anchorsTime[k - 1];
          }
        }

        // Start efectivo: confiable → timestamp real; baja confianza →
        // interpolado entre anchors por su posición en caracteres.
        const effStart: number[] = new Array(n);
        for (let i = 0; i < n; i++) {
          effStart[i] =
            i === 0 || trusted(i)
              ? rawStart[i]
              : interpAnchor(charStart[i], anchorsPos, anchorsTime);
        }

        // Fill: end de cada palabra = start de la próxima (o fin de línea).
        for (let i = 0; i < n; i++) {
          const endEff = i + 1 < n ? effStart[i + 1] : lineEndEff;
          const span = Math.max(1, endEff - effStart[i]);
          const wp = Math.max(0, Math.min(1, (currentMs - effStart[i]) / span));
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
