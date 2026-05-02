import { useLibraryStore } from "../../stores/libraryStore";
import { Button } from "../ui/Button";

export function LibraryToolbar() {
  const scanning = useLibraryStore((s) => s.scanning);
  const trackCount = useLibraryStore((s) => s.tracks.length);
  const lastReport = useLibraryStore((s) => s.lastReport);
  const cleaning = useLibraryStore((s) => s.cleaning);
  const lastCleanedCount = useLibraryStore((s) => s.lastCleanedCount);
  const scanDirectory = useLibraryStore((s) => s.scanDirectory);
  const backfillMetadata = useLibraryStore((s) => s.backfillMetadata);

  return (
    <div className="px-6 py-3 border-b border-fg flex items-center gap-4 text-sm">
      <Button onClick={scanDirectory} disabled={scanning}>
        {scanning ? "SCANNING..." : "SCAN DIRECTORY"}
      </Button>
      {/* CLEAN METADATA: aplica cleanup heurístico (strip "- Topic", "(Official
          Video)", etc.) a tracks descargados que se guardaron antes de que
          existiera el cleanup, o después de bumpear las heurísticas. Sólo
          afecta source_type='downloaded'. */}
      <Button onClick={backfillMetadata} disabled={cleaning || scanning}>
        {cleaning ? "CLEANING..." : "CLEAN METADATA"}
      </Button>
      <span className="text-muted">
        {trackCount} {trackCount === 1 ? "TRACK" : "TRACKS"}
      </span>
      {lastCleanedCount !== null && (
        <span className="text-muted">
          {lastCleanedCount === 0
            ? "ALREADY CLEAN"
            : `CLEANED: ${lastCleanedCount} ${lastCleanedCount === 1 ? "TRACK" : "TRACKS"}`}
        </span>
      )}
      {lastReport && (
        <span className="text-muted ml-auto">
          LAST SCAN: {lastReport.scanned} FOUND · {lastReport.inserted} NEW ·{" "}
          {lastReport.skipped} DUP · {lastReport.errors} ERR
        </span>
      )}
    </div>
  );
}
