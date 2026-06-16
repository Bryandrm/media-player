import { useState } from "react";
import { usePlaylistStore } from "../../stores/playlistStore";
import { Button } from "../ui/Button";

// Sidebar de playlists en la library view. Items:
//   - ALL TRACKS (default, selectedId=null) — muestra la library completa.
//   - Una fila por playlist con name + track_count.
//   - + NEW PLAYLIST → inline input para crear sin abrir modal.
//
// Brutalist: borde a la derecha (separa del table), filas con hover invert,
// item activo con bg-fg como las tabs. Sin iconos — todo texto.

export function PlaylistSidebar() {
  const playlists = usePlaylistStore((s) => s.playlists);
  const selectedId = usePlaylistStore((s) => s.selectedId);
  const select = usePlaylistStore((s) => s.select);
  const create = usePlaylistStore((s) => s.create);
  const remove = usePlaylistStore((s) => s.remove);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

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

        {playlists.map((p) => (
          <SidebarRow
            key={p.id}
            label={p.name}
            count={p.trackCount}
            active={selectedId === p.id}
            onClick={() => select(p.id)}
            onDelete={() => onDelete(p.id, p.name)}
          />
        ))}
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
          <Button size="sm" onClick={() => setCreating(true)}>
            + NEW PLAYLIST
          </Button>
        )}
      </div>
    </aside>
  );
}

function SidebarRow({
  label,
  count,
  active,
  onClick,
  onDelete,
}: {
  label: string;
  count: number | null;
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const showDelete = onDelete && hover;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`w-full text-left px-4 py-2 text-xs uppercase tracking-wider border-b border-muted/30 flex items-center gap-2 ${
        active ? "bg-fg text-bg font-bold" : "hover:bg-fg hover:text-bg"
      }`}
    >
      <span className="truncate flex-1">{label}</span>
      {showDelete ? (
        // El span actúa como botón secundario sin anidar <button> (HTML
        // inválido). onClick stopPropaga para no triggear select del row.
        <span
          role="button"
          aria-label={`Delete ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete?.();
          }}
          className="text-accent font-bold cursor-pointer px-1"
        >
          ×
        </span>
      ) : count !== null ? (
        <span className={active ? "text-bg/70" : "text-muted"}>{count}</span>
      ) : null}
    </button>
  );
}
