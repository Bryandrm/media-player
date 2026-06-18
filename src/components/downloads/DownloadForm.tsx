import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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

// Basename de una ruta cross-platform (Windows usa `\`, el resto `/`).
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function DownloadForm() {
  const submitting = useDownloadStore((s) => s.submitting);
  const startDownload = useDownloadStore((s) => s.startDownload);
  const deps = useDownloadStore((s) => s.deps);
  const cookiesBrowser = useDownloadStore((s) => s.cookiesBrowser);
  const setCookiesBrowser = useDownloadStore((s) => s.setCookiesBrowser);
  const cookiesFile = useDownloadStore((s) => s.cookiesFile);
  const setCookiesFile = useDownloadStore((s) => s.setCookiesFile);
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

  const pickCookiesFile = async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "cookies.txt", extensions: ["txt"] }],
    });
    if (typeof picked === "string") setCookiesFile(picked);
  };

  // Un cookies.txt elegido tiene prioridad sobre el navegador (mismo orden que
  // el backend) → cuando hay archivo, el select de navegador queda inerte.
  const fileActive = cookiesFile !== "";

  return (
    <div className="border-b border-fg">
      <form
        onSubmit={onSubmit}
        className="flex items-center gap-3 px-6 py-3"
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
          disabled={disabled || fileActive}
          title="Use cookies from this browser (needed for private playlists / age-restricted videos)"
          className="bg-bg text-fg border-2 border-fg px-2 py-2 text-xs font-mono uppercase tracking-wider outline-none focus:border-accent disabled:opacity-40"
        >
          {COOKIE_BROWSERS.map((b) => (
            <option key={b || "none"} value={b}>
              {b === "" ? "NO COOKIES" : `COOKIES: ${b.toUpperCase()}`}
            </option>
          ))}
        </select>
        {fileActive ? (
          <div
            className="flex items-center gap-2 border-2 border-fg px-2 py-2"
            title={cookiesFile}
          >
            <span className="text-xs font-mono uppercase tracking-wider max-w-[10rem] truncate">
              {basename(cookiesFile)}
            </span>
            <button
              type="button"
              onClick={() => setCookiesFile("")}
              disabled={disabled}
              title="Clear cookies file"
              className="text-xs font-bold text-muted hover:text-accent"
            >
              ✕
            </button>
          </div>
        ) : (
          <Button
            type="button"
            onClick={pickCookiesFile}
            disabled={disabled}
            title="Use a cookies.txt file (works with the browser open)"
          >
            COOKIES FILE
          </Button>
        )}
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
      <p className="px-6 pb-3 -mt-1 text-[0.7rem] leading-snug text-muted font-mono">
        COOKIES: Firefox funciona con el navegador abierto. Chrome/Brave/Edge
        requieren cerrar el navegador en Windows (lock del archivo de cookies)
        — o usá un cookies.txt exportado, que anda con el navegador abierto y
        tiene prioridad sobre el select.
      </p>
    </div>
  );
}
