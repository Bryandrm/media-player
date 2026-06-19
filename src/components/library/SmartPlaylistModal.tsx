import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlaylistStore } from "../../stores/playlistStore";
import type {
  Playlist,
  SmartCondition,
  SmartField,
  SmartOp,
  SmartRules,
} from "../../types";
import { Button } from "../ui/Button";
import { MultiSelectPicker } from "./MultiSelectPicker";

// Editor de smart playlists (crear + editar reglas). Motor multi-regla: el
// usuario combina N condiciones con AND ("all") u OR ("any"). Cada condición es
// campo + operador + valor.
//
// Picker cascadante: para campos con valores discretos (artist, album, genre,
// year, play_count), el "value" es un MultiSelectPicker que se popula con los
// valores reales presentes en la library, filtrados por las reglas anteriores
// (en modo "all"). El usuario marca uno o varios → genera op `in`.
//
// Para los operadores de texto libre (`contains`, `is`, `is_not`,
// `not_contains`) sigue habiendo input de texto — útil para substring match o
// para valores que el picker no muestra (genre raros, typos intencionales).
//
// Para fields numéricos (year, play_count) con operadores relacionales
// (gt/lt/gte/lte), sigue habiendo input numérico.
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

// Operadores que usan input de TEXTO libre (no picker). Para text fields.
const TEXT_FREE_OPS: { value: SmartOp; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
];

// Operadores que usan MultiSelectPicker. Para text fields.
const TEXT_LIST_OPS: { value: SmartOp; label: string }[] = [
  { value: "in", label: "is one of" },
  { value: "not_in", label: "is none of" },
];

// Operadores numéricos relacionales (input numérico simple).
const NUM_REL_OPS: { value: SmartOp; label: string }[] = [
  { value: "is", label: "=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
];

// Operadores numéricos multi-valor (picker).
const NUM_LIST_OPS: { value: SmartOp; label: string }[] = [
  { value: "in", label: "is one of" },
  { value: "not_in", label: "is none of" },
];

function fieldType(field: SmartField): FieldType {
  return FIELDS.find((f) => f.value === field)?.type ?? "text";
}

function opsFor(field: SmartField): { value: SmartOp; label: string }[] {
  const type = fieldType(field);
  if (type === "text") return [...TEXT_LIST_OPS, ...TEXT_FREE_OPS];
  if (type === "number") return [...NUM_LIST_OPS, ...NUM_REL_OPS];
  return []; // days no usa selector de operador
}

// Default de operador al elegir un campo: el primero válido para su tipo. Para
// text/number es ahora `in` (multi-select picker) — UX por default debería ser
// pick-from-list, no escribir literal.
function defaultOp(field: SmartField): SmartOp {
  const type = fieldType(field);
  if (type === "text") return "in";
  if (type === "number") return "in";
  return "is"; // days — se ignora pero algo hay que mandar
}

// ¿El operador usa MultiSelectPicker (multi-valor JSON array) o input libre?
function isListOp(op: SmartOp): boolean {
  return op === "in" || op === "not_in";
}

const NEW_CONDITION: SmartCondition = {
  field: "artist",
  op: "in",
  value: "[]",
};

// Helpers para (de)serializar el value de un picker. Para op `in`/`not_in`,
// value es un JSON array de strings. Para text fields recibimos lowercase
// (genre, artist, etc.), pero título-case el render si querés. Acá lo dejamos
// tal cual viene de la DB.
function decodeListValue(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
    return [];
  } catch {
    return [];
  }
}

function encodeListValue(values: string[]): string {
  return JSON.stringify(values);
}

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

  // Cache de valores por field — cuando el prefilter cambia, lo invalidamos
  // (refetcheamos). Key: `${field}|${prefilterRulesJson}`.
  const [distinctCache, setDistinctCache] = useState<Record<string, string[]>>({});
  const [loadingFields, setLoadingFields] = useState<Set<string>>(new Set());

  // Inicializar al abrir.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDistinctCache({});
    setLoadingFields(new Set());
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

  // Escape para cerrar.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Compute el prefilter para una condición dada (las otras condiciones).
  // En modo "all" (AND), el prefilter son TODAS las otras condiciones —
  // restringe la lista del picker. En modo "any" (OR), las condiciones son
  // independientes → sin prefilter (cada picker ve el universo completo).
  const buildPrefilterJson = useCallback(
    (excludeIndex: number): string | null => {
      if (matchMode === "any") return null;
      const others = conditions.filter((_, i) => i !== excludeIndex);
      if (others.length === 0) return null;
      const rules: SmartRules = { match: "all", conditions: others };
      return JSON.stringify(rules);
    },
    [matchMode, conditions],
  );

  // Fetcheo de valores distintos para una condición. Cachea por (field +
  // prefilter). Si ya está cacheado, no refetchea.
  const fetchDistinct = useCallback(
    async (field: SmartField, prefilterJson: string | null) => {
      const cacheKey = `${field}|${prefilterJson ?? ""}`;
      if (distinctCache[cacheKey] !== undefined) return;

      setLoadingFields((prev) => {
        const next = new Set(prev);
        next.add(cacheKey);
        return next;
      });

      try {
        const values = await invoke<string[]>("playlist_smart_distinct_values", {
          field,
          prefilterRulesJson: prefilterJson,
        });
        setDistinctCache((prev) => ({ ...prev, [cacheKey]: values }));
      } catch (e) {
        console.warn(`distinct_values failed for ${field}:`, e);
        setDistinctCache((prev) => ({ ...prev, [cacheKey]: [] }));
      } finally {
        setLoadingFields((prev) => {
          const next = new Set(prev);
          next.delete(cacheKey);
          return next;
        });
      }
    },
    [distinctCache],
  );

  // Trigger fetch para cada condición que usa picker. useEffect con
  // dependencia en conditions + matchMode → re-fetchea cuando alguien cambia.
  useEffect(() => {
    if (!open) return;
    conditions.forEach((c, i) => {
      if (!isListOp(c.op)) return;
      const prefilterJson = buildPrefilterJson(i);
      void fetchDistinct(c.field, prefilterJson);
    });
  }, [open, conditions, matchMode, buildPrefilterJson, fetchDistinct]);

  if (!open) return null;

  const setCondition = (i: number, patch: Partial<SmartCondition>) => {
    setConditions((prev) =>
      prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    );
  };

  const onFieldChange = (i: number, field: SmartField) => {
    const op = defaultOp(field);
    const value = isListOp(op) ? "[]" : "";
    setCondition(i, { field, op, value });
  };

  const onOpChange = (i: number, op: SmartOp) => {
    // Al cambiar de operador, si el shape del value cambia (list ↔ free), lo
    // reseteamos para evitar value-shape mismatch.
    const prev = conditions[i];
    const wasList = isListOp(prev.op);
    const willList = isListOp(op);
    if (wasList !== willList) {
      setCondition(i, { op, value: willList ? "[]" : "" });
    } else {
      setCondition(i, { op });
    }
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
    // Descartar condiciones sin valor útil:
    //   - list ops: array vacío (`[]`).
    //   - text free: string trim vacía.
    //   - number/days: no parsea a entero.
    const clean: SmartCondition[] = [];
    for (const c of conditions) {
      const type = fieldType(c.field);
      if (isListOp(c.op)) {
        const list = decodeListValue(c.value);
        if (list.length === 0) continue;
        clean.push({ ...c, value: encodeListValue(list) });
      } else if (type === "text") {
        const v = c.value.trim();
        if (v === "") continue;
        clean.push({ ...c, value: v });
      } else {
        const v = c.value.trim();
        if (v === "") continue;
        if (!Number.isInteger(Number(v))) {
          setError("Numeric/days conditions need a whole number.");
          return;
        }
        clean.push({ ...c, value: v });
      }
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
      <div className="w-full max-w-3xl border-4 border-fg bg-bg shadow-[8px_8px_0_var(--fg)]">
        <div className="border-b-2 border-fg px-6 py-3">
          <h2 className="text-base font-bold tracking-wider uppercase">
            {editing ? `EDIT SMART // ${editing.name}` : "NEW SMART PLAYLIST"}
          </h2>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-auto">
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
            {matchMode === "all" && conditions.length > 1 && (
              <span className="text-muted text-[10px] ml-auto">
                PICKERS CASCADE: EACH OPTION SET REFLECTS THE OTHER CONDITIONS
              </span>
            )}
          </div>

          {/* Condiciones */}
          <div className="space-y-3">
            {conditions.map((c, i) => {
              const type = fieldType(c.field);
              const listMode = isListOp(c.op);
              const prefilterJson = buildPrefilterJson(i);
              const cacheKey = `${c.field}|${prefilterJson ?? ""}`;
              const available = distinctCache[cacheKey] ?? [];
              const loading = loadingFields.has(cacheKey);

              return (
                <div
                  key={i}
                  className="border-2 border-fg/60 p-3 flex flex-col gap-2"
                >
                  <div className="flex items-center gap-2 flex-wrap">
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

                    {type !== "days" && (
                      <select
                        value={c.op}
                        onChange={(e) => onOpChange(i, e.target.value as SmartOp)}
                        className="bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-bold uppercase outline-none focus:border-accent"
                      >
                        {opsFor(c.field).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}

                    {/* Input para días: número simple + label "DAYS". */}
                    {type === "days" && (
                      <>
                        <input
                          type="number"
                          value={c.value}
                          onChange={(e) =>
                            setCondition(i, { value: e.target.value })
                          }
                          placeholder="0"
                          className="flex-1 min-w-[80px] bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-mono outline-none focus:border-accent placeholder:text-muted"
                        />
                        <span className="text-xs font-bold uppercase text-muted">
                          DAYS
                        </span>
                      </>
                    )}

                    {/* Input free-text para ops `contains`/`not_contains`/etc. */}
                    {type !== "days" && !listMode && (
                      <input
                        type={type === "text" ? "text" : "number"}
                        value={c.value}
                        onChange={(e) =>
                          setCondition(i, { value: e.target.value })
                        }
                        placeholder={type === "text" ? "value" : "0"}
                        className="flex-1 min-w-[120px] bg-bg text-fg border-2 border-fg px-2 py-1 text-xs font-mono outline-none focus:border-accent placeholder:text-muted"
                      />
                    )}

                    {/* Quitar condición (deshabilitado si es la única). */}
                    <span
                      role="button"
                      aria-label="Remove condition"
                      onClick={() =>
                        conditions.length > 1 ? removeCondition(i) : undefined
                      }
                      className={`ml-auto px-2 font-bold ${
                        conditions.length > 1
                          ? "text-accent cursor-pointer"
                          : "text-muted cursor-not-allowed"
                      }`}
                    >
                      ×
                    </span>
                  </div>

                  {/* Picker en otra row (full width) cuando es list op */}
                  {type !== "days" && listMode && (
                    <MultiSelectPicker
                      availableValues={available}
                      selectedValues={decodeListValue(c.value)}
                      onChange={(next) =>
                        setCondition(i, { value: encodeListValue(next) })
                      }
                      loading={loading}
                      placeholder={`FILTER ${c.field.toUpperCase()}...`}
                    />
                  )}
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
