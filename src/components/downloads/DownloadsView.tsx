import { DependencyBanner } from "./DependencyBanner";
import { DownloadForm } from "./DownloadForm";
import { DownloadQueue } from "./DownloadQueue";

export function DownloadsView() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <DependencyBanner />
      <DownloadForm />
      <div className="flex-1 overflow-auto">
        <DownloadQueue />
      </div>
    </div>
  );
}
