import { useMemo } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { filterTracks } from "../../lib/search";
import { Button } from "../ui/Button";

export function Controls() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const crossfadeMs = usePlayerStore((s) => s.crossfadeMs);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleCrossfade = usePlayerStore((s) => s.cycleCrossfade);
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
      <Button size="sm" onClick={prev} disabled={!hasPrev}>
        PREV
      </Button>
      <Button
        size="sm"
        onClick={togglePlay}
        disabled={!canPlay}
        // min-w fija el ancho del botón al de "PAUSE" (5 chars) — sin esto,
        // el toggle "PLAY" ↔ "PAUSE" cambiaba el width y empujaba la seek
        // bar y todo lo que sigue a la derecha.
        className="min-w-[68px]"
      >
        {isPlaying ? "PAUSE" : "PLAY"}
      </Button>
      <Button size="sm" onClick={next} disabled={!hasNext}>
        NEXT
      </Button>
      <Button
        size="sm"
        onClick={toggleShuffle}
        variant={shuffle ? "active" : "default"}
        aria-pressed={shuffle}
      >
        SHUFFLE
      </Button>
      <Button
        size="sm"
        onClick={cycleCrossfade}
        variant={crossfadeMs > 0 ? "active" : "default"}
        // min-w fija el ancho al de "XFADE 12s" (el label más largo) — sin
        // esto el toggle entre OFF/3s/6s/12s mueve los botones a la derecha
        // del player bar.
        className="min-w-[96px]"
        aria-label={`Crossfade ${crossfadeMs === 0 ? "off" : `${crossfadeMs / 1000} seconds`}`}
      >
        XFADE {crossfadeMs === 0 ? "OFF" : `${crossfadeMs / 1000}s`}
      </Button>
    </>
  );
}
