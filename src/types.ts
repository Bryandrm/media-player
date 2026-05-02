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
};

export type ScanReport = {
  scanned: number;
  inserted: number;
  skipped: number;
  errors: number;
};

export type DependencyStatus = {
  ytDlp: boolean;
  ffmpeg: boolean;
};

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "postprocessing"
  | "completed"
  | "failed"
  | "skipped";

export type Download = {
  id: number;
  url: string;
  status: DownloadStatus;
  /** 0..1; -1 = indeterminado (yt-dlp aún no reporta total). */
  progress: number;
  title: string | null;
  error: string | null;
  trackId: number | null;
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
  status: LyricsStatus;
};
