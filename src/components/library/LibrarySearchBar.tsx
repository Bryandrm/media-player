import type { KeyboardEvent } from "react";
import { useLibraryStore } from "../../stores/libraryStore";

export function LibrarySearchBar() {
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const totalTracks = useLibraryStore((s) => s.tracks.length);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setSearchQuery("");
      e.currentTarget.blur();
    }
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b-2 border-fg">
      <label className="text-xs font-bold tracking-wider uppercase text-muted shrink-0">
        SEARCH
      </label>
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={`TITLE / ARTIST / ALBUM (${totalTracks} TRACKS)`}
        className="flex-1 bg-bg text-fg border-2 border-fg px-3 py-1 text-xs font-mono outline-none focus:border-accent placeholder:text-muted min-w-0"
      />
      {searchQuery && (
        <button
          onClick={() => setSearchQuery("")}
          className="text-xs font-bold tracking-wider uppercase text-muted hover:text-accent shrink-0"
          aria-label="Clear search"
        >
          CLEAR
        </button>
      )}
    </div>
  );
}
