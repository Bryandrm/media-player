import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { Button } from "../ui/Button";
import { Controls } from "./Controls";
import { CoverArt } from "./CoverArt";
import { SeekBar } from "./SeekBar";
import { VolumeSlider } from "./VolumeSlider";

export function PlayerBar() {
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const tracks = useLibraryStore((s) => s.tracks);
  const rebuildAudio = usePlayerStore((s) => s.rebuildAudio);
  const current =
    currentTrackId === null
      ? null
      : tracks.find((t) => t.id === currentTrackId) ?? null;

  return (
    <footer className="border-t-2 border-fg px-4 py-2 flex items-center gap-3">
      <CoverArt path={current?.coverArtPath} size="sm" />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="text-xs truncate">
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

        <div className="flex items-center gap-2">
          <Controls />
          <SeekBar />
          <VolumeSlider />
          {/* Recovery de audio mudo tras cambio de output device (B2).
              Reconstruye el pipeline de audio in-place (ctx nuevo) — restaura la
              pista en su posición, sin reiniciar la app. También corre solo en
              `devicechange` mientras suena. */}
          <Button
            size="sm"
            onClick={() => rebuildAudio()}
            title="Recupera el audio si se quedó mudo tras cambiar de audífonos/altavoces (reconstruye el pipeline sin reiniciar la app)"
          >
            RESET AUDIO
          </Button>
        </div>
      </div>
    </footer>
  );
}
