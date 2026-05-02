import { useMemo } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { formatDuration } from "../../lib/format";
import { filterTracks } from "../../lib/search";
import { MarqueeText } from "../ui/MarqueeText";
import { LibrarySearchBar } from "./LibrarySearchBar";

export function LibraryTable() {
  const tracks = useLibraryStore((s) => s.tracks);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const filtered = useMemo(
    () => filterTracks(tracks, searchQuery),
    [tracks, searchQuery],
  );

  // Empty state global (sin tracks importados todavía) vs filtro vacío
  // (hay tracks pero ninguno matchea el query) — mensajes distintos para
  // que el usuario sepa qué hacer.
  const emptyMessage =
    tracks.length === 0
      ? "NO TRACKS. SCAN A DIRECTORY OR DOWNLOAD A URL."
      : "NO MATCHES.";

  return (
    <div className="h-full flex flex-col min-h-0">
      <LibrarySearchBar />
      <div className="flex-1 overflow-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="p-12 text-center text-muted text-sm">
            {emptyMessage}
          </div>
        ) : (
          // `table-fixed` fija anchos de columna por la primera fila — sin
          // esto, las columnas se expanden con el contenido y los títulos
          // largos rompen el layout en filas multilinea.
          //
          // Sacamos ALBUM: en archivos descargados de YouTube casi nunca
          // queda poblado de forma útil (suele ser el título del video o
          // vacío). Si en el futuro entra música con tags ID3 ricos y vale
          // la pena, la metemos de vuelta como columna opcional.
          <table className="w-full border-collapse text-xs table-fixed">
            <colgroup>
              <col className="w-12" />
              <col className="w-3/5" />
              <col className="w-2/5" />
              <col className="w-24" />
            </colgroup>
            <thead className="sticky top-0 bg-bg">
              <tr className="border-b-2 border-fg text-muted">
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2">TITLE</th>
                <th className="text-left px-3 py-2">ARTIST</th>
                <th className="text-right px-3 py-2">DURATION</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, i) => {
                const isCurrent = t.id === currentTrackId;
                return (
                  <tr
                    key={t.id}
                    onClick={() => playTrack(t)}
                    className={`cursor-pointer border-b border-muted/40 ${
                      isCurrent
                        ? "bg-accent text-bg"
                        : "hover:bg-fg hover:text-bg"
                    }`}
                  >
                    <td className="px-3 py-2 tabular-nums font-bold">
                      {isCurrent ? "►" : String(i + 1).padStart(2, "0")}
                    </td>
                    <td className="px-3 py-2">
                      <MarqueeText text={t.title} />
                    </td>
                    <td className="px-3 py-2">
                      <MarqueeText text={t.artist ?? "—"} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatDuration(t.durationMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
