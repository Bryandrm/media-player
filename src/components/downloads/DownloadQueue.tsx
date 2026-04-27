import { useDownloadStore } from "../../stores/downloadStore";
import type { Download, DownloadStatus } from "../../types";
import { ProgressBar } from "./ProgressBar";

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: "QUEUED",
  downloading: "DOWNLOADING",
  postprocessing: "CONVERTING",
  completed: "DONE",
  failed: "FAILED",
  skipped: "ALREADY IN LIBRARY",
};

function statusColor(s: DownloadStatus): string {
  if (s === "failed") return "text-accent";
  if (s === "completed" || s === "skipped") return "text-muted";
  return "text-fg";
}

function DownloadRow({ d }: { d: Download }) {
  const removeDownload = useDownloadStore((s) => s.removeDownload);
  const showProgress = d.status === "downloading" || d.status === "postprocessing";
  const pct = d.progress < 0 ? "—" : `${Math.round(d.progress * 100)}%`;

  return (
    <div className="border-b border-muted/40 px-6 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-3 text-sm">
        <span className={`text-xs font-bold tracking-wider w-44 ${statusColor(d.status)}`}>
          {STATUS_LABEL[d.status]}
        </span>
        <span className="flex-1 truncate">
          {d.title ?? d.url}
        </span>
        {showProgress && (
          <span className="tabular-nums text-xs text-muted w-12 text-right">{pct}</span>
        )}
        {(d.status === "completed" || d.status === "skipped" || d.status === "failed") && (
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
    </div>
  );
}

export function DownloadQueue() {
  const downloads = useDownloadStore((s) => s.downloads);

  if (downloads.length === 0) {
    return (
      <div className="p-12 text-center text-muted text-sm">
        NO DOWNLOADS YET. PASTE A URL ABOVE.
      </div>
    );
  }

  return (
    <div>
      {downloads.map((d) => (
        <DownloadRow key={d.id} d={d} />
      ))}
    </div>
  );
}
