/** Status derivado de la tabla `lyrics` para mostrar el indicador en la
 *  library:
 *    - 'synced':       hay synced_lyrics → mejor experiencia
 *    - 'plain':        sólo plain_lyrics → útil pero sin highlight
 *    - 'instrumental': LRCLIB confirmó track sin letras
 *    - 'not_found':    buscamos y nadie devolvió letras
 *    - null:           todavía no fetcheamos para este track */
export type TrackLyricsStatus =
  | "synced"
  | "plain"
  | "instrumental"
  | "not_found";

/** Estado de la última corrida de identification (AcoustID + Chromaprint):
 *    - 'identified':         match aceptado, mbidRecording poblado
 *    - 'low_confidence':     hubo match pero score < 0.85
 *    - 'no_match':           AcoustID no devolvió results
 *    - 'fingerprint_failed': fpcalc errored (archivo corrupto / formato raro)
 *    - 'api_error':          red / 5xx / quota — retriable
 *    - null:                 nunca se intentó
 *  Ver docs/IDENTIFICATION.md §3.1. */
export type TrackIdentificationStatus =
  | "identified"
  | "low_confidence"
  | "no_match"
  | "fingerprint_failed"
  | "api_error";

export type Track = {
  id: number;
  filePath: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  trackNumber: number | null;
  year: number | null;
  genre: string | null;
  format: string | null;
  /** Ruta absoluta al cover art (cache thumbnail o sibling cover.jpg).
   *  null si no hay imagen disponible. Se sirve vía `convertFileSrc()`. */
  coverArtPath: string | null;
  lyricsStatus: TrackLyricsStatus | null;
  acoustidId: string | null;
  mbidRecording: string | null;
  identificationStatus: TrackIdentificationStatus | null;
  /** Score (0..1) que devolvió AcoustID para el match aceptado. null si
   *  no hubo identify exitoso. La UI lo muestra como tooltip en [ID]. */
  acoustidScore: number | null;
};

/** Resultado del comando identification_identify_track. Los campos
 *  opcionales sólo están poblados cuando status === 'identified'. */
export type IdentificationResult = {
  trackId: number;
  status: TrackIdentificationStatus;
  score: number | null;
  mbid: string | null;
  acoustidId: string | null;
  canonicalTitle: string | null;
  canonicalArtist: string | null;
};

export type ScanReport = {
  scanned: number;
  inserted: number;
  skipped: number;
  errors: number;
};

export type Playlist = {
  id: number;
  name: string;
  description: string | null;
  /** Calculado en SQL via LEFT JOIN (o evaluando las reglas, si es smart). Se
   *  refresca cada vez que load() corre. */
  trackCount: number;
  /** Smart playlist: tracks derivados de `rules`, membresía read-only. */
  isSmart: boolean;
  /** JSON crudo de las reglas (sólo si isSmart). El editor lo parsea a
   *  SmartRules; null en playlists normales. */
  rules: string | null;
};

/** Detalle completo de un track para el panel DETAILS del sidebar. Trae todo
 *  el row de DB + `fileSizeBytes` leído del filesystem. */
export type TrackDetails = {
  id: number;
  filePath: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  trackNumber: number | null;
  year: number | null;
  genre: string | null;
  coverArtPath: string | null;
  /** kbps (lofty ya lo devuelve así). */
  bitrate: number | null;
  /** Hz (44100, 48000, …). */
  sampleRate: number | null;
  format: string | null;
  playCount: number;
  /** ISO 8601 string. `null` si nunca se reprodujo. */
  lastPlayedAt: string | null;
  addedAt: string;
  sourceType: string;
  sourceUrl: string | null;
  mbidRecording: string | null;
  acoustidId: string | null;
  acoustidScore: number | null;
  identificationStatus: string | null;
  /** `null` si el archivo no se pudo leer (movido/borrado desde el último scan). */
  fileSizeBytes: number | null;
  lyricsStatus: TrackLyricsStatus | null;
};

// Smart playlists: motor de reglas. Una condición compara un campo del track
// contra un valor con un operador; las condiciones se combinan con AND ("all")
// u OR ("any"). El backend (db::smart) tiene la whitelist autoritativa de
// campos/operadores válidos — estos tipos la espejan para el editor.

export type SmartField =
  | "title"
  | "artist"
  | "album"
  | "genre"
  | "year"
  | "play_count"
  | "added_within_days"
  | "played_within_days";

export type SmartOp =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  /** Multi-valor: matchea cualquiera de los valores listados. El `value` de
   *  la condición es un JSON array stringificado: `["grunge","electronic"]`. */
  | "in"
  /** Negación de `in`: matchea cuando el campo NO está en la lista. */
  | "not_in";

export type SmartCondition = {
  field: SmartField;
  /** Operador. Para los campos `*_within_days` se ignora (la semántica es fija
   *  "en los últimos N días"); igual mandamos uno por consistencia del shape. */
  op: SmartOp;
  value: string;
};

export type SmartRules = {
  match: "all" | "any";
  conditions: SmartCondition[];
};

export type DependencyStatus = {
  ytDlp: boolean;
  ffmpeg: boolean;
  /** Chromaprint binary (`fpcalc`). Necesario para identificación canónica
   *  vía AcoustID. Sin él la feature IDENTIFY queda disabled — el resto
   *  del player funciona idéntico. */
  fpcalc: boolean;
  /** WhisperX binary (instalado vía pipx). Necesario para forced alignment
   *  de letras (per-word timing real). Sin él la feature AUTO-ALIGN queda
   *  disabled — el karaoke fill cae al modo linear. */
  whisperx: boolean;
  /** espeak-ng shared library. Necesario para CHECK QUALITY con comparación
   *  fonémica (IPA). Sin ella, CHECK QUALITY cae a texto raw (funcional pero
   *  menos preciso en idiomas no-latinos). */
  espeakNg: boolean;
};

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "postprocessing"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type Download = {
  id: number;
  url: string;
  status: DownloadStatus;
  /** 0..1; -1 = indeterminado (yt-dlp aún no reporta total). */
  progress: number;
  title: string | null;
  error: string | null;
  trackId: number | null;
  /** Timestamp ISO de cuándo terminó. null mientras está en curso. El historial
   *  (list_recent) lo trae de la DB; en eventos en vivo el frontend lo estampa. */
  completedAt: string | null;
  /** Si fue descarga de lista, el id de la playlist creada/reusada → permite
   *  expandir la fila para ver sus tracks. null para video suelto. */
  playlistId: number | null;
};

/** Status posibles en la columna `lyrics.status`:
 *  - 'found': hay contenido en synced y/o plain. Incluye el caso
 *    instrumental confirmado por LRCLIB (ambos blobs null pero `source` set).
 *  - 'not_found': buscamos en todos los providers y nadie respondió.
 *  - 'manual_pending': (Fase 2) usuario quiere agregar manualmente. */
export type LyricsStatus = "found" | "not_found" | "manual_pending";

export type Lyrics = {
  trackId: number;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  /** Provider que respondió: "embedded" | "lrclib" | "manual" (Fase 2). */
  source: string | null;
  sourceId: string | null;
  /** 0..1. Calculado en lrclib provider basado en duration delta. La UI
   *  muestra warning si <0.8 — posiblemente es otra versión del track. */
  confidence: number | null;
  /** Offset global aplicado a los timestamps. Lo ajusta el usuario con los
   *  botones [-100][-10][+10][+100][RESET]. */
  offsetMs: number;
  /** Multiplicador de tempo para corregir drift cuando el LRC viene de un
   *  master con tempo distinto al audio del usuario (típico ±0.5%–2%).
   *  Default 1.0. Se prepuebla automático al fetchear (vía duration ratio
   *  audio vs LRCLIB) y el usuario lo ajusta fino con SLOWER/FASTER.
   *  Fórmula: `audioTimeMs = lrcTimeMs * speedRatio + offsetMs`. */
  speedRatio: number;
  /** Timestamp ISO de cuándo corrimos forced alignment para este track
   *  (vía `karaoke_auto_align`). null = nunca alineado, los timestamps
   *  per-palabra del karaoke fill caen al modo linear. Cuando hay valor,
   *  `syncedLyrics` está en formato A2 con `<mm:ss.xx>word` por palabra. */
  alignedAt: string | null;
  /** LRC raw de LRCLIB tal como vino la primera vez. Backup para que
   *  re-aligns no se basen en el A2 generado por un align previo
   *  (que perpetuaría errores). Null para rows creadas antes de la
   *  migración 20260504. El frontend no lo usa hoy — vive en el contrato
   *  por completitud. */
  originalSyncedLyrics: string | null;
  /** Score promedio del forced alignment (0..1). null si nunca se alineó.
   *  Score bajo (<0.5) indica que el LRC probablemente no matchea el audio. */
  alignmentScore: number | null;
  status: LyricsStatus;
};

export type MismatchLine = {
  index: number;
  timestampMs: number;
  lrcText: string;
  transcribedText: string;
  lrcPhonemes: string;
  transcribedPhonemes: string;
  score: number;
};

export type MismatchResult = {
  overallScore: number;
  lines: MismatchLine[];
};
