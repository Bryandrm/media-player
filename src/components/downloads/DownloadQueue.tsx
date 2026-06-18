import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadStore } from "../../stores/downloadStore";
import type { Download, DownloadStatus, Track } from "../../types";
import { ProgressBar } from "./ProgressBar";
import { Button } from "../ui/Button";
import { formatDownloadDate } from "../../lib/format";

const TERMINAL: DownloadStatus[] = ["completed", "failed", "skipped", "cancelled"];

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: "QUEUED",
  downloading: "DOWNLOADING",
  postprocessing: "CONVERTING",
  completed: "DONE",
  failed: "FAILED",
  skipped: "ALREADY IN LIBRARY",
  cancelled: "CANCELLED",
};

function statusColor(s: DownloadStatus): string {
  if (s === "failed") return "text-accent";
  if (s === "completed" || s === "skipped" || s === "cancelled") return "text-muted";
  return "text-fg";
}

function DownloadRow({ d }: { d: Download }) {
  const removeDownload = useDownloadStore((s) => s.removeDownload);
  const cancelDownload = useDownloadStore((s) => s.cancelDownload);
  const showProgress = d.status === "downloading" || d.status === "postprocessing";
  const pct = d.progress < 0 ? "—" : `${Math.round(d.progress * 100)}%`;
  const isTerminal = TERMINAL.includes(d.status);
  const date = formatDownloadDate(d.completedAt);
  const isPlaylist = d.playlistId !== null;

  // Expand de descarga de lista: lazy-load de los tracks de la playlist
  // asociada (su contenido actual). Sólo se fetchea al expandir por primera vez.
  const [expanded, setExpanded] = useState(false);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);

  const toggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && tracks === null && d.playlistId !== null) {
      setLoadingTracks(true);
      try {
        const t = await invoke<Track[]>("playlist_get_tracks", {
          playlistId: d.playlistId,
        });
        setTracks(t);
      } catch {
        setTracks([]);
      } finally {
        setLoadingTracks(false);
      }
    }
  };

  return (
    <div className="border-b border-muted/40 px-6 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-3 text-sm">
        <span className={`text-xs font-bold tracking-wider w-44 ${statusColor(d.status)}`}>
          {STATUS_LABEL[d.status]}
        </span>
        {isPlaylist && (
          <button
            onClick={toggleExpand}
            className="text-muted hover:text-fg text-xs w-4 shrink-0"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
        <span className="flex-1 truncate">{d.title ?? d.url}</span>
        {date && (
          <span className="text-xs text-muted tabular-nums shrink-0">{date}</span>
        )}
        {showProgress && (
          <span className="tabular-nums text-xs text-muted w-12 text-right">{pct}</span>
        )}
        {showProgress && (
          <button
            onClick={() => cancelDownload(d.id)}
            className="text-muted hover:text-accent text-xs font-bold uppercase px-2"
            aria-label="Cancel download"
          >
            CANCEL
          </button>
        )}
        {isTerminal && (
          <button
            onClick={() => removeDownload(d.id)}
            className="text-muted hover:text-accent text-xs font-bold uppercase px-2"
            aria-label="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
      {showProgress && <ProgressBar value={d.progress} />}
      {d.error && (
        <div className="text-xs text-accent font-mono break-all">{d.error}</div>
      )}
      {expanded && isPlaylist && (
        <div className="pl-8 flex flex-col gap-1 text-xs text-muted">
          {loadingTracks ? (
            <span>LOADING…</span>
          ) : tracks && tracks.length > 0 ? (
            tracks.map((t, i) => (
              <span key={t.id} className="truncate">
                {String(i + 1).padStart(2, "0")}. {t.title}
                {t.artist ? ` — ${t.artist}` : ""}
              </span>
            ))
          ) : (
            <span>EMPTY OR PLAYLIST DELETED</span>
          )}
        </div>
      )}
    </div>
  );
}

export function DownloadQueue() {
  const downloads = useDownloadStore((s) => s.downloads);
  const clearHistory = useDownloadStore((s) => s.clearHistory);
  const hasTerminal = downloads.some((d) => TERMINAL.includes(d.status));

  if (downloads.length === 0) {
    return (
      <div className="p-12 text-center text-muted text-sm">
        NO DOWNLOADS YET. PASTE A URL ABOVE.
      </div>
    );
  }

  return (
    <div>
      {hasTerminal && (
        <div className="flex justify-end px-6 py-2 border-b border-muted/40">
          <Button size="sm" onClick={() => clearHistory()}>
            CLEAR HISTORY
          </Button>
        </div>
      )}
      {downloads.map((d) => (
        <DownloadRow key={d.id} d={d} />
      ))}
    </div>
  );
}
