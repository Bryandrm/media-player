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

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const formatDuration = (ms: number) => formatTime(ms / 1000);

function App() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [lastReport, setLastReport] = useState<ScanReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = currentIndex !== null ? tracks[currentIndex] ?? null : null;
  const hasPrev = currentIndex !== null && currentIndex > 0;
  const hasNext = currentIndex !== null && currentIndex < tracks.length - 1;

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

  const playIndex = useCallback((i: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    setTracks((prev) => {
      const track = prev[i];
      if (!track) return prev;
      audio.src = convertFileSrc(track.filePath);
      setCurrentIndex(i);
      audio.play().catch((e) => setError(String(e)));
      return prev;
    });
  }, []);

  const next = useCallback(() => {
    if (currentIndex === null) return;
    if (currentIndex + 1 < tracks.length) playIndex(currentIndex + 1);
  }, [currentIndex, tracks.length, playIndex]);

  const prev = useCallback(() => {
    if (currentIndex === null) return;
    if (currentIndex > 0) playIndex(currentIndex - 1);
  }, [currentIndex, playIndex]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  }, [current]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (audio && isFinite(time)) audio.currentTime = time;
  }, []);

  // Audio events → state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setCurrentTime(audio.currentTime);
    const onDuration = () => setDuration(audio.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      // auto-advance
      if (currentIndex !== null && currentIndex + 1 < tracks.length) {
        playIndex(currentIndex + 1);
      }
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [currentIndex, tracks.length, playIndex]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when typing into a real input
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          if (current) {
            e.preventDefault();
            seek(Math.max(0, currentTime - 5));
          }
          break;
        case "ArrowRight":
          if (current) {
            e.preventDefault();
            seek(Math.min(duration, currentTime + 5));
          }
          break;
        case "n":
        case "N":
          next();
          break;
        case "p":
        case "P":
          prev();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, currentTime, duration, togglePlay, seek, next, prev]);

  const btn =
    "bg-bg text-fg border-2 border-fg px-4 py-2 font-bold tracking-wider uppercase " +
    "hover:bg-accent hover:text-bg hover:border-accent " +
    "disabled:text-muted disabled:border-muted disabled:cursor-not-allowed disabled:bg-bg";

  return (
    <main className="flex flex-col h-screen">
      {/* Header */}
      <header className="px-6 py-4 border-b-2 border-fg flex items-baseline gap-4">
        <h1 className="text-lg font-bold tracking-wider">BRUTALIST // PLAYER</h1>
        <span className="text-muted text-xs">LIBRARY</span>
      </header>

      {/* Toolbar */}
      <div className="px-6 py-3 border-b border-fg flex items-center gap-4 text-sm">
        <button onClick={scanDirectory} disabled={scanning} className={btn}>
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
                const isCurrent = currentIndex === i;
                return (
                  <tr
                    key={t.id}
                    onClick={() => playIndex(i)}
                    className={`cursor-pointer border-b border-muted/40 ${
                      isCurrent ? "bg-accent text-bg" : "hover:bg-fg hover:text-bg"
                    }`}
                  >
                    <td className="px-3 py-2 tabular-nums font-bold">
                      {isCurrent ? "►" : String(i + 1).padStart(2, "0")}
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

      {/* Player bar — two rows: track info + controls/seek */}
      <footer className="border-t-2 border-fg px-6 py-3 flex flex-col gap-2">
        <div className="text-sm truncate">
          {current ? (
            <>
              <span className="font-bold">{current.title}</span>
              <span className="text-muted"> — {current.artist ?? "—"}</span>
              {current.album && (
                <span className="text-muted"> · {current.album}</span>
              )}
            </>
          ) : (
            <span className="text-muted">NOTHING PLAYING</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button onClick={prev} disabled={!hasPrev} className={btn}>PREV</button>
          <button onClick={togglePlay} disabled={!current} className={`${btn} min-w-[90px]`}>
            {isPlaying ? "PAUSE" : "PLAY"}
          </button>
          <button onClick={next} disabled={!hasNext} className={btn}>NEXT</button>

          <span className="text-xs tabular-nums text-muted ml-2 w-12 text-right">
            {formatTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => seek(parseFloat(e.target.value))}
            disabled={!current || duration === 0}
            className="range-brutal flex-1"
          />
          <span className="text-xs tabular-nums text-muted w-12">
            {formatTime(duration)}
          </span>
        </div>
      </footer>

      <audio ref={audioRef} preload="auto" crossOrigin="anonymous" />
    </main>
  );
}

export default App;
