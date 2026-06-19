import { useRef, useState } from "react";
import { usePlaylistStore } from "../../stores/playlistStore";
import type { Playlist } from "../../types";
import { Button } from "../ui/Button";
import { SmartPlaylistModal } from "./SmartPlaylistModal";

// Sidebar de playlists en la library view. Items:
//   - ALL TRACKS (default, selectedId=null) — muestra la library completa.
//   - Una fila por playlist con name + track_count.
//   - + NEW PLAYLIST → inline input para crear sin abrir modal.
//   - Doble-click en una playlist → editar el nombre inline.
//
// Brutalist: borde a la derecha (separa del table), filas con hover invert,
// item activo con bg-fg como las tabs. Sin iconos — todo texto.

export function PlaylistSidebar() {
  const playlists = usePlaylistStore((s) => s.playlists);
  const selectedId = usePlaylistStore((s) => s.selectedId);
  const select = usePlaylistStore((s) => s.select);
  const create = usePlaylistStore((s) => s.create);
  const remove = usePlaylistStore((s) => s.remove);
  const rename = usePlaylistStore((s) => s.rename);
  const exportM3u = usePlaylistStore((s) => s.exportM3u);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  // Modal de smart playlist: open + qué playlist se edita (null = crear nueva).
  const [smartModalOpen, setSmartModalOpen] = useState(false);
  const [editingSmart, setEditingSmart] = useState<Playlist | null>(null);

  const openCreateSmart = () => {
    setEditingSmart(null);
    setSmartModalOpen(true);
  };
  const openEditSmart = (p: Playlist) => {
    setEditingSmart(p);
    setSmartModalOpen(true);
  };

  // Rename inline: qué playlist se está editando + el valor en vuelo. Un solo
  // rename a la vez. `skipBlur` evita que el commit-on-blur se dispare cuando
  // el blur lo causó Enter (ya commiteó) o Escape (canceló) — sin esto, Escape
  // terminaría guardando igual.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const skipBlur = useRef(false);

  const startRename = (id: number, current: string) => {
    setEditingId(id);
    setEditName(current);
  };

  const submitRename = async () => {
    const id = editingId;
    if (id === null) return;
    const trimmed = editName.trim();
    setEditingId(null);
    setEditName("");
    // Vacío o sin cambios → no tocamos el backend.
    if (trimmed === "") return;
    await rename(id, trimmed);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditName("");
  };

  const onCreate = async () => {
    if (name.trim() === "") {
      setCreating(false);
      return;
    }
    const created = await create(name);
    setName("");
    setCreating(false);
    if (created) await select(created.id);
  };

  const onDelete = async (id: number, name: string) => {
    // Confirm: borrar una playlist NO borra los tracks, sólo la asociación
    // — pero el usuario puede no saberlo. Mensaje claro.
    if (
      !window.confirm(
        `DELETE PLAYLIST "${name}"?\n\nThe tracks themselves stay in your library.`,
      )
    ) {
      return;
    }
    await remove(id);
  };

  return (
    <aside className="w-56 shrink-0 border-r-2 border-fg flex flex-col">
      <div className="shrink-0 px-4 py-3 border-b-2 border-fg text-xs uppercase tracking-wider text-muted font-bold">
        PLAYLISTS
      </div>

      <div className="flex-1 overflow-auto">
        {/* ALL TRACKS pseudo-row */}
        <SidebarRow
          label="ALL TRACKS"
          count={null}
          active={selectedId === null}
          onClick={() => select(null)}
        />

        {playlists.length === 0 && (
          <div className="px-4 py-3 text-[10px] text-muted uppercase tracking-wider">
            NO PLAYLISTS YET
          </div>
        )}

        {playlists.map((p) =>
          editingId === p.id ? (
            <div key={p.id} className="px-3 py-1.5 border-b border-muted/30">
              <input
                autoFocus
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    skipBlur.current = true;
                    submitRename();
                  }
                  if (e.key === "Escape") {
                    skipBlur.current = true;
                    cancelRename();
                  }
                }}
                onBlur={() => {
                  // Commit-on-blur, salvo que Enter/Escape ya lo hayan resuelto.
                  if (skipBlur.current) {
                    skipBlur.current = false;
                    return;
                  }
                  submitRename();
                }}
                className="w-full bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-mono uppercase tracking-wider focus:outline-none focus:border-accent placeholder:text-muted"
                maxLength={64}
              />
            </div>
          ) : (
            <SidebarRow
              key={p.id}
              label={p.name}
              count={p.trackCount}
              active={selectedId === p.id}
              isSmart={p.isSmart}
              onClick={() => select(p.id)}
              onRename={() => startRename(p.id, p.name)}
              onDelete={() => onDelete(p.id, p.name)}
              onExport={
                p.trackCount > 0 ? () => exportM3u(p.id, p.name) : undefined
              }
              onEdit={p.isSmart ? () => openEditSmart(p) : undefined}
            />
          ),
        )}
      </div>

      <div className="shrink-0 border-t-2 border-fg p-3">
        {creating ? (
          // Input inline para crear sin modal — más rápido y se siente
          // brutalist (sin overlay decorativo).
          <div className="flex flex-col gap-2">
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreate();
                if (e.key === "Escape") {
                  setName("");
                  setCreating(false);
                }
              }}
              placeholder="PLAYLIST NAME"
              className="w-full bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-mono uppercase tracking-wider focus:outline-none focus:border-accent placeholder:text-muted"
              maxLength={64}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={onCreate}>
                CREATE
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setName("");
                  setCreating(false);
                }}
              >
                CANCEL
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Button size="sm" onClick={() => setCreating(true)}>
              + NEW PLAYLIST
            </Button>
            <Button size="sm" onClick={openCreateSmart}>
              + SMART ⚡
            </Button>
          </div>
        )}
      </div>

      <SmartPlaylistModal
        open={smartModalOpen}
        editing={editingSmart}
        onClose={() => setSmartModalOpen(false)}
      />
    </aside>
  );
}

function SidebarRow({
  label,
  count,
  active,
  isSmart = false,
  onClick,
  onRename,
  onDelete,
  onExport,
  onEdit,
}: {
  label: string;
  count: number | null;
  active: boolean;
  isSmart?: boolean;
  onClick: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  onEdit?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const showActions = (onDelete || onExport || onEdit) && hover;

  return (
    <button
      onClick={onClick}
      onDoubleClick={onRename}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={onRename ? "Double-click to rename" : undefined}
      className={`w-full text-left px-4 py-2 text-xs uppercase tracking-wider border-b border-muted/30 flex items-center gap-2 ${
        active ? "bg-fg text-bg font-bold" : "hover:bg-fg hover:text-bg"
      }`}
    >
      {/* Marcador ⚡ para smart playlists — read-only, tracks derivados de
          reglas. Se distingue de las normales sin recurrir a iconos pesados. */}
      {isSmart ? <span className="text-accent" title="Smart playlist">⚡</span> : null}
      <span className="truncate flex-1">{label}</span>
      {showActions ? (
        // Los spans actúan como botones secundarios sin anidar <button> (HTML
        // inválido). onClick stopPropaga para no triggear select del row.
        <span className="flex items-center gap-1.5">
          {onEdit ? (
            <span
              role="button"
              aria-label={`Edit ${label} rules`}
              title="Edit rules"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="font-bold cursor-pointer px-1 text-[10px] tracking-wide"
            >
              EDIT
            </span>
          ) : null}
          {onExport ? (
            <span
              role="button"
              aria-label={`Export ${label} to M3U`}
              title="Export to .m3u"
              onClick={(e) => {
                e.stopPropagation();
                onExport();
              }}
              className="font-bold cursor-pointer px-1 text-[10px] tracking-wide"
            >
              M3U
            </span>
          ) : null}
          {onDelete ? (
            <span
              role="button"
              aria-label={`Delete ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="text-accent font-bold cursor-pointer px-1"
            >
              ×
            </span>
          ) : null}
        </span>
      ) : count !== null ? (
        <span className={active ? "text-bg/70" : "text-muted"}>{count}</span>
      ) : null}
    </button>
  );
}
