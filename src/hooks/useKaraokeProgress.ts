import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Payload del evento `karaoke-progress` que emite el backend (whisperx.rs)
 *  por cada marcador `@@PROGRESS@@` de los scripts Python. */
export type KaraokeProgress = {
  trackId: number;
  op: "align" | "mismatch";
  /** Fase actual: loading_engine | detecting_language | loading_model |
   *  loading_align_model | transcribing | aligning | phonemizing | scoring */
  stage: string;
  /** Nombre del modelo que se carga (si aplica). */
  model?: string | null;
  /** true = va a descargar (no estaba cacheado), false = ya cacheado,
   *  null/undefined = no determinable → la UI muestra texto neutral. */
  downloading?: boolean | null;
};

/** Escucha el evento `karaoke-progress` y expone el último payload recibido.
 *  `reset()` lo limpia — el caller lo llama al arrancar un AUTO-ALIGN /
 *  CHECK QUALITY para que el progreso de la corrida anterior no quede pegado. */
export function useKaraokeProgress() {
  const [progress, setProgress] = useState<KaraokeProgress | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<KaraokeProgress>("karaoke-progress", (e) => {
      setProgress(e.payload);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  const reset = useCallback(() => setProgress(null), []);
  return { progress, reset };
}
