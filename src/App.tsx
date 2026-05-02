import { useEffect } from "react";
import { useLibraryStore } from "./stores/libraryStore";
import { useDownloadStore } from "./stores/downloadStore";
import { useUiStore } from "./stores/uiStore";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDownloadEvents } from "./hooks/useDownloadEvents";
import { Tabs } from "./components/ui/Tabs";
import { LibraryToolbar } from "./components/library/LibraryToolbar";
import { LibraryTable } from "./components/library/LibraryTable";
import { PlayerBar } from "./components/player/PlayerBar";
import { VisualizerView } from "./components/visualizer/VisualizerView";
import { DownloadsView } from "./components/downloads/DownloadsView";

function App() {
  const loadTracks = useLibraryStore((s) => s.loadTracks);
  const backfillCovers = useLibraryStore((s) => s.backfillCovers);
  const error = useLibraryStore((s) => s.error);
  const checkDependencies = useDownloadStore((s) => s.checkDependencies);
  const view = useUiStore((s) => s.view);

  useAudioPlayer();
  useKeyboardShortcuts();
  useDownloadEvents();

  useEffect(() => {
    loadTracks().then(() => backfillCovers());
    checkDependencies();
  }, [loadTracks, backfillCovers, checkDependencies]);

  return (
    <main className="flex flex-col h-screen">
      <header className="px-6 py-4 border-b-2 border-fg flex items-center gap-6">
        <h1 className="text-lg font-bold tracking-wider">BRUTALIST // PLAYER</h1>
        <Tabs />
      </header>

      {view === "library" && <LibraryToolbar />}

      {error && (
        <div className="px-6 py-2 border-b-2 border-accent text-accent text-sm">
          ERROR: {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {view === "library" && <LibraryTable />}
        {view === "downloads" && <DownloadsView />}
        {view === "visualizer" && <VisualizerView />}
      </div>

      <PlayerBar />
    </main>
  );
}

export default App;
