import { useEffect, useRef } from "react";
import { usePlaylistStore } from "../../stores/playlistStore";

// Popover anchorado al botón [+] de cada track. Lista las playlists del
// usuario; click → agrega ese track + cierra. Click fuera o ESC también cierra.
//
// Posicionamiento: el caller pasa `anchorRect` (typically getBoundingClientRect
// del botón) — el popover se posiciona justo abajo a la izquierda.
//
// Brutalist: borde 2px, sin border-radius, items con hover invert.

type Props = {
  open: boolean;
  trackId: number;
  trackTitle: string;
  anchorRect: DOMRect | null;
  onClose: () => void;
};

export function AddToPlaylistPopover({
  open,
  trackId,
  trackTitle,
  anchorRect,
  onClose,
}: Props) {
  const allPlaylists = usePlaylistStore((s) => s.playlists);
  const addTrack = usePlaylistStore((s) => s.addTrack);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sólo playlists normales: a una smart no se le agregan tracks a mano (su
  // membresía la deciden las reglas).
  const playlists = allPlaylists.filter((p) => !p.isSmart);

  // Click fuera del popover → cerrar. Pero NO si el click viene del botón
  // que disparó el open — ese caso es ambiguo (open+close en mismo tick).
  // El check de `e.target` contra el container resuelve eso.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // setTimeout para evitar capturar el mismo click que abrió el popover.
    const t = window.setTimeout(() => {
      document.addEventListener("click", onDocClick);
    }, 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  // Posicionamiento. Si el popover se saldría del viewport por la derecha,
  // lo alineamos por la derecha del anchor en vez de la izquierda.
  const POPOVER_WIDTH = 240;
  const VIEWPORT_PADDING = 8;
  const viewportW =
    typeof window !== "undefined" ? window.innerWidth : 1200;
  const leftDefault = anchorRect.left;
  const wouldOverflow = leftDefault + POPOVER_WIDTH > viewportW - VIEWPORT_PADDING;
  const left = wouldOverflow
    ? anchorRect.right - POPOVER_WIDTH
    : leftDefault;
  const top = anchorRect.bottom + 4;

  const onPick = async (playlistId: number) => {
    await addTrack(playlistId, trackId);
    onClose();
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        top,
        left,
        width: POPOVER_WIDTH,
        zIndex: 60,
      }}
      className="bg-bg border-2 border-fg shadow-[4px_4px_0_var(--color-fg)]"
    >
      <div className="px-3 py-2 border-b-2 border-fg text-[10px] uppercase tracking-wider text-muted">
        ADD TO PLAYLIST
      </div>

      <div className="px-3 py-1 text-[10px] text-muted truncate" title={trackTitle}>
        {trackTitle}
      </div>

      <div className="max-h-64 overflow-auto">
        {playlists.length === 0 ? (
          <div className="px-3 py-3 text-[10px] text-muted uppercase tracking-wider">
            NO PLAYLISTS YET. CREATE ONE FIRST.
          </div>
        ) : (
          playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className="w-full text-left px-3 py-2 text-xs uppercase tracking-wider border-b border-muted/30 hover:bg-fg hover:text-bg flex items-center gap-2"
            >
              <span className="truncate flex-1">{p.name}</span>
              <span className="text-muted">{p.trackCount}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
