import { create } from "zustand";
import { persist } from "zustand/middleware";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  getAudioElement,
  getActiveChannelId,
  setActiveChannelId,
  getInactiveAudioElement,
  getInactiveChannelId,
} from "../audio/element";
import {
  getAudioContext,
  getChannel,
  getMasterGain,
  fadeInPlayPause,
  fadeOutPlayPause,
} from "../audio/context";
import { filterTracks } from "../lib/search";
import { useLibraryStore } from "./libraryStore";
import type { Track } from "../types";

// Pasos del crossfade. 0=off, 3/6/12s. El botón XFADE en PlayerBar cicla
// entre estos valores.
export const CROSSFADE_STEPS_MS = [0, 3000, 6000, 12000] as const;

type PlayerState = {
  currentTrackId: number | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  /** Duración del crossfade en ms. 0 = off. Se persiste. */
  crossfadeMs: number;
  /** True mientras corre un crossfade — dos audios en simultáneo, gain ramps
   *  activos, hasta que `setTimeout(finishCrossfade)` cierre. Ephemeral. */
  _isCrossfading: boolean;
  /** Stack de trackIds reproducidos, más recientes al final. Se usa para que
   *  `prev` en modo shuffle te lleve al track previo real, no a otro random.
   *  No se persiste — un reload reinicia el stack. */
  playHistory: number[];

  playTrack: (track: Track) => void;
  /** Carga un track + hace seek a `positionMs` PERO no reproduce. Pensado para
   *  restaurar estado al boot — auto-play sin user gesture es sorpresivo y
   *  además el AudioContext nace 'suspended' sin gesture. */
  loadTrackForResume: (track: Track, positionMs: number) => void;
  togglePlay: () => Promise<void>;
  seek: (time: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  /** Cicla `crossfadeMs` por `CROSSFADE_STEPS_MS`. */
  cycleCrossfade: () => void;
  next: () => void;
  prev: () => void;

  // Internal sync — wired by useAudioPlayer. Prefijo `_` para indicar
  // que no son acciones de UI: las llama el adaptador de eventos.
  _onTimeUpdate: (t: number) => void;
  _onDuration: (d: number) => void;
  _onPlay: () => void;
  _onPause: () => void;
  _onEnded: () => void;
};

const ignoreAbort = (e: unknown) => {
  if ((e as DOMException)?.name === "AbortError") return;
  console.error("audio play failed:", e);
};

const HISTORY_CAP = 64;

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {
      // Timer del cleanup post-crossfade. Vive en closure de la factory (no
      // en state) para no forzar re-renders. Se limpia en cancel + replace.
      let crossfadeTimerId: number | null = null;

      const clearCrossfadeTimer = () => {
        if (crossfadeTimerId !== null) {
          window.clearTimeout(crossfadeTimerId);
          crossfadeTimerId = null;
        }
      };

      // Cancela un crossfade en vuelo: snap hard a (active=1, inactive=0),
      // pausa el inactivo, limpia su src. Llamado desde acciones manuales
      // (playTrack/prev/loadTrackForResume) — el usuario está cambiando de
      // track explícitamente, así que un click de discontinuidad de gain es
      // preferible a tener dos canales sonando mientras transicionamos.
      const cancelCrossfade = () => {
        if (!get()._isCrossfading) return;
        clearCrossfadeTimer();
        const ctx = getAudioContext();
        const t = ctx.currentTime;
        const active = getChannel(getActiveChannelId());
        const inactive = getChannel(getInactiveChannelId());

        active.gain.gain.cancelScheduledValues(t);
        active.gain.gain.setValueAtTime(1, t);
        inactive.gain.gain.cancelScheduledValues(t);
        inactive.gain.gain.setValueAtTime(0, t);

        const inactiveAudio = inactive.audio;
        inactiveAudio.pause();
        inactiveAudio.removeAttribute("src");
        // load() fuerza el reset del media element — sin esto, algunos
        // browsers mantienen estado del src previo (buffer en memoria, etc).
        inactiveAudio.load();

        set({ _isCrossfading: false });
      };

      // Cleanup post-crossfade: el ramp ya llegó a (active=1, inactive=0),
      // pausamos el viejo y limpiamos su src para que esté listo para el
      // próximo crossfade.
      const finishCrossfade = () => {
        crossfadeTimerId = null;
        if (!get()._isCrossfading) return;
        const ctx = getAudioContext();
        const t = ctx.currentTime;
        const old = getChannel(getInactiveChannelId());

        // Snap defensivo (float precision del ramp).
        old.gain.gain.cancelScheduledValues(t);
        old.gain.gain.setValueAtTime(0, t);

        old.audio.pause();
        old.audio.removeAttribute("src");
        old.audio.load();

        set({ _isCrossfading: false });
      };

      const ensureGraphRunning = async () => {
        const ctx = getAudioContext();
        if (ctx.state === "suspended") {
          await ctx.resume().catch(() => {});
        }
        const { volume, muted } = get();
        getMasterGain().gain.value = muted ? 0 : volume;
      };

      // Carga + reproduce un track sin tocar el playHistory. La usan tanto
      // playTrack (que primero pushea al historial) como prev (que pop-ea).
      const loadAndPlay = (track: Track) => {
        cancelCrossfade();
        const audio = getAudioElement();
        audio.src = convertFileSrc(track.filePath);
        set({ currentTrackId: track.id, currentTime: 0, duration: 0 });
        audio.play().catch(ignoreAbort);
        ensureGraphRunning();
        // Fade-in 0→1 (o desde valor actual si veníamos de un fade-out a
        // medio camino). En el caso normal de auto-advance entre tracks
        // (gain ya en 1), es no-op porque ramp 1→1 no hace nada.
        fadeInPlayPause();
      };

      // Devuelve un track random distinto al actual. Usado por next() en
      // modo shuffle. La pool es la queue actual (respeta filtro de search).
      const pickRandomTrack = (
        queue: Track[],
        currentId: number | null,
      ): Track | undefined => {
        if (queue.length === 0) return undefined;
        if (queue.length === 1) return queue[0];
        let candidate: Track;
        do {
          candidate = queue[Math.floor(Math.random() * queue.length)];
        } while (candidate.id === currentId);
        return candidate;
      };

      const getQueue = (): Track[] => {
        const { tracks, searchQuery } = useLibraryStore.getState();
        return filterTracks(tracks, searchQuery);
      };

      // Mismo cálculo de "próximo" que `next()`, pero como función pura: no
      // dispatcha, sólo devuelve el track. Lo usa `startCrossfade` para
      // precargar mientras el actual sigue sonando.
      const computeNextTrack = (): Track | undefined => {
        const id = get().currentTrackId;
        if (id === null) return undefined;
        const queue = getQueue();
        if (get().shuffle) return pickRandomTrack(queue, id);
        const idx = queue.findIndex((t) => t.id === id);
        return idx >= 0 ? queue[idx + 1] : undefined;
      };

      // Dispara el crossfade: precarga el próximo en el canal inactivo,
      // schedule de los gain ramps en AudioContext clock, swap del active.
      // Llamado desde `_onTimeUpdate` cuando `duration - t <= crossfadeMs/1000`.
      const startCrossfade = () => {
        const { crossfadeMs, _isCrossfading, currentTrackId, duration } = get();
        if (_isCrossfading) return;
        if (crossfadeMs <= 0) return;
        if (currentTrackId === null) return;
        const sec = crossfadeMs / 1000;
        // Track demasiado corto para fadear sin que la mezcla coma toda la
        // canción. Dejamos que termine natural.
        if (duration === 0 || duration <= sec) return;

        const nextTrack = computeNextTrack();
        if (!nextTrack) return; // fin de queue → no fadeamos

        const ctx = getAudioContext();
        const t = ctx.currentTime;
        const oldChannel = getChannel(getActiveChannelId());
        const newChannelId = getInactiveChannelId();
        const newChannel = getChannel(newChannelId);

        // Pushear el current al historial (mismo patrón que playTrack).
        const histNext = [...get().playHistory, currentTrackId];
        set({
          _isCrossfading: true,
          playHistory:
            histNext.length > HISTORY_CAP
              ? histNext.slice(-HISTORY_CAP)
              : histNext,
        });

        // Cargar y disparar el play del nuevo. No esperamos `canplay`: el
        // browser cola el play hasta tener buffer; un breve momento de
        // silencio al inicio del fade es aceptable porque la fuente es un
        // archivo local y la latencia es chica.
        newChannel.audio.src = convertFileSrc(nextTrack.filePath);
        newChannel.audio.play().catch(ignoreAbort);

        // Ramps lineales sobre los gain individuales. cancelScheduledValues +
        // setValueAtTime al valor "esperado" antes del ramp es el pattern
        // recomendado para evitar interferencia con automation previa.
        oldChannel.gain.gain.cancelScheduledValues(t);
        oldChannel.gain.gain.setValueAtTime(1, t);
        oldChannel.gain.gain.linearRampToValueAtTime(0, t + sec);

        newChannel.gain.gain.cancelScheduledValues(t);
        newChannel.gain.gain.setValueAtTime(0, t);
        newChannel.gain.gain.linearRampToValueAtTime(1, t + sec);

        // Swap activo. A partir de acá `getAudioElement()` devuelve el nuevo
        // canal, y los listeners de useAudioPlayer ignoran eventos del viejo
        // (timeupdate, ended) — el currentTime/duration en el store reflejan
        // el track nuevo desde el inicio del fade.
        setActiveChannelId(newChannelId);
        set({
          currentTrackId: nextTrack.id,
          currentTime: 0,
          duration: 0,
        });

        // Programa el cleanup. setTimeout corre en wall-clock; los ramps en
        // AudioContext clock — están sincronizados mientras el ctx no se
        // suspenda. Si el usuario pausa durante el fade, el ramp sigue
        // corriendo y al reanudar el fade ya está "completado" (UX aceptable).
        clearCrossfadeTimer();
        crossfadeTimerId = window.setTimeout(finishCrossfade, crossfadeMs);
      };

      return {
        currentTrackId: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        muted: false,
        shuffle: false,
        crossfadeMs: 0,
        _isCrossfading: false,
        playHistory: [],

        playTrack: (track) => {
          // Antes de cambiar, archivamos el track actual al historial. Si
          // estás clickeando el mismo track de nuevo, no duplicamos.
          const currentId = get().currentTrackId;
          if (currentId !== null && currentId !== track.id) {
            const next = [...get().playHistory, currentId];
            set({
              playHistory:
                next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next,
            });
          }
          loadAndPlay(track);
        },

        loadTrackForResume: (track, positionMs) => {
          // Defensivo: en boot no debería haber crossfade, pero por si acaso.
          cancelCrossfade();
          const audio = getAudioElement();
          audio.src = convertFileSrc(track.filePath);
          const seconds = Math.max(0, positionMs / 1000);
          set({
            currentTrackId: track.id,
            currentTime: seconds,
            duration: 0,
          });
          // Setear `audio.currentTime` antes de que la metadata cargue puede
          // ser ignorado o quedar pendiente — esperamos a `loadedmetadata` y
          // aplicamos el seek ahí. Una sola vez (one-shot listener).
          const onMeta = () => {
            audio.currentTime = seconds;
            audio.removeEventListener("loadedmetadata", onMeta);
          };
          audio.addEventListener("loadedmetadata", onMeta);
          // Bootstrap del grafo Web Audio. Sin user gesture el ctx queda
          // 'suspended', pero ya queda creado el routing (source → masterGain
          // → destination). `togglePlay` hace `ctx.resume()` cuando el
          // usuario presione play y ahí recién sale audio.
          getAudioContext();
          const { volume, muted } = get();
          getMasterGain().gain.value = muted ? 0 : volume;
        },

        togglePlay: async () => {
          if (get().currentTrackId === null) {
            // Si hay search activo, arranca con el primer match — más
            // consistente con lo que el usuario está viendo.
            const first = getQueue()[0];
            if (first) get().playTrack(first);
            return;
          }
          // Branch sobre `isPlaying` del store (no `audio.paused`) para que
          // toggles rápidos durante un fade-out se comporten bien: durante el
          // fade el audio sigue en `paused=false` aunque el usuario "ya pausó"
          // visualmente. Sin esto, click pause + click play durante el fade
          // entrarían los dos en el branch de pause.
          const wasCrossfading = get()._isCrossfading;
          const audio = getAudioElement();

          if (!get().isPlaying) {
            // Eager update: la UI (botón PLAY/PAUSE) flippea inmediato sin
            // esperar al `play` event del <audio>. Si el play() falla por
            // alguna razón, lo rolleamos atrás abajo.
            set({ isPlaying: true });
            // Caso post-resume (loadTrackForResume): el ctx existe pero quedó
            // suspended porque no hubo user gesture al cargarlo. Acá sí lo
            // hay (Space/click), así que el resume() va a tener éxito y el
            // audio sale por destination.
            const ctx = getAudioContext();
            if (ctx.state === "suspended") {
              await ctx.resume().catch(() => {});
            }
            try {
              await audio.play();
              if (wasCrossfading) {
                // Re-iniciar el viejo (pausado por el branch de abajo en el
                // pause anterior) para que el fade-out se complete audible.
                getInactiveAudioElement().play().catch(ignoreAbort);
              }
              fadeInPlayPause();
            } catch (e) {
              ignoreAbort(e);
              // play() falló: rollback del eager update así la UI no miente.
              set({ isPlaying: false });
            }
          } else {
            // Eager update también acá: el botón flippea a "PLAY" inmediato
            // aunque el audio siga sonando audible durante el fade-out.
            set({ isPlaying: false });
            fadeOutPlayPause(() => {
              audio.pause();
              // Pausar también el viejo durante crossfade — sino seguiría
              // sonando mientras el usuario cree que pausó "todo".
              if (wasCrossfading) {
                getInactiveAudioElement().pause();
              }
            });
          }
        },

        seek: (time) => {
          if (!isFinite(time)) return;
          getAudioElement().currentTime = time;
        },

        setVolume: (v) => {
          const clamped = Math.max(0, Math.min(1, v));
          if (!get().muted) getMasterGain().gain.value = clamped;
          set({ volume: clamped });
        },

        toggleMute: () => {
          const next = !get().muted;
          getMasterGain().gain.value = next ? 0 : get().volume;
          set({ muted: next });
        },

        toggleShuffle: () => set({ shuffle: !get().shuffle }),

        cycleCrossfade: () => {
          const current = get().crossfadeMs;
          const idx = (CROSSFADE_STEPS_MS as readonly number[]).indexOf(current);
          const nextIdx = idx === -1 ? 1 : (idx + 1) % CROSSFADE_STEPS_MS.length;
          set({ crossfadeMs: CROSSFADE_STEPS_MS[nextIdx] });
        },

        next: () => {
          const id = get().currentTrackId;
          if (id === null) return;
          const queue = getQueue();

          if (get().shuffle) {
            const target = pickRandomTrack(queue, id);
            if (target) get().playTrack(target);
            return;
          }

          const idx = queue.findIndex((t) => t.id === id);
          const target = idx >= 0 ? queue[idx + 1] : undefined;
          if (target) get().playTrack(target);
        },

        prev: () => {
          const id = get().currentTrackId;
          if (id === null) return;

          // En shuffle, prev despega del historial (el último track previo
          // realmente reproducido). El historial NO se filtra — si bajaste
          // un track antes de buscar, prev te lleva ahí aunque el filtro
          // ahora lo excluya.
          if (get().shuffle) {
            const history = get().playHistory;
            const lastId = history[history.length - 1];
            if (lastId !== undefined) {
              const tracks = useLibraryStore.getState().tracks;
              const target = tracks.find((t) => t.id === lastId);
              if (target) {
                set({ playHistory: history.slice(0, -1) });
                loadAndPlay(target);
                return;
              }
            }
          }

          const queue = getQueue();
          const idx = queue.findIndex((t) => t.id === id);
          const target = idx > 0 ? queue[idx - 1] : undefined;
          if (target) get().playTrack(target);
        },

        _onTimeUpdate: (t) => {
          set({ currentTime: t });
          // Auto-trigger del crossfade. Sólo dispara en el canal activo
          // (useAudioPlayer ya filtró por isActive). _isCrossfading es el
          // gate principal — una vez disparado, no re-dispara hasta que
          // finishCrossfade limpie el flag.
          const { crossfadeMs, _isCrossfading, duration } = get();
          if (
            crossfadeMs > 0 &&
            !_isCrossfading &&
            duration > 0 &&
            duration - t <= crossfadeMs / 1000
          ) {
            startCrossfade();
          }
        },
        _onDuration: (d) => set({ duration: d }),
        _onPlay: () => set({ isPlaying: true }),
        _onPause: () => set({ isPlaying: false }),
        _onEnded: () => {
          set({ isPlaying: false });
          get().next();
        },
      };
    },
    {
      name: "brutalist-player:player",
      partialize: (state) => ({
        volume: state.volume,
        muted: state.muted,
        shuffle: state.shuffle,
        crossfadeMs: state.crossfadeMs,
      }),
    },
  ),
);
