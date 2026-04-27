import { LibraryTable } from "../library/LibraryTable";
import { PresetSelector } from "./PresetSelector";
import { VisualizerCanvas } from "./VisualizerCanvas";

export function VisualizerView() {
  return (
    <div className="h-full grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] min-h-0">
      <div className="border-r-2 border-fg flex flex-col min-h-0 min-w-0">
        <div className="flex-1 min-h-0 min-w-0">
          <VisualizerCanvas />
        </div>
        <PresetSelector />
      </div>
      <div className="overflow-auto min-w-0">
        <LibraryTable />
      </div>
    </div>
  );
}
