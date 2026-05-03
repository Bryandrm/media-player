import { useLibraryStore } from "../../stores/libraryStore";
import { useIdentificationStore } from "../../stores/identificationStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { Button } from "../ui/Button";

export function LibraryToolbar() {
  const scanning = useLibraryStore((s) => s.scanning);
  const trackCount = useLibraryStore((s) => s.tracks.length);
  const lastReport = useLibraryStore((s) => s.lastReport);
  const cleaning = useLibraryStore((s) => s.cleaning);
  const lastCleanedCount = useLibraryStore((s) => s.lastCleanedCount);
  const scanDirectory = useLibraryStore((s) => s.scanDirectory);
  const backfillMetadata = useLibraryStore((s) => s.backfillMetadata);

  const bulkProgress = useIdentificationStore((s) => s.bulkProgress);
  const bulkSummary = useIdentificationStore((s) => s.bulkSummary);
  const identifyAll = useIdentificationStore((s) => s.identifyAll);
  const cancelAll = useIdentificationStore((s) => s.cancelAll);
  const dismissBulkSummary = useIdentificationStore((s) => s.dismissBulkSummary);
  const fpcalcOk = useDownloadStore((s) => s.deps?.fpcalc ?? false);

  const bulkRunning = bulkProgress !== null;

  // Click handler del botón IDENTIFY ALL: si fpcalc no está, alert
  // (mismo pattern que el indicador per-row); si todo bien, dispara bulk
  // (que internamente abre el modal de API key si hace falta).
  const onIdentifyAll = () => {
    if (!fpcalcOk) {
      alert("fpcalc not found.\n\nInstall on macOS: brew install chromaprint");
      return;
    }
    void identifyAll();
  };

  return (
    <div className="px-6 py-3 border-b border-fg flex items-center gap-4 text-sm">
      <Button onClick={scanDirectory} disabled={scanning}>
        {scanning ? "SCANNING..." : "SCAN DIRECTORY"}
      </Button>
      {/* CLEAN METADATA: aplica cleanup heurístico (strip "- Topic", "(Official
          Video)", etc.) a tracks descargados que se guardaron antes de que
          existiera el cleanup, o después de bumpear las heurísticas. Sólo
          afecta source_type='downloaded'. */}
      <Button onClick={backfillMetadata} disabled={cleaning || scanning || bulkRunning}>
        {cleaning ? "CLEANING..." : "CLEAN METADATA"}
      </Button>
      {/* IDENTIFY ALL: dispara el bulk de AcoustID sobre todos los tracks
          con status NULL o 'api_error'. Tres estados visibles:
            - `IDENTIFY ALL` (idle, clickable)
            - `STARTING...` (placeholder optimista entre click y primer
               progress event — total=0 lo identifica)
            - `STOP X/Y` (corriendo, click → cancela)
          El throttle (~2.85 rps) lo maneja el backend. */}
      {bulkRunning ? (
        bulkProgress.total === 0 ? (
          <Button disabled variant="active">STARTING...</Button>
        ) : (
          <Button onClick={() => void cancelAll()} variant="active">
            STOP {bulkProgress.done}/{bulkProgress.total}
          </Button>
        )
      ) : (
        <Button onClick={onIdentifyAll} disabled={scanning || cleaning}>
          IDENTIFY ALL
        </Button>
      )}
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
      {/* Summary persistente del último bulk hasta que el user lo descarte
          o lance otro. Botón "✕" para dismiss. */}
      {bulkSummary && !bulkRunning && (
        <span className="text-muted ml-auto flex items-center gap-2">
          <span>
            {bulkSummary.cancelled ? "STOPPED" : "DONE"} —{" "}
            <span className="text-accent">{bulkSummary.identified} ID</span>
            {bulkSummary.lowConfidence > 0 && ` · ${bulkSummary.lowConfidence} ?`}
            {bulkSummary.noMatch > 0 && ` · ${bulkSummary.noMatch} —`}
            {bulkSummary.fingerprintFailed > 0 && ` · ${bulkSummary.fingerprintFailed} !`}
            {bulkSummary.apiError > 0 && ` · ${bulkSummary.apiError} ⌛`}
          </span>
          <button
            onClick={dismissBulkSummary}
            className="text-muted hover:text-accent font-bold px-1"
            title="Dismiss"
          >
            ✕
          </button>
        </span>
      )}
      {!bulkSummary && lastReport && (
        <span className="text-muted ml-auto">
          LAST SCAN: {lastReport.scanned} FOUND · {lastReport.inserted} NEW ·{" "}
          {lastReport.skipped} DUP · {lastReport.errors} ERR
        </span>
      )}
    </div>
  );
}
