import { useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";

// MediaSession API: integra con el OS para que las teclas multimedia del
// teclado (F7/F8/F9 con icons de play/skip en macOS), Control Center,
// lock screen y AirPods/Bluetooth headphones controlen el reproductor.
//
// TODO(windows): probado en macOS (2026-05). En Windows 10/11 la integración
// con SMTC (System Media Transport Controls) usa la misma API browser, pero
// hay que verificar que las media keys del teclado lleguen al WebView2
// correctamente — algunas distros de Windows requieren que el app esté
// declarado como "background audio capable" en el manifest. Si no funciona,
// el fix probable es Tauri global-shortcut plugin con las virtual-key codes
// VK_MEDIA_PLAY_PAUSE / VK_MEDIA_NEXT_TRACK / VK_MEDIA_PREV_TRACK.
//
// Cómo funciona en macOS:
// - El sistema operativo mantiene un "media app" actualmente activo. Cuando
//   nuestro <audio> empieza a reproducir, el OS nos registra como ese app.
// - playbackState le dice al OS si estamos playing/paused — basado en eso
//   decide qué action mandar cuando se aprieta play/pause (si playbackState=
//   playing → manda 'pause'; si paused → manda 'play').
// - metadata se muestra en el widget Now Playing y lock screen.
//
// Sin Tauri plugin: la API browser ya hace todo el trabajo. Tauri-plugin-
// global-shortcut no es la herramienta correcta para teclas multimedia en
// macOS — esas teclas son special function keys que el OS rutea via el
// sistema de media sessions, no via global shortcuts genéricos.
export function useMediaSession() {
  const trackId = usePlayerStore((s) => s.currentTrackId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const tracks = useLibraryStore((s) => s.tracks);

  // Action handlers — se setean una vez. Llaman al store via getState() para
  // evitar closures sobre estado stale (los handlers viven mientras la app
  // exista; el state que leen tiene que ser el actual al momento del key
  // press, no al momento del setActionHandler).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;

    // togglePlay() ya branchea sobre isPlaying — sirve tanto para 'play' como
    // 'pause'. El OS nos manda el correcto basado en playbackState.
    ms.setActionHandler("play", () => {
      usePlayerStore.getState().togglePlay();
    });
    ms.setActionHandler("pause", () => {
      usePlayerStore.getState().togglePlay();
    });
    ms.setActionHandler("nexttrack", () => {
      usePlayerStore.getState().next();
    });
    ms.setActionHandler("previoustrack", () => {
      usePlayerStore.getState().prev();
    });

    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("previoustrack", null);
    };
  }, []);

  // Metadata sincronizado con el track actual. Lo mira el OS para el widget
  // Now Playing, lock screen, etc. Re-corre cuando cambia trackId o cuando
  // cambia la lista (caso del backfill de cover art que repuebla el track
  // con una imagen nueva).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (trackId === null) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return;

    const artwork: MediaImage[] = track.coverArtPath
      ? [
          {
            src: convertFileSrc(track.coverArtPath),
            sizes: "512x512",
          },
        ]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? "",
      album: track.album ?? "",
      artwork,
    });
  }, [trackId, tracks]);

  // playbackState: el OS lo usa para decidir qué action mandar cuando se
  // aprieta play/pause y para mostrar el icon correcto en el widget Now
  // Playing. Sin esto, el OS no sabe en qué estado estamos.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);
}
