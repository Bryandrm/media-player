import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { Button } from "../ui/Button";

export function Controls() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const tracks = useLibraryStore((s) => s.tracks);

  const idx =
    currentTrackId === null
      ? -1
      : tracks.findIndex((t) => t.id === currentTrackId);
  const hasTrack = currentTrackId !== null;
  // PLAY se habilita si hay un track cargado O si hay tracks en la library
  // (en ese caso togglePlay arranca con el primero).
  const canPlay = hasTrack || tracks.length > 0;
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < tracks.length - 1;

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
    </>
  );
}
