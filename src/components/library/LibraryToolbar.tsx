import { useLibraryStore } from "../../stores/libraryStore";
import { Button } from "../ui/Button";

export function LibraryToolbar() {
  const scanning = useLibraryStore((s) => s.scanning);
  const trackCount = useLibraryStore((s) => s.tracks.length);
  const lastReport = useLibraryStore((s) => s.lastReport);
  const scanDirectory = useLibraryStore((s) => s.scanDirectory);

  return (
    <div className="px-6 py-3 border-b border-fg flex items-center gap-4 text-sm">
      <Button onClick={scanDirectory} disabled={scanning}>
        {scanning ? "SCANNING..." : "SCAN DIRECTORY"}
      </Button>
      <span className="text-muted">
        {trackCount} {trackCount === 1 ? "TRACK" : "TRACKS"}
      </span>
      {lastReport && (
        <span className="text-muted ml-auto">
          LAST SCAN: {lastReport.scanned} FOUND · {lastReport.inserted} NEW ·{" "}
          {lastReport.skipped} DUP · {lastReport.errors} ERR
        </span>
      )}
    </div>
  );
}
