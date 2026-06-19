import { useEffect, useState } from "react";
import { useLibraryStore } from "./stores/libraryStore";
import { useDownloadStore } from "./stores/downloadStore";
import { useUiStore } from "./stores/uiStore";
import { useIdentificationStore } from "./stores/identificationStore";
import { usePlaylistStore } from "./stores/playlistStore";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDownloadEvents } from "./hooks/useDownloadEvents";
import { useIdentificationEvents } from "./hooks/useIdentificationEvents";
import { usePlaybackPersist } from "./hooks/usePlaybackPersist";
import { useMediaSession } from "./hooks/useMediaSession";
import { useLyricsSync } from "./hooks/useLyricsSync";
import { Tabs } from "./components/ui/Tabs";
import { LibraryToolbar } from "./components/library/LibraryToolbar";
import { LibraryTable } from "./components/library/LibraryTable";
import { PlaylistSidebar } from "./components/library/PlaylistSidebar";
import { PlayerBar } from "./components/player/PlayerBar";
import { VisualizerView } from "./components/visualizer/VisualizerView";
import { DownloadsView } from "./components/downloads/DownloadsView";
import { EqualizerView } from "./components/eq/EqualizerView";
import { ApiKeyModal } from "./components/identification/ApiKeyModal";
import { FileDropOverlay } from "./components/library/FileDropOverlay";

function App() {
  const loadTracks = useLibraryStore((s) => s.loadTracks);
  const backfillCovers = useLibraryStore((s) => s.backfillCovers);
  const initMbBackfillEvents = useLibraryStore((s) => s.initMbBackfillEvents);
  const error = useLibraryStore((s) => s.error);
  const checkDependencies = useDownloadStore((s) => s.checkDependencies);
  const loadDownloadHistory = useDownloadStore((s) => s.loadHistory);
  const loadApiKey = useIdentificationStore((s) => s.loadApiKey);
  const loadPlaylists = usePlaylistStore((s) => s.load);
  const view = useUiStore((s) => s.view);

  // VisualizerView se monta lazy en el primer visit a la tab y queda
  // persistente hasta cerrar la app. Esconderlo via CSS (invisible +
  // pointer-events-none) en lugar de unmount preserva el WebGL context y
  // los shaders compilados — sin esto, cada tab change re-pagaba ~100-300ms
  // de freeze al recompilar el preset actual. Ver VisualizerCanvas para el
  // detalle del rAF gate.
  const [visualizerVisited, setVisualizerVisited] = useState(false);

  useAudioPlayer();
  useKeyboardShortcuts();
  useDownloadEvents();
  useIdentificationEvents();
  usePlaybackPersist();
  useMediaSession();
  useLyricsSync();

  useEffect(() => {
    loadTracks().then(() => backfillCovers());
    checkDependencies();
    loadApiKey();
    loadPlaylists();
    loadDownloadHistory();
  }, [
    loadTracks,
    backfillCovers,
    checkDependencies,
    loadApiKey,
    loadPlaylists,
    loadDownloadHistory,
  ]);

  // Listener de eventos mb-backfill-* — efectivamente global. El backend
  // emite progress/completed; el store los routea a su state.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    initMbBackfillEvents().then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [initMbBackfillEvents]);

  useEffect(() => {
    if (view === "visualizer") setVisualizerVisited(true);
  }, [view]);

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

      <div className="flex-1 min-h-0 overflow-hidden relative">
        {view === "library" && (
          // Library = sidebar de playlists + tabla. Flex horizontal para
          // que el sidebar quede sticky y la tabla scrollee independiente.
          <div className="flex h-full w-full">
            <PlaylistSidebar />
            <div className="flex-1 min-w-0">
              <LibraryTable />
            </div>
          </div>
        )}
        {view === "downloads" && <DownloadsView />}
        {view === "eq" && <EqualizerView />}
        {/* Visualizer persistente: una vez visitado, queda montado siempre
            con `absolute inset-0` (mismo tamaño que el contenedor padre,
            sin afectar el flow). Cuando la vista no es 'visualizer', lo
            ocultamos con `invisible pointer-events-none` — preserva el
            layout y dimensions (ResizeObserver no fluctúa), pero los clicks
            pasan a LibraryTable/DownloadsView debajo. */}
        {visualizerVisited && (
          <div
            className={
              view === "visualizer"
                ? "absolute inset-0"
                : "absolute inset-0 invisible pointer-events-none"
            }
            aria-hidden={view !== "visualizer"}
          >
            <VisualizerView />
          </div>
        )}
      </div>

      <PlayerBar />
      <ApiKeyModal />
      <FileDropOverlay />
    </main>
  );
}

export default App;
