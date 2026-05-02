import { usePlayerStore } from "../../stores/playerStore";
import { Button } from "../ui/Button";

export function VolumeSlider() {
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);

  return (
    <div className="flex items-center gap-2 ml-2 shrink-0">
      <Button onClick={toggleMute} size="sm" className="min-w-[76px]">
        {muted ? "UNMUTE" : "MUTE"}
      </Button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(e) => setVolume(parseFloat(e.target.value))}
        className="range-brutal w-20"
        aria-label="Volume"
      />
    </div>
  );
}
