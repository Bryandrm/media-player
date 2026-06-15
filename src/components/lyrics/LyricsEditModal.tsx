import { useEffect, useState } from "react";
import { Button } from "../ui/Button";

// Modal de edición manual de letras (Lyrics Fase 2.c — punto 1).
//
// El usuario abre este modal cuando:
//   - LRCLIB devolvió letras que no matchean el audio (caso clásico:
//     versiones en vivo, ediciones extendidas, covers con letras parecidas
//     pero no idénticas → cae el forced alignment de whisperx por mismatch).
//   - El track quedó como `not_found` y querés agregar letras desde cero.
//   - Sólo hay plain y querés añadir versión synced a mano.
//
// Brutalist: dos textareas grandes (synced + plain), sin live preview de
// sync — el usuario re-aligns o ajusta offset/speed después si hace falta.
// El modal cierra con ESC o CANCEL; SAVE persiste y devuelve la fila fresca.

type Props = {
  open: boolean;
  initialSynced: string | null;
  initialPlain: string | null;
  trackTitle: string;
  trackArtist: string | null;
  onSave: (synced: string | null, plain: string | null) => Promise<void>;
  onClose: () => void;
};

export function LyricsEditModal({
  open,
  initialSynced,
  initialPlain,
  trackTitle,
  trackArtist,
  onSave,
  onClose,
}: Props) {
  const [synced, setSynced] = useState(initialSynced ?? "");
  const [plain, setPlain] = useState(initialPlain ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset cuando se abre con valores nuevos (cambio de track sin desmontar).
  useEffect(() => {
    if (open) {
      setSynced(initialSynced ?? "");
      setPlain(initialPlain ?? "");
      setError(null);
    }
  }, [open, initialSynced, initialPlain]);

  // ESC para cerrar — sólo cuando no estamos guardando, para no abortar
  // una persistencia en curso por accidente.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  if (!open) return null;

  const onSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      // Trim + treat empty as null para que el backend reciba NULL en vez
      // de strings vacías (limpia el state en DB y evita renderizar líneas
      // vacías al parsear el LRC).
      const syncedFinal = synced.trim() ? synced : null;
      const plainFinal = plain.trim() ? plain : null;
      await onSave(syncedFinal, plainFinal);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // bg-bg/95 da una sensación de modal sin tapar 100% — el usuario sigue
  // viendo el shell del player como contexto.
  return (
    <div className="fixed inset-0 z-50 bg-bg/95 flex items-center justify-center p-8">
      <div className="bg-bg border-2 border-fg w-full max-w-4xl max-h-[90vh] flex flex-col">
        <header className="shrink-0 px-6 py-3 border-b-2 border-fg flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold tracking-wider uppercase">
              EDIT LYRICS
            </h2>
            <p className="text-xs text-muted truncate">
              {trackTitle} — {trackArtist ?? "—"}
            </p>
          </div>
          <span className="text-muted text-xs uppercase tracking-wider shrink-0">
            ESC TO CLOSE
          </span>
        </header>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
          <section>
            <div className="text-xs uppercase tracking-wider text-muted mb-2 flex items-center justify-between">
              <span>SYNCED LYRICS — LRC FORMAT</span>
              <span className="text-fg tabular-nums">
                {synced.length} CHARS
              </span>
            </div>
            <textarea
              value={synced}
              onChange={(e) => setSynced(e.target.value)}
              placeholder={
                "[00:25.43]Come as you are, as you were\n" +
                "[00:30.21]As I want you to be\n" +
                "[00:35.10]As a friend, as a friend"
              }
              className="w-full bg-bg text-fg border-2 border-fg p-3 font-mono text-sm leading-relaxed h-64 resize-none focus:outline-none focus:border-accent"
              spellCheck={false}
              disabled={saving}
            />
            <p className="text-xs text-muted mt-2">
              Each line: <span className="text-fg">[mm:ss.cc]text</span>. Lines
              without a timestamp are ignored by the parser. Use brackets
              <span className="text-fg"> [00:44.62]</span> for instrumental
              breaks.
            </p>
          </section>

          <section>
            <div className="text-xs uppercase tracking-wider text-muted mb-2 flex items-center justify-between">
              <span>PLAIN LYRICS — FALLBACK</span>
              <span className="text-fg tabular-nums">
                {plain.length} CHARS
              </span>
            </div>
            <textarea
              value={plain}
              onChange={(e) => setPlain(e.target.value)}
              placeholder={"Come as you are, as you were\nAs I want you to be"}
              className="w-full bg-bg text-fg border-2 border-fg p-3 font-mono text-sm leading-relaxed h-32 resize-none focus:outline-none focus:border-accent"
              spellCheck={false}
              disabled={saving}
            />
            <p className="text-xs text-muted mt-2">
              Used when synced is empty. Optional.
            </p>
          </section>

          {error && (
            <div className="border-2 border-accent text-accent p-3 text-sm">
              ERROR: {error}
            </div>
          )}
        </div>

        <footer className="shrink-0 px-6 py-3 border-t-2 border-fg flex items-center justify-between gap-4 flex-wrap">
          <p className="text-xs text-muted uppercase tracking-wider">
            SAVING RESETS OFFSET · SPEED · FORCED ALIGNMENT
          </p>
          <div className="flex gap-2">
            <Button onClick={onClose} disabled={saving}>
              CANCEL
            </Button>
            <Button onClick={onSubmit} disabled={saving} variant="active">
              {saving ? "SAVING..." : "SAVE"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
