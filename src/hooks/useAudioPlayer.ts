import { useEffect } from "react";
import { getAudioElement } from "../audio/element";
import { usePlayerStore } from "../stores/playerStore";

// Conecta los eventos del <audio> singleton al playerStore. Se monta una sola
// vez en App. También sincroniza volumen/mute persistidos al elemento real,
// que en el primer mount viene "limpio" (volume=1, muted=false).
export function useAudioPlayer() {
  useEffect(() => {
    const audio = getAudioElement();
    const initial = usePlayerStore.getState();
    audio.volume = initial.volume;
    audio.muted = initial.muted;

    const onTime = () => usePlayerStore.getState()._onTimeUpdate(audio.currentTime);
    const onDuration = () => usePlayerStore.getState()._onDuration(audio.duration || 0);
    const onPlay = () => usePlayerStore.getState()._onPlay();
    const onPause = () => usePlayerStore.getState()._onPause();
    const onEnded = () => usePlayerStore.getState()._onEnded();

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
  }, []);
}
