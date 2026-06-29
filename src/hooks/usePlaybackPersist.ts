import { useEffect, useRef } from "react";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";

// Persistencia del último track + posición entre sesiones. El target es
// "abro la app y el track donde quedé está cargado y seekeado, listo para
// hacer Space" — explícitamente NO auto-resume, eso sería sorpresivo
// (suena música de la nada cuando abrís un reproductor).
//
// Vive en localStorage como un solo blob, separado del `persist` middleware
// de Zustand (que ya tiene sus partializes con cosas que cambian poco como
// volume/muted). La posición se actualiza cada 5s y eso volaría el ratio
// señal/ruido del store persistido principal.

const STORAGE_KEY = "brutalist-player:resume";
const SAVE_INTERVAL_MS = 5000;

type Resume = { trackId: number; positionMs: number };

function readResume(): Resume | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Resume).trackId === "number" &&
      typeof (parsed as Resume).positionMs === "number"
    ) {
      return parsed as Resume;
    }
    return null;
  } catch {
    return null;
  }
}

function writeResume(r: Resume) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    // localStorage lleno o disabled — silent fail, no es crítico.
  }
}

/** Persiste la posición de reproducción AHORA (síncrono). Lo usa el botón
 *  RESET AUDIO antes de `restart_app`: el restart restaura el track + posición
 *  via el resume de arriba, así que forzamos un save exacto (en vez de perder
 *  hasta 5s del save periódico). */
export function persistResumeNow(): void {
  const s = usePlayerStore.getState();
  if (s.currentTrackId !== null) {
    writeResume({
      trackId: s.currentTrackId,
      positionMs: Math.floor(s.currentTime * 1000),
    });
  }
}

export function usePlaybackPersist() {
  const tracks = useLibraryStore((s) => s.tracks);
  const trackId = usePlayerStore((s) => s.currentTrackId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const appliedRef = useRef(false);
  // Para distinguir el primer "trackId pasa de null a algo" (que puede ser
  // tanto un click manual como un loadTrackForResume) de cambios posteriores.
  // En el primer cambio NO escribimos: si fue resume, currentTime puede
  // haber pasado por 0 brevemente (audio reset entre src= y loadedmetadata)
  // y guardar positionMs=0 ahí pisaría el valor real. Para clicks manuales
  // tampoco hace falta — la posición se guarda en el siguiente tick del
  // intervalo o en el primer pause.
  const firstTrackChangeRef = useRef(true);
  const prevPlayingRef = useRef(isPlaying);

  // Aplicar resume una vez, después de que la library esté cargada.
  useEffect(() => {
    if (appliedRef.current) return;
    if (tracks.length === 0) return;
    appliedRef.current = true;

    const resume = readResume();
    if (!resume) return;
    // Si el usuario ya empezó a usar el player antes de que tracks llegara
    // (improbable pero posible), respetamos su elección.
    if (usePlayerStore.getState().currentTrackId !== null) return;

    const track = tracks.find((t) => t.id === resume.trackId);
    if (!track) {
      // El track guardado fue removido o no está en esta library. No
      // borramos la key — el próximo write la sobreescribe.
      return;
    }

    usePlayerStore.getState().loadTrackForResume(track, resume.positionMs);
  }, [tracks]);

  // Save al cambiar de track (clicks, next, prev, auto-advance). Saltamos la
  // primera transición para no pisar el resume que recién aplicamos.
  useEffect(() => {
    if (firstTrackChangeRef.current) {
      firstTrackChangeRef.current = false;
      return;
    }
    if (trackId === null) return;
    writeResume({ trackId, positionMs: 0 });
  }, [trackId]);

  // Save al pasar de playing → paused. Captura el momento antes de cerrar
  // la app (si el usuario pausa antes de cerrar) y al final natural del
  // track (_onEnded setea isPlaying false).
  useEffect(() => {
    if (prevPlayingRef.current && !isPlaying) {
      const s = usePlayerStore.getState();
      if (s.currentTrackId !== null) {
        writeResume({
          trackId: s.currentTrackId,
          positionMs: Math.floor(s.currentTime * 1000),
        });
      }
    }
    prevPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Save periódico mientras suena. 5s es un balance: si el usuario cierra
  // sin pausar perdemos a lo sumo 5s de posición, y no spammeamos
  // localStorage cada 250ms (frecuencia típica de timeupdate).
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      const s = usePlayerStore.getState();
      if (!s.isPlaying || s.currentTrackId === null) return;
      writeResume({
        trackId: s.currentTrackId,
        positionMs: Math.floor(s.currentTime * 1000),
      });
    }, SAVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [isPlaying]);
}
