import { useMemo } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { filterTracks } from "../../lib/search";
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
  const searchQuery = useLibraryStore((s) => s.searchQuery);

  // Queue efectivo = tracks filtrados por el search actual. Los botones de
  // navegación tienen que reflejar lo que `next`/`prev` realmente van a
  // hacer — sin esto, si el search filtra al current track al final del
  // queue, NEXT estaría habilitado pero no haría nada.
  const queue = useMemo(
    () => filterTracks(tracks, searchQuery),
    [tracks, searchQuery],
  );

  const idx =
    currentTrackId === null
      ? -1
      : queue.findIndex((t) => t.id === currentTrackId);
  const hasTrack = currentTrackId !== null;
  const canPlay = hasTrack || queue.length > 0;
  // En shuffle, PREV/NEXT siempre están disponibles si hay >=2 tracks en
  // el queue (next pickea random; prev usa historial o, si está vacío,
  // sequential desde idx).
  const hasPrev = shuffle ? queue.length > 1 && hasTrack : idx > 0;
  const hasNext = shuffle
    ? queue.length > 1 && hasTrack
    : idx >= 0 && idx < queue.length - 1;

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
