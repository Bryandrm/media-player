import { useEffect } from "react";
import {
  getAudioElement,
  getAudioElementA,
  getAudioElementB,
} from "../audio/element";
import { usePlayerStore } from "../stores/playerStore";

// Conecta los eventos de los dos `<audio>` singleton al playerStore. Se monta
// una sola vez en App. Atachamos a AMBOS audios (A y B) porque durante un
// crossfade los dos están reproduciendo simultáneamente — pero sólo el activo
// debe actualizar el store (el inactivo está fadeando out y sus eventos
// `timeupdate`/`ended` corresponden al track viejo, no al que el usuario
// está "escuchando" en su modelo mental).
export function useAudioPlayer() {
  useEffect(() => {
    const audioA = getAudioElementA();
    const audioB = getAudioElementB();

    // Sync inicial. `audio.volume`/`muted` quedan bypassed por Web Audio una
    // vez que el `<audio>` se conecta al grafo, pero los seteamos para no
    // engañar al inspector y por si en el futuro hay algún code path que los
    // use antes de que el grafo exista.
    const initial = usePlayerStore.getState();
    audioA.volume = initial.volume;
    audioA.muted = initial.muted;
    audioB.volume = initial.volume;
    audioB.muted = initial.muted;

    function attach(audio: HTMLAudioElement) {
      // Bail-out si no es el activo: durante crossfade evita que ambos canales
      // pisen el store con eventos contradictorios (currentTime de un track
      // vs. el otro, ended del track viejo, etc).
      const isActive = () => audio === getAudioElement();

      const onTime = () => {
        if (!isActive()) return;
        usePlayerStore.getState()._onTimeUpdate(audio.currentTime);
      };
      const onDuration = () => {
        if (!isActive()) return;
        usePlayerStore.getState()._onDuration(audio.duration || 0);
      };
      const onPlay = () => {
        if (!isActive()) return;
        usePlayerStore.getState()._onPlay();
      };
      const onPause = () => {
        if (!isActive()) return;
        usePlayerStore.getState()._onPause();
      };
      const onEnded = () => {
        if (!isActive()) return;
        usePlayerStore.getState()._onEnded();
      };

      audio.addEventListener("timeupdate", onTime);
      audio.addEventListener("durationchange", onDuration);
      audio.addEventListener("loadedmetadata", onDuration);
      audio.addEventListener("play", onPlay);
      audio.addEventListener("pause", onPause);
      audio.addEventListener("ended", onEnded);

      return () => {
        audio.removeEventListener("timeupdate", onTime);
        audio.removeEventListener("durationchange", onDuration);
        audio.removeEventListener("loadedmetadata", onDuration);
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("ended", onEnded);
      };
    }

    const detachA = attach(audioA);
    const detachB = attach(audioB);
    return () => {
      detachA();
      detachB();
    };
  }, []);
}
