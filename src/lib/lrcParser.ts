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
    const text = lastClose >= 0 ? line.slice(lastClose + 1).trim() : "";

    for (const ts of timestamps) {
      lines.push({ timestampMs: ts, text });
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

/** Aplica el offset del LRC + el ajustado por el usuario + el speedRatio
 *  al timestamp de la línea. Se usa en el momento de consumir (rAF loop,
 *  click-to-seek) — los timestamps originales se preservan en `LrcLine`.
 *
 *  Fórmula:
 *    `effective = (timestamp + lrcOffset) * speedRatio + userOffset`
 *
 *  Por qué speedRatio se aplica DESPUÉS de sumar `lrcOffset` pero ANTES
 *  de sumar `userOffset`: el lrcOffset es un ajuste constante del archivo
 *  LRC (parte de los timestamps originales), así que sumarlo antes del
 *  multiplicador mantiene la semántica del archivo. El userOffset es un
 *  shift externo aplicado al timeline final (ej: padding de YouTube) y
 *  debe ser absoluto, no escalado por la corrección de tempo.
 *
 *  Ejemplo: si el LRC tiene `[offset:-500]` y la canción del usuario
 *  necesita speedRatio=1.02 + userOffset=+8000ms:
 *    line @ 60_000ms → (60_000 + -500) * 1.02 + 8_000 = 68_690ms */
export function effectiveTimestampMs(
  line: LrcLine,
  lrcOffsetMs: number,
  userOffsetMs: number,
  speedRatio: number = 1.0,
): number {
  const scaled = (line.timestampMs + lrcOffsetMs) * speedRatio;
  return Math.max(0, scaled + userOffsetMs);
}
