import { useMemo, useRef, useState } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { useIdentificationStore } from "../../stores/identificationStore";
import { useDownloadStore } from "../../stores/downloadStore";
import { usePlaylistStore } from "../../stores/playlistStore";
import { formatDuration } from "../../lib/format";
import { filterTracks } from "../../lib/search";
import type {
  Track,
  TrackIdentificationStatus,
  TrackLyricsStatus,
} from "../../types";
import { MarqueeText } from "../ui/MarqueeText";
import { LibrarySearchBar } from "./LibrarySearchBar";
import { AddToPlaylistPopover } from "./AddToPlaylistPopover";

// Indicador de letras en la columna L de la library.
//   aligned      → "[K]" en accent (synced + whisperx alineado → karaoke real
//                  per-word). Distinto de [L] para saber qué tracks ya tienen
//                  forced alignment corrido.
//   synced       → "[L]" en accent (synced sin alinear, highlight por línea)
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
// fila tiene `text-bg` global, así que sin override el `[L]`/`[K]` quedaría
// invisible (negro sobre naranja apenas se distingue).
function LyricsIndicator({
  status,
  isCurrent,
  mismatchScore,
}: {
  status: TrackLyricsStatus | null;
  isCurrent: boolean;
  /** overall_score de CHECK QUALITY (0..1). null = nunca chequeado → sin `Q`. */
  mismatchScore: number | null;
}) {
  if (status === null) return null;

  // Base: indicador de disponibilidad/alineación de la letra.
  let base: React.ReactNode;
  if (status === "aligned") {
    base = (
      <span className={isCurrent ? "" : "text-accent"} title="Karaoke aligned (per-word timing)">[K]</span>
    );
  } else if (status === "synced") {
    base = <span className={isCurrent ? "" : "text-accent"}>[L]</span>;
  } else if (status === "plain") {
    base = <span className="text-muted">·</span>;
  } else if (status === "instrumental") {
    base = <span className="text-muted">♪</span>;
  } else {
    // not_found
    base = <span className="text-muted">—</span>;
  }

  // Marcador secundario `Q`: la letra ya pasó por CHECK QUALITY. Acento si el
  // score es bajo (<0.5 = mismatch alto, líneas malas), muted si es bueno. El
  // % exacto va en el tooltip. Independiente de [K]/[L] (se puede chequear
  // quality sin alinear). Sólo aparece cuando hubo una corrida persistida.
  const quality =
    mismatchScore !== null ? (
      <span
        className={
          isCurrent ? "" : mismatchScore < 0.5 ? "text-accent" : "text-muted"
        }
        title={`Quality checked: ${Math.round(mismatchScore * 100)}%`}
      >
        {" "}Q
      </span>
    ) : null;

  return (
    <>
      {base}
      {quality}
    </>
  );
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
  const setFavorite = useLibraryStore((s) => s.setFavorite);
  const currentTrackId = usePlayerStore((s) => s.currentTrackId);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const identify = useIdentificationStore((s) => s.identify);
  const identifying = useIdentificationStore((s) => s.identifying);
  const apiKey = useIdentificationStore((s) => s.apiKey);
  const openApiKeyModal = useIdentificationStore((s) => s.openApiKeyModal);
  const deps = useDownloadStore((s) => s.deps);

  // Source switch: cuando el usuario seleccionó una playlist en el sidebar,
  // mostramos sus tracks; cuando es null, la library entera. El search
  // funciona igual en ambos casos.
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const playlistTracks = usePlaylistStore((s) => s.tracksOfSelected);
  const removeTrackFromPlaylist = usePlaylistStore((s) => s.removeTrack);
  const reorder = usePlaylistStore((s) => s.reorder);
  const sourceTracks = selectedPlaylistId === null ? tracks : playlistTracks;

  // Smart playlist: membresía derivada de reglas → read-only. No se reordena ni
  // se quitan tracks a mano (eso lo decide el editor de reglas).
  const selectedIsSmart =
    selectedPlaylistId !== null &&
    (playlists.find((p) => p.id === selectedPlaylistId)?.isSmart ?? false);
  // La columna +/− sólo tiene sentido en "all tracks" (+) o en una playlist
  // normal (−); en una smart no mostramos acción de membresía.
  const showMembershipCol = !selectedIsSmart;

  const filtered = useMemo(
    () => filterTracks(sourceTracks, searchQuery),
    [sourceTracks, searchQuery],
  );

  // Reorder por drag & drop: sólo dentro de una playlist y sin search activo
  // (reordenar una vista filtrada es ambiguo — qué position le tocaría a lo
  // que está oculto por el filtro). `dragIndex` = fila agarrada; `dragOverIndex`
  // = fila sobre la que se está soltando (para el indicador visual).
  const canReorder =
    selectedPlaylistId !== null && searchQuery.trim() === "" && !selectedIsSmart;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragFromRef = useRef<number | null>(null);

  const applyReorder = (from: number, to: number) => {
    if (
      from === to ||
      Number.isNaN(from) ||
      Number.isNaN(to) ||
      selectedPlaylistId === null
    )
      return;
    const ids = filtered.map((t) => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    reorder(selectedPlaylistId, ids);
  };

  // Reorder con pointer events (drag manual). El HTML5 drag-and-drop nativo no
  // funciona en el webview de macOS (WKWebView), así que lo hacemos a mano:
  // pointerdown en el handle ≡ → listeners en window para move/up → resolvemos
  // la fila bajo el cursor con elementFromPoint (data-row-index).
  const rowIndexUnderPointer = (x: number, y: number): number | null => {
    const row = document
      .elementFromPoint(x, y)
      ?.closest("tr[data-row-index]") as HTMLElement | null;
    if (!row) return null;
    const idx = Number(row.dataset.rowIndex);
    return Number.isNaN(idx) ? null : idx;
  };

  const onHandlePointerDown = (e: React.PointerEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation(); // no disparar playTrack del row
    dragFromRef.current = i;
    setDragIndex(i);
    setDragOverIndex(i);

    const onMove = (ev: PointerEvent) => {
      const idx = rowIndexUnderPointer(ev.clientX, ev.clientY);
      if (idx !== null) setDragOverIndex(idx);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const from = dragFromRef.current;
      dragFromRef.current = null;
      const to = rowIndexUnderPointer(ev.clientX, ev.clientY);
      setDragIndex(null);
      setDragOverIndex(null);
      if (from !== null && to !== null) applyReorder(from, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Popover de "add to playlist" — un popover global al table; el state
  // mantiene cuál track lo abrió y dónde está anclado.
  const [popoverState, setPopoverState] = useState<{
    trackId: number;
    trackTitle: string;
    anchorRect: DOMRect;
  } | null>(null);

  const onPlusClick = (e: React.MouseEvent, track: Track) => {
    e.stopPropagation(); // que no dispare playTrack del row.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopoverState({
      trackId: track.id,
      trackTitle: track.title,
      anchorRect: rect,
    });
  };

  const onRemoveFromPlaylistClick = async (
    e: React.MouseEvent,
    trackId: number,
  ) => {
    e.stopPropagation();
    if (selectedPlaylistId !== null) {
      await removeTrackFromPlaylist(selectedPlaylistId, trackId);
    }
  };

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
              {/* Handle de drag para reordenar — sólo en vista de playlist. */}
              {canReorder && <col className="w-8" />}
              {/* Columna ★ (favorito) — en TODA lista. */}
              <col className="w-8" />
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
              {/* Columna del botón + (add to playlist) o − (remove from
                  selected playlist). Ausente en smart playlists (read-only). */}
              {showMembershipCol && <col className="w-10" />}
            </colgroup>
            <thead className="sticky top-0 bg-bg">
              <tr className="border-b-2 border-fg text-muted">
                {canReorder && <th className="px-2 py-2" aria-label="Reorder" />}
                <th className="text-center px-1 py-2" title="Favorite">
                  ★
                </th>
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
                {showMembershipCol && (
                  <th
                    className="text-center px-3 py-2"
                    title="Add to / remove from playlist"
                  >
                    {selectedPlaylistId === null ? "+" : "−"}
                  </th>
                )}
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
                    data-row-index={i}
                    onClick={() => playTrack(t)}
                    className={`cursor-pointer border-b border-muted/40 ${
                      isCurrent
                        ? "bg-accent text-bg"
                        : "hover:bg-fg hover:text-bg"
                    } ${
                      canReorder && dragOverIndex === i && dragIndex !== i
                        ? "border-t-2 border-t-accent"
                        : ""
                    } ${canReorder && dragIndex === i ? "opacity-40" : ""}`}
                  >
                    {canReorder && (
                      // Handle de drag. onPointerDown arranca el arrastre
                      // manual; onClick stopPropaga para no disparar playTrack.
                      <td
                        className="px-2 py-2 text-center text-muted cursor-grab select-none touch-none"
                        onPointerDown={(e) => onHandlePointerDown(e, i)}
                        onClick={(e) => e.stopPropagation()}
                        title="Drag to reorder"
                      >
                        ≡
                      </td>
                    )}
                    {/* ★ Favorito — toggle. stopPropagation para no disparar
                        playTrack. Glyph lleno/vacío + color accent cuando está
                        marcado (inherit en la fila actual para contraste). */}
                    <td
                      className={`px-1 py-2 text-center cursor-pointer ${
                        isCurrent
                          ? ""
                          : t.isFavorite
                            ? "text-accent"
                            : "text-muted hover:text-accent"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFavorite(t.id, !t.isFavorite);
                      }}
                      title={t.isFavorite ? "Remove from favorites" : "Add to favorites"}
                    >
                      {t.isFavorite ? "★" : "☆"}
                    </td>
                    <td className="px-3 py-2 tabular-nums font-bold">
                      {isCurrent ? "►" : String(i + 1).padStart(2, "0")}
                    </td>
                    <td className="px-3 py-2 font-bold">
                      <LyricsIndicator
                        status={t.lyricsStatus}
                        isCurrent={isCurrent}
                        mismatchScore={t.mismatchScore}
                      />
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
                    {showMembershipCol && (
                      <td
                        className="px-3 py-2 text-center font-bold cursor-pointer hover:text-accent"
                        onClick={(e) =>
                          selectedPlaylistId === null
                            ? onPlusClick(e, t)
                            : onRemoveFromPlaylistClick(e, t.id)
                        }
                        title={
                          selectedPlaylistId === null
                            ? "Add to playlist"
                            : "Remove from playlist"
                        }
                      >
                        {selectedPlaylistId === null ? "+" : "−"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <AddToPlaylistPopover
        open={popoverState !== null}
        trackId={popoverState?.trackId ?? -1}
        trackTitle={popoverState?.trackTitle ?? ""}
        anchorRect={popoverState?.anchorRect ?? null}
        onClose={() => setPopoverState(null)}
      />
    </div>
  );
}
