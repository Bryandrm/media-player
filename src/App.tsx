import { useEffect } from "react";
import { useLibraryStore } from "./stores/libraryStore";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { LibraryToolbar } from "./components/library/LibraryToolbar";
import { LibraryTable } from "./components/library/LibraryTable";
import { PlayerBar } from "./components/player/PlayerBar";

function App() {
  const loadTracks = useLibraryStore((s) => s.loadTracks);
  const error = useLibraryStore((s) => s.error);

  useAudioPlayer();
  useKeyboardShortcuts();

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  return (
    <main className="flex flex-col h-screen">
      <header className="px-6 py-4 border-b-2 border-fg flex items-baseline gap-4">
        <h1 className="text-lg font-bold tracking-wider">BRUTALIST // PLAYER</h1>
        <span className="text-muted text-xs">LIBRARY</span>
      </header>

      <LibraryToolbar />

      {error && (
        <div className="px-6 py-2 border-b-2 border-accent text-accent text-sm">
          ERROR: {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <LibraryTable />
      </div>

      <PlayerBar />
    </main>
  );
}

export default App;
