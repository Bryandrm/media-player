import { useUiStore } from "../../stores/uiStore";
import { Button } from "../ui/Button";
import { PRESET_KEYS } from "./VisualizerCanvas";

export function PresetSelector() {
  const presetIndex = useUiStore((s) => s.presetIndex);
  const setPresetIndex = useUiStore((s) => s.setPresetIndex);

  const total = PRESET_KEYS.length;
  const safeIndex = ((presetIndex % total) + total) % total;
  const currentName = PRESET_KEYS[safeIndex] ?? "—";

  const goPrev = () => setPresetIndex((safeIndex - 1 + total) % total);
  const goNext = () => setPresetIndex((safeIndex + 1) % total);
  const goRandom = () => {
    if (total <= 1) return;
    let next = Math.floor(Math.random() * total);
    if (next === safeIndex) next = (next + 1) % total;
    setPresetIndex(next);
  };

  return (
    <div className="border-t-2 border-fg px-4 py-3 flex flex-col gap-2">
      <div className="text-xs text-muted truncate">
        PRESET {String(safeIndex + 1).padStart(3, "0")}/{String(total).padStart(3, "0")}
        {" · "}
        <span className="text-fg">{currentName}</span>
      </div>
      <div className="flex gap-2">
        <Button onClick={goPrev} size="sm">PREV</Button>
        <Button onClick={goNext} size="sm">NEXT</Button>
        <Button onClick={goRandom} size="sm">RANDOM</Button>
      </div>
    </div>
  );
}
