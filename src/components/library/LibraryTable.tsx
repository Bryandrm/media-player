import { useMemo } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { useIdentificationStore } from "../../stores/identificationStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { formatDuration } from "../../lib/format";
import { filterTracks } from "../../lib/search";
import type {
  Track,
  TrackIdentificationStatus,
  TrackLyricsStatus,
} from "../../types";
import { MarqueeText } from "../ui/MarqueeText";
import { LibrarySearchBar } from "./LibrarySearchBar";

// Indicador de letras en la columna L de la library.
//   synced       → "[L]" en accent (la mejor experiencia, llamativo)
//   plain        → "·" en muted (hay algo pero no sincronizado)
//   instrumental → "♪" en muted (track sin letras confirmado por LRCLIB)
//   not_found    → "—" en muted (buscamos, nadie tenía letras)
//   null         → vacío (todavía no fetcheamos)
//
// La distinción "—" vs vacío permite saber cuáles tracks ya intentamos vs
// cuáles tenés que reproducir para chequear.
//
// En la fila currente (bg accent), el accent del indicador desaparece —
// usamos foreground para que quede visible contra el fondo naranja. La
// fila tiene `text-bg` global, así que sin override el `[L]` quedaría
// invisible (negro sobre naranja apenas se distingue).
function LyricsIndicator({
  status,
  isCurrent,
}: {
  status: TrackLyricsStatus | null;
  isCurrent: boolean;
}) {
  if (status === null) return null;
  if (status === "synced") {
    return (
      <span className={isCurrent ? "" : "text-accent"}>[L]</span>
    );
  }
  if (status === "plain") {
    return <span className="text-muted">·</span>;
  }
  if (status === "instrumental") {
    return <span className="text-muted">♪</span>;
  }
  // not_found
  return <span className="text-muted">—</span>;
}

// Indicador de identification + trigger inline. La celda misma es el
// botón cuando hay acción posible (status null/api_error/low_confidence)
// — sin context menus, sin botones flotantes (no hay precedente en la
// app y romperíamos brutalist agregando affordances ocultas).
//
//   null            → "ID" muted, clickable (acción inicial)
//   inFlight        → "..." muted (animación implícita por el cambio)
//   identified      → "[ID]" en accent (mismo lenguaje que [L]), no-op click
//   low_confidence  → "?" muted, clickable (retriable, score subió posiblemente)
//   no_match        → "—" muted (no clickable — no va a aparecer)
//   fingerprint_failed → "!" muted (no clickable — archivo no soportado)
//   api_error       → "⌛" muted, clickable (retriable)
//
// En la fila currente (bg accent), el accent del [ID] desaparece — usamos
// foreground para que quede visible contra el fondo naranja, mismo patrón
// que LyricsIndicator.
function IdentificationIndicator({
  status,
  isCurrent,
  inFlight,
  clickable,
}: {
  status: TrackIdentificationStatus | null;
  isCurrent: boolean;
  inFlight: boolean;
  clickable: boolean;
}) {
  if (inFlight) return <span className="text-muted">...</span>;
  if (status === null) {
    // Affordance discreta: gris con hover en accent sólo cuando es
    // clickable (y no estamos en la fila currente, donde el hover row
    // pisa el color de la celda).
    return (
      <span
        className={
          clickable && !isCurrent
            ? "text-muted hover:text-accent"
            : "text-muted"
        }
      >
        ID
      </span>
    );
  }
  if (status === "identified") {
    return <span className={isCurrent ? "" : "text-accent"}>[ID]</span>;
  }
  if (status === "low_confidence") return <span className="text-muted">?</span>;
  if (status === "no_match") return <span className="text-muted">—</span>;
  if (status === "fingerprint_failed") return <span className="text-muted">!</span>;
  // api_error
  return <span className="text-muted">⌛</span>;
}

const IDENTIFY_RETRIABLE_STATUSES: ReadonlyArray<TrackIdentificationStatus | null> = [
  null,
  "low_confidence",
  "api_error",
];

// Tooltip de la celda ID: combina el status legible + score si lo
// tenemos (sólo en `identified` — los otros status no tienen score
// persistido). Devuelve undefined cuando no hay nada útil para
// no añadir un title vacío al DOM.
function idTooltip(t: Track, clickable: boolean): string | undefined {
  const score = t.acoustidScore;
  switch (t.identificationStatus) {
    case "identified":
      return score !== null
        ? `Identified (score ${score.toFixed(3)})`
        : "Identified";
    case "low_confidence":
      return clickable
        ? "Low confidence — click to retry with same fingerprint"
        : "Low confidence — match below threshold";
    case "no_match":
      return "No match in AcoustID database";
    case "fingerprint_failed":
      return "fpcalc failed on this file";
    case "api_error":
      return clickable
        ? "API error — click to retry"
        : "API error";
    case null:
      return clickable ? "Identify with AcoustID" : undefined;
    default:
      return undefined;
  }
}

export function LibraryTable() {
  const tracks = useLibraryStore((s) => s.tracks);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const loadTracks = useLibraryStore((s) => s.loadTracks);
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const identify = useIdentificationStore((s) => s.identify);
  const identifying = useIdentificationStore((s) => s.identifying);
  const apiKey = useIdentificationStore((s) => s.apiKey);
  const openApiKeyModal = useIdentificationStore((s) => s.openApiKeyModal);
  const deps = useDownloadStore((s) => s.deps);

  const filtered = useMemo(
    () => filterTracks(tracks, searchQuery),
    [tracks, searchQuery],
  );

  // Click en la celda ID → cascade fpcalc → AcoustID. Tres guards antes:
  //   1. fpcalc instalado (sin él, fingerprint imposible).
  //   2. API key seteada (sin ella, AcoustID rechaza).
  //   3. Status retriable (no clickeamos identified/no_match/fingerprint_failed).
  // Después del identify: refrescamos la library para que aparezca el
  // indicador nuevo + la metadata canónica (si pisamos title/artist).
  const onIdentifyClick = async (e: React.MouseEvent, track: Track) => {
    e.stopPropagation(); // que no dispare playTrack del row.
    if (!IDENTIFY_RETRIABLE_STATUSES.includes(track.identificationStatus)) return;

    if (!deps?.fpcalc) {
      alert(
        "fpcalc not found.\n\nInstall on macOS: brew install chromaprint",
      );
      return;
    }
    if (!apiKey || apiKey.trim() === "") {
      openApiKeyModal();
      return;
    }
    const result = await identify(track.id);
    // loadTracks refresca el indicador ID + metadata; siempre lo corremos
    // (incluso si status fue no_match) para que el indicador transicione
    // de null a su nuevo estado.
    if (result !== null) {
      await loadTracks();
    }
  };

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
              {/* Columna L: indicador de letras. Width pequeño porque sólo
                  contiene 1-3 chars. */}
              <col className="w-10" />
              {/* Columna ID: indicador de identification (AcoustID).
                  Mismo width que L — máximo 4 chars ("[ID]"). */}
              <col className="w-12" />
              <col className="w-3/5" />
              <col className="w-2/5" />
              <col className="w-24" />
            </colgroup>
            <thead className="sticky top-0 bg-bg">
              <tr className="border-b-2 border-fg text-muted">
                <th className="text-left px-3 py-2">#</th>
                <th className="text-left px-3 py-2" title="Lyrics status">
                  L
                </th>
                <th
                  className="text-left px-3 py-2"
                  title="Identification status (AcoustID)"
                >
                  ID
                </th>
                <th className="text-left px-3 py-2">TITLE</th>
                <th className="text-left px-3 py-2">ARTIST</th>
                <th className="text-right px-3 py-2">DURATION</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, i) => {
                const isCurrent = t.id === currentTrackId;
                const inFlight = identifying.has(t.id);
                const idClickable = IDENTIFY_RETRIABLE_STATUSES.includes(
                  t.identificationStatus,
                );
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
                    <td className="px-3 py-2 font-bold">
                      <LyricsIndicator status={t.lyricsStatus} isCurrent={isCurrent} />
                    </td>
                    <td
                      className={`px-3 py-2 font-bold ${
                        idClickable && !inFlight ? "cursor-pointer" : ""
                      }`}
                      onClick={
                        idClickable && !inFlight
                          ? (e) => onIdentifyClick(e, t)
                          : undefined
                      }
                      title={idTooltip(t, idClickable && !inFlight)}
                    >
                      <IdentificationIndicator
                        status={t.identificationStatus}
                        isCurrent={isCurrent}
                        inFlight={inFlight}
                        clickable={idClickable}
                      />
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
