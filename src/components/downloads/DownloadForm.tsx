import { useState } from "react";
import { useDownloadStore } from "../../stores/downloadStore";
import { Button } from "../ui/Button";

// Navegadores soportados por yt-dlp en `--cookies-from-browser`. "" = sin
// cookies (descarga anónima, default).
const COOKIE_BROWSERS = [
  "",
  "chrome",
  "brave",
  "edge",
  "firefox",
  "safari",
  "chromium",
  "opera",
  "vivaldi",
] as const;

export function DownloadForm() {
  const submitting = useDownloadStore((s) => s.submitting);
  const startDownload = useDownloadStore((s) => s.startDownload);
  const deps = useDownloadStore((s) => s.deps);
  const cookiesBrowser = useDownloadStore((s) => s.cookiesBrowser);
  const setCookiesBrowser = useDownloadStore((s) => s.setCookiesBrowser);
  const disabled =
    submitting || !deps?.ytDlp || !deps?.ffmpeg;

  const [url, setUrl] = useState("");
  // OFF (default) = un solo video aunque la URL traiga `list=`. ON = baja la
  // lista completa y la guarda como playlist (además de "all tracks").
  const [fullPlaylist, setFullPlaylist] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    startDownload(url, fullPlaylist);
    setUrl("");
  };

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-center gap-3 px-6 py-3 border-b border-fg"
    >
      <label className="text-xs font-bold tracking-wider uppercase text-muted">
        URL
      </label>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=..."
        className="flex-1 bg-bg text-fg border-2 border-fg px-3 py-2 text-sm font-mono outline-none focus:border-accent"
        disabled={disabled}
        autoFocus
      />
      <select
        value={cookiesBrowser}
        onChange={(e) => setCookiesBrowser(e.target.value)}
        disabled={disabled}
        title="Use cookies from this browser (needed for private playlists / age-restricted videos)"
        className="bg-bg text-fg border-2 border-fg px-2 py-2 text-xs font-mono uppercase tracking-wider outline-none focus:border-accent"
      >
        {COOKIE_BROWSERS.map((b) => (
          <option key={b || "none"} value={b}>
            {b === "" ? "NO COOKIES" : `COOKIES: ${b.toUpperCase()}`}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant={fullPlaylist ? "active" : "default"}
        onClick={() => setFullPlaylist((v) => !v)}
        disabled={disabled}
        title="Download the full playlist and save it as a playlist"
      >
        FULL PLAYLIST
      </Button>
      <Button type="submit" disabled={disabled || !url.trim()}>
        {submitting ? "..." : "GO"}
      </Button>
    </form>
  );
}
