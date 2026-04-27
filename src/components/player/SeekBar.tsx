import { usePlayerStore } from "../../stores/playerStore";
import { formatTime } from "../../lib/format";

export function SeekBar() {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const seek = usePlayerStore((s) => s.seek);

  const disabled = currentTrackId === null || duration === 0;

  return (
    <>
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
        disabled={disabled}
        className="range-brutal flex-1"
        aria-label="Seek"
      />
      <span className="text-xs tabular-nums text-muted w-12">
        {formatTime(duration)}
      </span>
    </>
  );
}
