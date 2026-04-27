import { useDownloadStore } from "../../stores/downloadStore";

export function DependencyBanner() {
  const deps = useDownloadStore((s) => s.deps);

  if (!deps) return null;
  if (deps.ytDlp && deps.ffmpeg) return null;

  const missing: string[] = [];
  if (!deps.ytDlp) missing.push("yt-dlp");
  if (!deps.ffmpeg) missing.push("ffmpeg");

  return (
    <div className="px-6 py-3 border-b-2 border-accent text-accent text-sm">
      <div className="font-bold tracking-wider uppercase">
        MISSING DEPENDENCIES: {missing.join(" + ")}
      </div>
      <div className="text-xs mt-1 font-mono">
        Install on macOS: <span className="text-fg">brew install {missing.join(" ")}</span>
      </div>
    </div>
  );
}
