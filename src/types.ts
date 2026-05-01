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
