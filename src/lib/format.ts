export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const formatDuration = (ms: number) => formatTime(ms / 1000);

/** Fecha ISO (UTC) → string local corto para el historial de descargas.
 *  Ej: "18 Jun 2026, 14:30". Devuelve "" si no hay fecha o no parsea. */
export function formatDownloadDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Bytes → string humano: "12.5 MB", "847 KB", "1.2 GB". `null`/`undefined`
 *  → "—". Sin unidad cuando el valor es 0 o negativo. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes <= 0) return "—";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}

/** Fecha ISO → string relativo en inglés/uppercase brutalist:
 *  "JUST NOW", "5 MIN AGO", "2 HOURS AGO", "YESTERDAY", "3 DAYS AGO",
 *  "2 WEEKS AGO", "3 MONTHS AGO", "1 YEAR AGO", o fallback al formato
 *  date corto cuando es muy viejo. `null`/inválido → "—". */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "JUST NOW"; // clock skew defensivo
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "JUST NOW";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} MIN AGO`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "HOUR" : "HOURS"} AGO`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "YESTERDAY";
  if (day < 7) return `${day} DAYS AGO`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk} ${wk === 1 ? "WEEK" : "WEEKS"} AGO`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} ${mo === 1 ? "MONTH" : "MONTHS"} AGO`;
  const yr = Math.floor(day / 365);
  return `${yr} ${yr === 1 ? "YEAR" : "YEARS"} AGO`;
}

/** Sample rate en Hz → string ergonómico: 44100 → "44.1 KHZ". */
export function formatSampleRate(hz: number | null | undefined): string {
  if (hz === null || hz === undefined || hz <= 0) return "—";
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} KHZ`;
}
