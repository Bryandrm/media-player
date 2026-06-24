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
  /** End timestamp explícito POR palabra (paralelo a `wordTimestampsMs`).
   *  `null` = sin end explícito → el consumidor usa el start de la próxima
   *  palabra (o el fin de línea). Lo escribe el editor de timing (T6) como
   *  `<startTs>word<endTs>`; permite **gaps** (una palabra termina antes de
   *  que arranque la siguiente). El A2 de whisperx no trae ends por palabra
   *  (sólo el trailing de la última) → casi todo `null` salvo la última. */
  wordEndTimestampsMs?: (number | null)[];
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
  /** Confianza del alignment por palabra (0..1), paralelo a `wordTimestampsMs`.
   *  Viene del A2 extendido `<mm:ss.xx|score>word` que escribe whisperx.
   *
   *  Lo usa el hybrid fill (useSyncedLyrics): palabras con score bajo tienen
   *  un timestamp poco confiable, así que su ventana de fill se interpola
   *  linealmente entre las palabras confiables vecinas en vez de saltar.
   *
   *  Undefined cuando el A2 no trae scores (formatos pre-fix, ediciones
   *  manuales) o el LRC es estándar — en ese caso todo se trata como
   *  confiable (comportamiento previo). Cuando algunas palabras traen score
   *  y otras no (raro), las que faltan se rellenan con 1.0 (confiable). */
  wordScores?: number[];
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
    const { text, wordTimestampsMs, wordEndTimestampsMs, lastWordEndMs, wordScores } =
      parseA2Markers(rawText);

    for (const ts of timestamps) {
      lines.push({
        timestampMs: ts,
        text,
        wordTimestampsMs,
        wordEndTimestampsMs,
        lastWordEndMs,
        wordScores,
      });
    }
  }

  // Sort estable por timestamp. LRC con múltiples timestamps por línea (coros
  // repetidos) puede dar lines fuera de orden si los timestamps no están
  // estrictamente ascendentes en el archivo.
  lines.sort((a, b) => a.timestampMs - b.timestampMs);

  return { metadata, lines };
}

/** Reemplaza el texto de UNA línea del LRC crudo preservando los timestamps y
 *  el resto del archivo intacto. Lo usa la edición inline por línea (T1 inc.2).
 *
 *  Matchea la línea física cuyo texto (A2-stripped) coincide con `oldText`;
 *  si hay varias con el mismo texto (coros repetidos), prefiere la que además
 *  incluya `targetMs` entre sus timestamps. Reemplaza el contenido después del
 *  último `]` por `newText` — descarta los markers A2 de ESA línea, lo cual es
 *  correcto: editar el texto invalida el alignment igual (el caller resetea
 *  `aligned_at`). Si no encuentra match, devuelve el LRC sin cambios.
 *
 *  Operar sobre `original_synced_lyrics` (LRC raw, sin A2) da un resultado
 *  limpio; el match por texto funciona igual contra el synced A2 porque el
 *  texto de la línea es idéntico (A2 sólo agrega timing por palabra). */
export function replaceLrcLineText(
  rawLrc: string,
  targetMs: number,
  oldText: string,
  newText: string,
): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(oldText);
  const physical = rawLrc.split(/\r?\n/);

  let fallbackIdx = -1; // primer match por texto, sin importar timestamp
  let exactIdx = -1; // match por texto Y timestamp
  for (let i = 0; i < physical.length; i++) {
    const trimmed = physical[i].replace(/^﻿/, "").trim();
    if (trimmed === "" || META_RE.test(trimmed)) continue;
    const timestamps = parseTimestamps(trimmed);
    if (timestamps.length === 0) continue;
    const lastClose = trimmed.lastIndexOf("]");
    const rawText = lastClose >= 0 ? trimmed.slice(lastClose + 1).trim() : "";
    const { text } = parseA2Markers(rawText);
    if (norm(text) !== target) continue;
    if (fallbackIdx === -1) fallbackIdx = i;
    if (timestamps.includes(targetMs)) {
      exactIdx = i;
      break;
    }
  }

  const idx = exactIdx !== -1 ? exactIdx : fallbackIdx;
  if (idx === -1) return rawLrc;

  const trimmed = physical[idx].replace(/^﻿/, "").trim();
  const lastClose = trimmed.lastIndexOf("]");
  const prefix = trimmed.slice(0, lastClose + 1); // tags de timestamp tal cual
  physical[idx] = `${prefix}${newText}`;
  return physical.join("\n");
}

/** Palabra con start+end (ms) para serializar A2 / editar timing. */
export type A2Word = { text: string; startMs: number; endMs: number };

/** Formatea ms a `mm:ss.xx` (centésimas) para los markers del LRC. */
function fmtLrcTs(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const cs = Math.floor((t % 1000) / 10);
  const totalSec = Math.floor(t / 1000);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(mm)}:${p2(ss)}.${p2(cs)}`;
}

/** Serializa una línea A2 con start+end EXPLÍCITOS por palabra (T6 editor):
 *  `[lineTs]<startTs>word<endTs>...`. El parser reconstruye el texto con
 *  `words.join(" ")`, así que no hace falta separar con espacios. */
export function serializeA2Line(
  lineTimestampMs: number,
  words: A2Word[],
): string {
  const body = words
    .map((w) => `<${fmtLrcTs(w.startMs)}>${w.text}<${fmtLrcTs(w.endMs)}>`)
    .join("");
  return `[${fmtLrcTs(lineTimestampMs)}]${body}`;
}

/** Índice de la línea física que matchea por texto (y, si puede, timestamp).
 *  -1 si no hay. */
function findLrcLineIdx(
  physical: string[],
  targetMs: number,
  oldText: string,
): number {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(oldText);
  let fallbackIdx = -1;
  for (let i = 0; i < physical.length; i++) {
    const trimmed = physical[i].replace(/^﻿/, "").trim();
    if (trimmed === "" || META_RE.test(trimmed)) continue;
    const timestamps = parseTimestamps(trimmed);
    if (timestamps.length === 0) continue;
    const lastClose = trimmed.lastIndexOf("]");
    const rawText = lastClose >= 0 ? trimmed.slice(lastClose + 1).trim() : "";
    const { text } = parseA2Markers(rawText);
    if (norm(text) !== target) continue;
    if (fallbackIdx === -1) fallbackIdx = i;
    if (timestamps.includes(targetMs)) return i;
  }
  return fallbackIdx;
}

/** Reemplaza la línea física ENTERA (tag de timestamp + markers A2) por
 *  `newLine`. Lo usa el editor de timing para persistir el A2 re-editado de
 *  una línea. Match por texto (+ timestamp). Sin match → LRC sin cambios. */
export function replaceLrcLine(
  rawLrc: string,
  targetMs: number,
  oldText: string,
  newLine: string,
): string {
  const physical = rawLrc.split(/\r?\n/);
  const idx = findLrcLineIdx(physical, targetMs, oldText);
  if (idx === -1) return rawLrc;
  physical[idx] = newLine;
  return physical.join("\n");
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
  wordEndTimestampsMs?: (number | null)[];
  lastWordEndMs?: number;
  wordScores?: number[];
} {
  // Quick path: sin markers, es LRC estándar.
  if (!rawText.includes("<")) {
    return { text: rawText };
  }

  // Split por marker `<ts|score>` capturando el timestamp interior Y el score
  // opcional. Con DOS grupos de captura el split intercala ambos, así que el
  // stride pasa de 2 a 3. Resultado:
  //   parts[0]      = texto antes del primer marker (típicamente "")
  //   parts[1]      = primer timestamp (string sin brackets)
  //   parts[2]      = primer score (string) o undefined si el marker no lo trae
  //   parts[3]      = palabra después del primer marker (hasta el próximo)
  //   parts[4..6]   = idem para el segundo
  //   ...
  // Para A2 con trailing end marker (`<00:25|0.9>word<00:26>`):
  //   parts[N-2] = último timestamp (end de la última palabra)
  //   parts[N-1] = undefined (sin score en el trailing)
  //   parts[N]   = "" (texto vacío después del trailing marker)
  // Backwards compat: A2 viejo sin `|score` deja el grupo de score undefined.
  const parts = rawText.split(/<(\d+:\d+(?:[.:]\d+)?)(?:\|([\d.]+))?>/);
  if (parts.length < 4) {
    // Tenía un `<` pero no fue marker válido (texto literal con `<`).
    return { text: rawText };
  }

  const wordTimestampsMs: number[] = [];
  const wordEndTimestampsMs: (number | null)[] = [];
  const words: string[] = [];
  const wordScores: number[] = [];
  let anyScore = false;
  let lastWordEndMs: number | undefined;

  for (let i = 1; i < parts.length; i += 3) {
    const tsStr = parts[i];
    const scoreStr = parts[i + 1];
    const wordText = (parts[i + 2] ?? "").trim();
    const ts = parseInnerTimestamp(tsStr);
    if (ts === null) continue;
    if (!wordText) {
      // Marker sin palabra después = END explícito de la palabra MÁS RECIENTE.
      // En el A2 de whisperx sólo aparece al final (end de la última palabra);
      // el editor de timing escribe uno por palabra (`<s>w<e>`) → habilita gaps.
      if (wordTimestampsMs.length > 0) {
        wordEndTimestampsMs[wordTimestampsMs.length - 1] = ts;
        lastWordEndMs = ts;
      }
      continue;
    }
    wordTimestampsMs.push(ts);
    wordEndTimestampsMs.push(null); // sin end explícito por ahora; un marker
    // vacío posterior lo setea.
    words.push(wordText);
    // Score: si el marker lo trae lo parseamos; si no, 1.0 (confiable) para
    // mantener `wordScores` paralelo a `wordTimestampsMs`.
    const score = scoreStr !== undefined ? parseFloat(scoreStr) : NaN;
    if (Number.isFinite(score)) {
      anyScore = true;
      wordScores.push(Math.max(0, Math.min(1, score)));
    } else {
      wordScores.push(1.0);
    }
  }

  if (wordTimestampsMs.length === 0) {
    // Markers presentes pero ninguno produjo (timestamp, word) válido.
    // Fallback a texto sin markers strippeados como mejor-effort.
    return { text: rawText.replace(/<[^>]*>/g, "").trim() };
  }

  return {
    text: words.join(" "),
    wordTimestampsMs,
    wordEndTimestampsMs,
    lastWordEndMs,
    // Sólo exponemos wordScores si AL MENOS una palabra trajo score real.
    // Sin esto, un A2 viejo (sin scores) tendría un array de puros 1.0 que
    // no aporta nada — undefined es la señal de "tratá todo como confiable".
    wordScores: anyScore ? wordScores : undefined,
  };
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
