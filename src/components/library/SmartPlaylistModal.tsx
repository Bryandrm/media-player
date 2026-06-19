import { useEffect, useState } from "react";
import { usePlaylistStore } from "../../stores/playlistStore";
import type {
  Playlist,
  SmartCondition,
  SmartField,
  SmartOp,
  SmartRules,
} from "../../types";
import { Button } from "../ui/Button";

// Editor de smart playlists (crear + editar reglas). Motor multi-regla: el
// usuario combina N condiciones con AND ("all") u OR ("any"). Cada condición es
// campo + operador + valor. La whitelist autoritativa de campos/operadores vive
// en el backend (db::smart); acá la espejamos para poblar los selects.
//
// Brutalist: backdrop opaco, card border-4 + shadow-hard, sin rounding. Escape
// cierra. Click en backdrop NO cierra (evita perder reglas a medio armar).

type FieldType = "text" | "number" | "days";

const FIELDS: { value: SmartField; label: string; type: FieldType }[] = [
  { value: "title", label: "TITLE", type: "text" },
  { value: "artist", label: "ARTIST", type: "text" },
  { value: "album", label: "ALBUM", type: "text" },
  { value: "genre", label: "GENRE", type: "text" },
  { value: "year", label: "YEAR", type: "number" },
  { value: "play_count", label: "PLAY COUNT", type: "number" },
  { value: "added_within_days", label: "ADDED IN LAST", type: "days" },
  { value: "played_within_days", label: "PLAYED IN LAST", type: "days" },
];

const TEXT_OPS: { value: SmartOp; label: string }[] = [
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
];

const NUM_OPS: { value: SmartOp; label: string }[] = [
  { value: "is", label: "=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
];

function fieldType(field: SmartField): FieldType {
  return FIELDS.find((f) => f.value === field)?.type ?? "text";
}

function opsFor(field: SmartField): { value: SmartOp; label: string }[] {
  return fieldType(field) === "text" ? TEXT_OPS : NUM_OPS;
}

// Default de operador al elegir un campo (el primero válido para su tipo).
function defaultOp(field: SmartField): SmartOp {
  return opsFor(field)[0].value;
}

const NEW_CONDITION: SmartCondition = { field: "genre", op: "is", value: "" };

export function SmartPlaylistModal({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  /** Playlist smart a editar, o null para crear una nueva. */
  editing: Playlist | null;
  onClose: () => void;
}) {
  const createSmart = usePlaylistStore((s) => s.createSmart);
  const updateSmart = usePlaylistStore((s) => s.updateSmart);
  const select = usePlaylistStore((s) => s.select);

  const [name, setName] = useState("");
  const [matchMode, setMatchMode] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<SmartCondition[]>([
    { ...NEW_CONDITION },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Inicializar al abrir: en modo edición parseamos las reglas existentes; en
  // modo creación arrancamos con una condición en blanco.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing && editing.rules) {
      try {
        const parsed = JSON.parse(editing.rules) as SmartRules;
        setMatchMode(parsed.match === "any" ? "any" : "all");
        setConditions(
          parsed.conditions.length > 0
            ? parsed.conditions.map((c) => ({ ...c }))
            : [{ ...NEW_CONDITION }],
        );
      } catch {
        setConditions([{ ...NEW_CONDITION }]);
      }
      setName(editing.name);
    } else {
      setName("");
      setMatchMode("all");
      setConditions([{ ...NEW_CONDITION }]);
    }
  }, [open, editing]);

  // Escape para cerrar — sólo cuando está visible.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const setCondition = (i: number, patch: Partial<SmartCondition>) => {
    setConditions((prev) =>
      prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    );
  };

  const onFieldChange = (i: number, field: SmartField) => {
    // Al cambiar de campo, el operador puede no aplicar al nuevo tipo: lo
    // reseteamos al default del tipo nuevo.
    setCondition(i, { field, op: defaultOp(field) });
  };

  const addCondition = () =>
    setConditions((prev) => [...prev, { ...NEW_CONDITION }]);

  const removeCondition = (i: number) =>
    setConditions((prev) => prev.filter((_, idx) => idx !== i));

  const onSave = async () => {
    const trimmedName = name.trim();
    if (!editing && trimmedName === "") {
      setError("Name cannot be empty.");
      return;
    }
    // Descartar condiciones con valor vacío. Para number/days, validar entero.
    const clean: SmartCondition[] = [];
    for (const c of conditions) {
      const v = c.value.trim();
      if (v === "") continue;
      const type = fieldType(c.field);
      if (type !== "text" && !Number.isInteger(Number(v))) {
        setError("Numeric/days conditions need a whole number.");
        return;
      }
      clean.push({ ...c, value: v });
    }
    if (clean.length === 0) {
      setError("Add at least one condition with a value.");
      return;
    }

    const rules: SmartRules = { match: matchMode, conditions: clean };
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateSmart(editing.id, rules);
      } else {
        const created = await createSmart(trimmedName, rules);
        if (created) await select(created.id);
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95">
      <div className="w-full max-w-2xl border-4 border-fg bg-bg shadow-[8px_8px_0_var(--fg)]">
        <div className="border-b-2 border-fg px-6 py-3">
          <h2 className="text-base font-bold tracking-wider uppercase">
            {editing ? `EDIT SMART // ${editing.name}` : "NEW SMART PLAYLIST"}
          </h2>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[60vh] overflow-auto">
          {!editing && (
            <div className="space-y-2">
              <label className="block text-xs font-bold tracking-wider uppercase text-muted">
                NAME
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="SMART PLAYLIST NAME"
                className="w-full bg-bg text-fg border-2 border-fg px-3 py-2 text-sm font-mono uppercase tracking-wider outline-none focus:border-accent placeholder:text-muted"
                autoFocus
                maxLength={64}
              />
            </div>
          )}

          {/* MATCH all/any */}
          <div className="flex items-center gap-3 text-xs uppercase tracking-wider">
            <span className="font-bold text-muted">MATCH</span>
            <select
              value={matchMode}
              onChange={(e) => setMatchMode(e.target.value as "all" | "any")}
              className="bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-bold uppercase outline-none focus:border-accent"
            >
              <option value="all">ALL</option>
              <option value="any">ANY</option>
            </select>
            <span className="font-bold text-muted">OF THE FOLLOWING:</span>
          </div>

          {/* Condiciones */}
          <div className="space-y-2">
            {conditions.map((c, i) => {
              const type = fieldType(c.field);
              return (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={c.field}
                    onChange={(e) =>
                      onFieldChange(i, e.target.value as SmartField)
                    }
                    className="bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-bold uppercase outline-none focus:border-accent"
                  >
                    {FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>

                  {/* Operador: sólo para text/number. Para days la semántica es
                      fija ("en los últimos N días"), no mostramos selector. */}
                  {type !== "days" ? (
                    <select
                      value={c.op}
                      onChange={(e) =>
                        setCondition(i, { op: e.target.value as SmartOp })
                      }
                      className="bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-bold uppercase outline-none focus:border-accent"
                    >
                      {opsFor(c.field).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : null}

                  <input
                    type={type === "text" ? "text" : "number"}
                    value={c.value}
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                    placeholder={type === "text" ? "value" : "0"}
                    className="flex-1 min-w-0 bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-mono outline-none focus:border-accent placeholder:text-muted"
                  />

                  {type === "days" ? (
                    <span className="text-xs font-bold uppercase text-muted">
                      DAYS
                    </span>
                  ) : null}

                  {/* Quitar condición (deshabilitado si es la única). */}
                  <span
                    role="button"
                    aria-label="Remove condition"
                    onClick={() =>
                      conditions.length > 1 ? removeCondition(i) : undefined
                    }
                    className={`px-2 font-bold ${
                      conditions.length > 1
                        ? "text-accent cursor-pointer"
                        : "text-muted cursor-not-allowed"
                    }`}
                  >
                    ×
                  </span>
                </div>
              );
            })}

            <Button size="sm" onClick={addCondition}>
              + ADD CONDITION
            </Button>
          </div>

          {error && <div className="text-sm text-accent font-bold">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-3 border-t-2 border-fg px-6 py-3">
          <Button onClick={onClose} disabled={saving}>
            CANCEL
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? "..." : editing ? "SAVE RULES" : "CREATE"}
          </Button>
        </div>
      </div>
    </div>
  );
}
