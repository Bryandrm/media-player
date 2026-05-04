// Parser LRC en TypeScript. El backend guarda el blob raw; parseamos acá al
// renderizar (LYRICS.md §6 — backend no parsea para mantener separation of
// concerns: la representación parseada es para la UI).
//
// Formato LRC:
//   [ti:title]                    ← metadata tags
//   [ar:artist]
//   [offset:+/-N]                 ← offset global en ms (puede ser negativo)
//   [length:mm:ss]
//
//   [mm:ss.xx]Texto de la línea   ← línea con timestamp
//   [mm:ss.xx]                    ← línea vacía (silencio/instrumental)
//   [mm:ss.xx][mm:ss.xx]Coro      ← múltiples timestamps para misma línea
//
// Best-effort: líneas malformadas se ignoran silenciosamente — preferimos
// renderizar 90% de las letras a fallar entero por una mala línea.

export type LrcLine = {
  timestampMs: number;
  text: string;
  /** Cuando el LRC viene en formato Enhanced LRC (A2) con per-word timestamps,
   *  este array tiene un timestamp en ms por cada palabra de `text` (split por
   *  whitespace). `text` ya está limpio sin los markers `<...>`. Length matchea
   *  word count.
   *
   *  Undefined cuando el LRC es estándar (sin markers `<>`) — el karaoke fill
   *  cae al modo linear (interpolación uniforme dentro de la línea).
   *
   *  Sintaxis A2:
   *    `[mm:ss.xx]<mm:ss.xx>word1 <mm:ss.xx>word2 <mm:ss.xx>word3` */
  wordTimestampsMs?: number[];
  /** End timestamp de la ÚLTIMA palabra de la línea, cuando viene de un
   *  forced alignment (whisperx incluye `end` por palabra; lo serializamos
   *  como trailing marker `<endTs>` al final de la línea).
   *
   *  Sin esto, useSyncedLyrics caería a `nextLineMs` como end de la última
   *  palabra y la palabra seguiría rellenándose durante el silencio entre
   *  líneas. Con esto, la palabra se queda en 100% al terminar realmente.
   *
   *  Undefined si el LRC es A2 sin trailing marker (ediciones manuales,
   *  formatos antiguos pre-fix) o si es LRC estándar. */
  lastWordEndMs?: number;
};

export type LrcMetadata = {
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Offset global en ms del propio archivo LRC (tag `[offset:N]`).
   *  Distinto al `offsetMs` que el usuario ajusta en la UI — los dos se
   *  suman al consumir, no al parsear. */
  offsetMs: number;
};

export type ParsedLrc = {
  metadata: LrcMetadata;
  /** Líneas ordenadas por timestamp ascendente. */
  lines: LrcLine[];
};

const TIMESTAMP_RE = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
const META_RE = /^\[(ti|ar|al|offset|length|by):([^\]]*)\]$/i;

export function parseLrc(input: string): ParsedLrc {
  const metadata: LrcMetadata = {
    title: null,
    artist: null,
    album: null,
    offsetMs: 0,
  };
  const lines: LrcLine[] = [];

  for (const raw of input.split(/\r?\n/)) {
    // Strip BOM al inicio + trim. Algunos LRC viejos vienen con ﻿.
    const line = raw.replace(/^﻿/, "").trim();
    if (line === "") continue;

    // Metadata tag (ti/ar/al/offset/length/by). Sólo matchea si la línea
    // ENTERA es un tag — sin esto algunas líneas tipo "[al:foo]bar" no
    // serían letras y se perderían. Si tiene contenido después del tag
    // tratamos como letra.
    const metaMatch = line.match(META_RE);
    if (metaMatch) {
      applyMetadataTag(metadata, metaMatch[1].toLowerCase(), metaMatch[2].trim());
      continue;
    }

    // Una o más timestamps al inicio + texto al final.
    const timestamps = parseTimestamps(line);
    if (timestamps.length === 0) continue;

    // El texto es lo que viene DESPUÉS del último ']'. trim para limpiar
    // espacios líderes después de los timestamps.
    const lastClose = line.lastIndexOf("]");
    const rawText = lastClose >= 0 ? line.slice(lastClose + 1).trim() : "";

    // Detectar A2: si tiene markers `<...>` extraemos per-word timestamps;
    // si no, queda como texto plano y wordTimestampsMs queda undefined.
    const { text, wordTimestampsMs, lastWordEndMs } = parseA2Markers(rawText);

    for (const ts of timestamps) {
      lines.push({ timestampMs: ts, text, wordTimestampsMs, lastWordEndMs });
    }
  }

  // Sort estable por timestamp. LRC con múltiples timestamps por línea (coros
  // repetidos) puede dar lines fuera de orden si los timestamps no están
  // estrictamente ascendentes en el archivo.
  lines.sort((a, b) => a.timestampMs - b.timestampMs);

  return { metadata, lines };
}

function parseTimestamps(line: string): number[] {
  // Regex con flag `g` para múltiples matches. Reset lastIndex por si la
  // misma instancia se reutiliza (importante en module-level RegExp + g).
  TIMESTAMP_RE.lastIndex = 0;
  const out: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = TIMESTAMP_RE.exec(line)) !== null) {
    const mins = parseInt(match[1], 10);
    const secs = parseInt(match[2], 10);
    // Centésimas o milésimas según los dígitos. La mayoría son centésimas
    // (xx, 2 dígitos). Algunos parsers usan 3 dígitos (xxx ms).
    const fracStr = match[3] ?? "0";
    let fracMs: number;
    if (fracStr.length === 3) {
      fracMs = parseInt(fracStr, 10);
    } else {
      // Centésimas → ms × 10. Padd a 2 dígitos.
      const padded = fracStr.padEnd(2, "0").slice(0, 2);
      fracMs = parseInt(padded, 10) * 10;
    }
    if (Number.isFinite(mins) && Number.isFinite(secs) && Number.isFinite(fracMs)) {
      out.push(mins * 60_000 + secs * 1_000 + fracMs);
    }
  }
  return out;
}

function applyMetadataTag(meta: LrcMetadata, key: string, value: string): void {
  switch (key) {
    case "ti":
      meta.title = value || null;
      break;
    case "ar":
      meta.artist = value || null;
      break;
    case "al":
      meta.album = value || null;
      break;
    case "offset": {
      // [offset:N] o [offset:+N] o [offset:-N]. Trim '+' líder.
      const cleaned = value.replace(/^\+/, "");
      const n = parseInt(cleaned, 10);
      if (Number.isFinite(n)) meta.offsetMs = n;
      break;
    }
    // length / by: ignorados — no los necesita la UI.
  }
}

/** Detecta + extrae markers Enhanced LRC (A2) de la parte de texto de una
 *  línea. Sintaxis: `<mm:ss.xx>word1 <mm:ss.xx>word2`. Si no hay markers,
 *  devuelve el texto sin cambios y sin `wordTimestampsMs` (LRC estándar).
 *
 *  Robusto a formatos imperfectos:
 *    - Markers seguidos de whitespace o sin whitespace → ambos OK.
 *    - Markers sin palabra después → ignorados.
 *    - Texto antes del primer marker → si no es vacío, lo ignoramos
 *      (markers A2 se asumen al inicio de cada palabra). */
function parseA2Markers(rawText: string): {
  text: string;
  wordTimestampsMs?: number[];
  lastWordEndMs?: number;
} {
  // Quick path: sin markers, es LRC estándar.
  if (!rawText.includes("<")) {
    return { text: rawText };
  }

  // Split por marker `<...>` capturando el timestamp interior. Resultado:
  //   parts[0]      = texto antes del primer marker (típicamente "")
  //   parts[1]      = primer timestamp (string sin brackets)
  //   parts[2]      = palabra después del primer marker (hasta el próximo)
  //   parts[3], [4] = idem para el segundo
  //   ...
  // Para A2 con trailing end marker (`<00:25>word<00:26>`):
  //   parts[N-1] = último timestamp (end de la última palabra)
  //   parts[N]   = "" (texto vacío después del trailing marker)
  const parts = rawText.split(/<(\d+:\d+(?:[.:]\d+)?)>/);
  if (parts.length < 3) {
    // Tenía un `<` pero no fue marker válido (texto literal con `<`).
    return { text: rawText };
  }

  const wordTimestampsMs: number[] = [];
  const words: string[] = [];
  let lastWordEndMs: number | undefined;

  for (let i = 1; i < parts.length; i += 2) {
    const tsStr = parts[i];
    const wordText = (parts[i + 1] ?? "").trim();
    const ts = parseInnerTimestamp(tsStr);
    if (ts === null) continue;
    if (!wordText) {
      // Trailing marker (timestamp sin palabra después). Convención:
      // representa el END de la última palabra registrada. Sólo guardamos
      // el ÚLTIMO trailing — si hay múltiples por error, el más reciente
      // gana.
      if (wordTimestampsMs.length > 0) {
        lastWordEndMs = ts;
      }
      continue;
    }
    wordTimestampsMs.push(ts);
    words.push(wordText);
  }

  if (wordTimestampsMs.length === 0) {
    // Markers presentes pero ninguno produjo (timestamp, word) válido.
    // Fallback a texto sin markers strippeados como mejor-effort.
    return { text: rawText.replace(/<[^>]*>/g, "").trim() };
  }

  return { text: words.join(" "), wordTimestampsMs, lastWordEndMs };
}

/** Parsea un timestamp interior `mm:ss.xx` (sin brackets) a ms. Análogo
 *  a `parseTimestamps` pero para markers A2 (formato `<mm:ss.xx>` ya
 *  splitteado). */
function parseInnerTimestamp(ts: string): number | null {
  const match = ts.match(/^(\d+):(\d+)(?:[.:](\d+))?$/);
  if (!match) return null;
  const mins = parseInt(match[1], 10);
  const secs = parseInt(match[2], 10);
  const fracStr = match[3] ?? "0";
  let fracMs: number;
  if (fracStr.length === 3) {
    fracMs = parseInt(fracStr, 10);
  } else {
    const padded = fracStr.padEnd(2, "0").slice(0, 2);
    fracMs = parseInt(padded, 10) * 10;
  }
  if (!Number.isFinite(mins) || !Number.isFinite(secs) || !Number.isFinite(fracMs)) {
    return null;
  }
  return mins * 60_000 + secs * 1_000 + fracMs;
}

/** Aplica el offset del LRC + el ajustado por el usuario + el speedRatio
 *  al timestamp de la línea. Se usa en el momento de consumir (rAF loop,
 *  click-to-seek) — los timestamps originales se preservan en `LrcLine`.
 *
 *  Fórmula:
 *    `effective = (rawTs + lrcOffset) * speedRatio + userOffset`
 *
 *  `rawTs` es el timestamp de la PRIMERA PALABRA cuando la línea viene
 *  alineada por whisperx (`wordTimestampsMs[0]`); cae al `line.timestampMs`
 *  del LRC original sólo cuando no hay alineación. Razón: para tracks
 *  con forced alignment, el LRC line marker es aproximado y puede tener
 *  drift; whisperx nos dio cuándo arranca realmente el primer fonema.
 *
 *  Por qué speedRatio se aplica DESPUÉS de sumar `lrcOffset` pero ANTES
 *  de sumar `userOffset`: el lrcOffset es un ajuste constante del archivo
 *  LRC (parte de los timestamps originales), así que sumarlo antes del
 *  multiplicador mantiene la semántica del archivo. El userOffset es un
 *  shift externo aplicado al timeline final (ej: padding de YouTube) y
 *  debe ser absoluto, no escalado por la corrección de tempo. */
export function effectiveTimestampMs(
  line: LrcLine,
  lrcOffsetMs: number,
  userOffsetMs: number,
  speedRatio: number = 1.0,
): number {
  const rawTs = line.wordTimestampsMs?.[0] ?? line.timestampMs;
  const scaled = (rawTs + lrcOffsetMs) * speedRatio;
  return Math.max(0, scaled + userOffsetMs);
}
