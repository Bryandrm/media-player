import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { Button } from "../ui/Button";

export function Controls() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const tracks = useLibraryStore((s) => s.tracks);

  const idx =
    currentTrackId === null
      ? -1
      : tracks.findIndex((t) => t.id === currentTrackId);
  const hasTrack = currentTrackId !== null;
  const canPlay = hasTrack || tracks.length > 0;
  // En shuffle, PREV/NEXT siempre están disponibles si hay >=2 tracks (next
  // pickea random; prev usa historial o, si está vacío, sequential desde idx).
  const hasPrev = shuffle ? tracks.length > 1 && hasTrack : idx > 0;
  const hasNext = shuffle
    ? tracks.length > 1 && hasTrack
    : idx >= 0 && idx < tracks.length - 1;

  return (
    <>
      <Button onClick={prev} disabled={!hasPrev}>
        PREV
      </Button>
      <Button
        onClick={togglePlay}
        disabled={!canPlay}
        className="min-w-[90px]"
      >
        {isPlaying ? "PAUSE" : "PLAY"}
      </Button>
      <Button onClick={next} disabled={!hasNext}>
        NEXT
      </Button>
      <Button
        onClick={toggleShuffle}
        variant={shuffle ? "active" : "default"}
        aria-pressed={shuffle}
      >
        SHUFFLE
      </Button>
    </>
  );
}
