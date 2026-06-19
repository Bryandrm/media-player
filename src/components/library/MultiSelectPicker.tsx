import { useEffect, useMemo, useRef, useState } from "react";

// Picker brutalist multi-select para los smart playlists. Recibe la lista de
// opciones disponibles (calculada por el caller via playlist_smart_distinct_values)
// y la lista de seleccionadas; renderea un input de search + scroll con
// checkboxes. Devuelve los valores nuevos via onChange.
//
// Brutalist: borde 2px, sin radius. Search input sticky arriba. Lista
// scrollable con hover invert. Footer con count seleccionado + CLEAR ALL.
// No usa portal — está pensado para vivir inline en una fila del modal.
//
// Cuando `availableValues` está vacío el picker muestra "NO OPTIONS" en vez
// de quedarse en blanco — útil para que el usuario sepa si la cascada de
// reglas anteriores dejó nada.

type Props = {
  /** Lista de valores que el usuario podría elegir. Computada por el caller
   *  (cascading from playlist_smart_distinct_values). Lowercase para texto
   *  cuando viene de genre/MB; el caller hace title-case o no según prefiera. */
  availableValues: string[];
  /** Valores actualmente seleccionados. Subset de availableValues — pero
   *  toleramos que un valor seleccionado no esté en availableValues (caso
   *  edge: la cascada cambió y el valor previo ya no aplica). Esos los
   *  renderizamos al tope con marker. */
  selectedValues: string[];
  /** Callback al cambiar selección. Recibe el array nuevo (no diff). */
  onChange: (next: string[]) => void;
  /** Texto del placeholder del search input. */
  placeholder?: string;
  /** Loading externo (refetch en curso). Muestra "LOADING..." en vez de la
   *  lista para que el usuario sepa que cambió el prefilter. */
  loading?: boolean;
};

export function MultiSelectPicker({
  availableValues,
  selectedValues,
  onChange,
  placeholder = "FILTER...",
  loading = false,
}: Props) {
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Reset del search al cambiar la prop availableValues (típico cuando el
  // prefilter cambió y la lista entera se renovó). El search vacío hace que
  // se vea la lista nueva entera.
  useEffect(() => {
    setSearch("");
  }, [availableValues]);

  // Valores seleccionados que NO están en availableValues — render aparte al
  // tope para que el usuario los vea y pueda destildarlos. Sin esto, el
  // usuario perdería visibilidad de "tengo X seleccionado pero ya no aparece".
  const orphanSelected = useMemo(
    () => selectedValues.filter((v) => !availableValues.includes(v)),
    [selectedValues, availableValues],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return availableValues;
    return availableValues.filter((v) => v.toLowerCase().includes(q));
  }, [availableValues, search]);

  const isSelected = (v: string) => selectedValues.includes(v);

  const toggle = (v: string) => {
    if (isSelected(v)) {
      onChange(selectedValues.filter((x) => x !== v));
    } else {
      onChange([...selectedValues, v]);
    }
  };

  const clearAll = () => onChange([]);

  const allCount = availableValues.length + orphanSelected.length;
  const selectedCount = selectedValues.length;

  return (
    <div className="border-2 border-fg bg-bg flex flex-col text-xs w-full max-h-64">
      <div className="border-b-2 border-fg px-2 py-1">
        <input
          ref={searchInputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-bg text-fg px-1 py-1 font-mono uppercase tracking-wider outline-none placeholder:text-muted"
          spellCheck={false}
        />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="px-3 py-4 text-center text-muted uppercase tracking-wider">
            LOADING...
          </div>
        ) : allCount === 0 ? (
          <div className="px-3 py-4 text-center text-muted uppercase tracking-wider">
            NO OPTIONS
          </div>
        ) : (
          <>
            {/* Orphans primero, con marker '?' para indicar que el prefilter
                actual no los incluye pero siguen seleccionados. */}
            {orphanSelected.map((v) => (
              <PickerRow
                key={`orphan:${v}`}
                label={v}
                checked={true}
                orphan
                onToggle={() => toggle(v)}
              />
            ))}
            {filtered.map((v) => (
              <PickerRow
                key={v}
                label={v}
                checked={isSelected(v)}
                onToggle={() => toggle(v)}
              />
            ))}
            {filtered.length === 0 && search.trim() !== "" && (
              <div className="px-3 py-2 text-center text-muted uppercase tracking-wider">
                NO MATCHES FOR "{search}"
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t-2 border-fg px-2 py-1 flex items-center justify-between text-muted tabular-nums">
        <span>
          {selectedCount} / {allCount} SELECTED
        </span>
        {selectedCount > 0 && (
          <span
            role="button"
            onClick={clearAll}
            className="text-accent font-bold cursor-pointer uppercase tracking-wider"
          >
            CLEAR
          </span>
        )}
      </div>
    </div>
  );
}

function PickerRow({
  label,
  checked,
  orphan = false,
  onToggle,
}: {
  label: string;
  checked: boolean;
  orphan?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 border-b border-muted/30 hover:bg-fg hover:text-bg ${
        checked ? "font-bold" : ""
      }`}
    >
      {/* Checkbox visual: cuadrado 12x12 con borde, lleno cuando checked.
          Sin <input type="checkbox"> nativo para mantener la estética
          brutalist consistente con el resto de la app. */}
      <span
        aria-hidden="true"
        className={`inline-block w-3 h-3 border-2 border-current shrink-0 ${
          checked ? "bg-accent border-accent" : ""
        }`}
      />
      <span className="truncate flex-1 uppercase tracking-wider">{label}</span>
      {orphan && (
        <span className="text-muted text-[10px] tracking-wider" title="Not in current options">
          ?
        </span>
      )}
    </button>
  );
}
