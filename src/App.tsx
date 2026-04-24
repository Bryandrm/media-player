import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Track = {
  id: number;
  filePath: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number;
  trackNumber: number | null;
  year: number | null;
  genre: string | null;
  format: string | null;
};

type ScanReport = {
  scanned: number;
  inserted: number;
  skipped: number;
  errors: number;
};

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function App() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [current, setCurrent] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [lastReport, setLastReport] = useState<ScanReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadLibrary = useCallback(async () => {
    try {
      const list = await invoke<Track[]>("library_list_tracks");
      setTracks(list);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    reloadLibrary();
  }, [reloadLibrary]);

  async function scanDirectory() {
    setError(null);
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      setScanning(true);
      const report = await invoke<ScanReport>("library_scan_directory", { path: picked });
      setLastReport(report);
      await reloadLibrary();
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function playTrack(track: Track) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = convertFileSrc(track.filePath);
    setCurrent(track);
    try {
      await audio.play();
      setIsPlaying(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      await audio.play();
      setIsPlaying(true);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => setIsPlaying(false);
    const onPause = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
    };
  }, []);

  return (
    <main className="flex flex-col h-screen">
      {/* Header */}
      <header className="px-6 py-4 border-b-2 border-fg flex items-baseline gap-4">
        <h1 className="text-lg font-bold tracking-wider">BRUTALIST // PLAYER</h1>
        <span className="text-muted text-xs">LIBRARY</span>
      </header>

      {/* Toolbar */}
      <div className="px-6 py-3 border-b border-fg flex items-center gap-4 text-sm">
        <button
          onClick={scanDirectory}
          disabled={scanning}
          className="bg-bg text-fg border-2 border-fg px-4 py-2 font-bold tracking-wider uppercase hover:bg-accent hover:text-bg hover:border-accent disabled:text-muted disabled:border-muted disabled:cursor-not-allowed"
        >
          {scanning ? "SCANNING..." : "SCAN DIRECTORY"}
        </button>
        <span className="text-muted">
          {tracks.length} {tracks.length === 1 ? "TRACK" : "TRACKS"}
        </span>
        {lastReport && (
          <span className="text-muted ml-auto">
            LAST SCAN: {lastReport.scanned} FOUND · {lastReport.inserted} NEW ·{" "}
            {lastReport.skipped} DUP · {lastReport.errors} ERR
          </span>
        )}
      </div>

      {error && (
        <div className="px-6 py-2 border-b-2 border-accent text-accent text-sm">
          ERROR: {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {tracks.length === 0 ? (
          <div className="p-12 text-center text-muted">
            NO TRACKS. SCAN A DIRECTORY TO POPULATE THE LIBRARY.
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-bg">
              <tr className="border-b-2 border-fg text-muted">
                <th className="text-left px-3 py-2 w-12">#</th>
                <th className="text-left px-3 py-2">TITLE</th>
                <th className="text-left px-3 py-2">ARTIST</th>
                <th className="text-left px-3 py-2">ALBUM</th>
                <th className="text-right px-3 py-2 w-24">DURATION</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((t, i) => {
                const isCurrent = current?.id === t.id;
                return (
                  <tr
                    key={t.id}
                    onClick={() => playTrack(t)}
                    className={`cursor-pointer border-b border-muted/40 ${
                      isCurrent ? "bg-accent text-bg" : "hover:bg-fg hover:text-bg"
                    }`}
                  >
                    <td className="px-3 py-2 tabular-nums">
                      {String(i + 1).padStart(2, "0")}
                    </td>
                    <td className="px-3 py-2">{t.title}</td>
                    <td className="px-3 py-2">{t.artist ?? "—"}</td>
                    <td className="px-3 py-2">{t.album ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatDuration(t.durationMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Player bar */}
      <footer className="border-t-2 border-fg px-6 py-3 flex items-center gap-4">
        <button
          onClick={togglePlay}
          disabled={!current}
          className="bg-bg text-fg border-2 border-fg px-4 py-2 font-bold tracking-wider uppercase hover:bg-accent hover:text-bg hover:border-accent disabled:text-muted disabled:border-muted disabled:cursor-not-allowed min-w-[90px]"
        >
          {isPlaying ? "PAUSE" : "PLAY"}
        </button>
        <div className="flex-1 text-sm truncate">
          {current ? (
            <>
              <span className="font-bold">{current.title}</span>
              <span className="text-muted"> — {current.artist ?? "—"}</span>
            </>
          ) : (
            <span className="text-muted">NOTHING PLAYING</span>
          )}
        </div>
        {current && (
          <span className="text-muted text-sm tabular-nums">
            {formatDuration(current.durationMs)}
          </span>
        )}
      </footer>

      <audio ref={audioRef} preload="auto" crossOrigin="anonymous" />
    </main>
  );
}

export default App;
