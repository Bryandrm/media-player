import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { Controls } from "./Controls";
import { CoverArt } from "./CoverArt";
import { SeekBar } from "./SeekBar";
import { VolumeSlider } from "./VolumeSlider";

export function PlayerBar() {
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const tracks = useLibraryStore((s) => s.tracks);
  const current =
    currentTrackId === null
      ? null
      : tracks.find((t) => t.id === currentTrackId) ?? null;

  return (
    <footer className="border-t-2 border-fg px-6 py-3 flex items-center gap-4">
      <CoverArt path={current?.coverArtPath} />
      <div className="flex-1 min-w-0 flex flex-col gap-2">
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
          <Controls />
          <SeekBar />
          <VolumeSlider />
        </div>
      </div>
    </footer>
  );
}
