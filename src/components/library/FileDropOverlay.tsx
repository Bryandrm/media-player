import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useLibraryStore } from "../../stores/libraryStore";

// Overlay de drag & drop de archivos. Escucha el drag-drop **nativo de Tauri**
// (que entrega los paths reales del filesystem — distinto del HTML5 DnD, que no
// funciona en WKWebView, y del pointer-events del reorder de playlists; los
// tres conviven). Al soltar, importa los paths a la library vía
// `library_import_paths`. Se monta una vez en App; el overlay sólo se renderiza
// mientras se arrastra algo encima.
export function FileDropOverlay() {
  const importPaths = useLibraryStore((s) => s.importPaths);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragging(true);
        } else if (p.type === "leave") {
          setDragging(false);
        } else if (p.type === "drop") {
          setDragging(false);
          if (p.paths.length > 0) void importPaths(p.paths);
        }
      })
      .then((fn) => {
        // Si el efecto se desmontó antes de resolver, limpiamos al toque.
        if (active) unlisten = fn;
        else fn();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [importPaths]);

  if (!dragging) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/90 border-4 border-accent pointer-events-none">
      <div className="text-center">
        <div className="text-2xl font-bold tracking-widest uppercase text-accent">
          DROP TO IMPORT
        </div>
        <div className="mt-2 text-xs uppercase tracking-wider text-muted">
          archivos de audio o carpetas
        </div>
      </div>
    </div>
  );
}
