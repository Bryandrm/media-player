import { useState } from "react";
import { useDownloadStore } from "../../stores/downloadStore";
import { Button } from "../ui/Button";

export function DownloadForm() {
  const submitting = useDownloadStore((s) => s.submitting);
  const startDownload = useDownloadStore((s) => s.startDownload);
  const deps = useDownloadStore((s) => s.deps);
  const disabled =
    submitting || !deps?.ytDlp || !deps?.ffmpeg;

  const [url, setUrl] = useState("");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    startDownload(url);
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
      <Button type="submit" disabled={disabled || !url.trim()}>
        {submitting ? "..." : "GO"}
      </Button>
    </form>
  );
}
