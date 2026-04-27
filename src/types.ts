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
};

export type ScanReport = {
  scanned: number;
  inserted: number;
  skipped: number;
  errors: number;
};
