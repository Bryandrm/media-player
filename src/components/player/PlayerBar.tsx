import { invoke } from "@tauri-apps/api/core";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { persistResumeNow } from "../../hooks/usePlaybackPersist";
import { Button } from "../ui/Button";
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

  // Recovery del bug "audio mudo tras cambiar de output device BT" (B2): el
  // único fix confiable es un proceso nuevo (AudioContext nuevo que bindea al
  // device actual). Guardamos la posición y reiniciamos la app — el resume la
  // restaura al bootear. Ver Gotcha #32.
  const onResetAudio = () => {
    persistResumeNow();
    void invoke("restart_app");
  };

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
          {/* Recovery de audio mudo tras cambio de output device (B2). Reinicia
              la app (proceso nuevo) — restaura el track + posición al bootear. */}
          <Button
            size="sm"
            onClick={onResetAudio}
            title="Reinicia la app para recuperar el audio si se quedó mudo tras cambiar de audífonos/altavoces"
          >
            RESET AUDIO
          </Button>
        </div>
      </div>
    </footer>
  );
}
