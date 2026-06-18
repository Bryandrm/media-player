import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useIdentificationStore } from "../../stores/identificationStore";
import { Button } from "../ui/Button";

// Modal one-shot para configurar la API key de AcoustID. Se dispara desde
// el click en IDENTIFY cuando todavía no hay key configurada (Fase 1 — no
// tenemos SETTINGS view full).
//
// Brutalist: backdrop opaco, card central con border-4 + shadow-hard, sin
// rounding. Escape cierra. Click en backdrop NO cierra (defensivo — evita
// perder el input pegado por accidente al click-fuera).

export function ApiKeyModal() {
  const open_ = useIdentificationStore((s) => s.apiKeyModalOpen);
  const close = useIdentificationStore((s) => s.closeApiKeyModal);
  const currentKey = useIdentificationStore((s) => s.apiKey);
  const setApiKey = useIdentificationStore((s) => s.setApiKey);
  const lastError = useIdentificationStore((s) => s.lastError);

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resetear draft cuando se abre con la key actual (vacía o no). Si se reabrió
  // porque AcoustID rechazó la key, mostramos ese motivo arriba.
  useEffect(() => {
    if (open_) {
      setDraft(currentKey ?? "");
      const rejected =
        lastError && lastError.toLowerCase().includes("api key is invalid");
      setError(rejected ? lastError : null);
    }
  }, [open_, currentKey, lastError]);

  // Escape para cerrar — sólo cuando está visible para no consumir el
  // event globalmente.
  useEffect(() => {
    if (!open_) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open_, close]);

  if (!open_) return null;

  const onSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("API key cannot be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setApiKey(trimmed);
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const onOpenSignup = (e: React.MouseEvent) => {
    e.preventDefault();
    void openUrl("https://acoustid.org/new-application");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95">
      <div className="w-full max-w-xl border-4 border-fg bg-bg shadow-[8px_8px_0_var(--fg)]">
        <div className="border-b-2 border-fg px-6 py-3">
          <h2 className="text-base font-bold tracking-wider uppercase">
            ACOUSTID API KEY
          </h2>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm">
            To identify tracks, paste your AcoustID API key below. The key
            stays on your machine — we never bundle one or send it anywhere
            besides the AcoustID API.
          </p>
          <p className="text-sm">
            Don&apos;t have one? Get one free at{" "}
            <button
              type="button"
              onClick={onOpenSignup}
              className="text-accent underline font-bold"
            >
              acoustid.org/new-application
            </button>
            . You&apos;ll need a MusicBrainz account first (also free).
          </p>
          <p className="text-xs text-muted">
            Use the <span className="font-bold">Application API key</span> from
            registering an app — not the personal/account API key (the account
            key is for submitting fingerprints and will be rejected here).
          </p>

          <div className="space-y-2">
            <label className="block text-xs font-bold tracking-wider uppercase text-muted">
              API KEY
            </label>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="paste your key here"
              className="w-full bg-bg text-fg border-2 border-fg px-3 py-2 text-sm font-mono outline-none focus:border-accent"
              autoFocus
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>

          {error && (
            <div className="text-sm text-accent font-bold">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t-2 border-fg px-6 py-3">
          <Button onClick={close} disabled={saving}>
            CANCEL
          </Button>
          <Button onClick={onSave} disabled={saving || !draft.trim()}>
            {saving ? "..." : "SAVE"}
          </Button>
        </div>
      </div>
    </div>
  );
}
