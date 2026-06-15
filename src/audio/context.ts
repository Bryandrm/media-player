import {
  getAudioElementA,
  getAudioElementB,
  type ChannelId,
} from "./element";

// Singleton del grafo Web Audio con dos canales para crossfade.
//
// Pipeline:
//   audioA → sourceA → channelGainA ─┐
//                                    ├─→ preMasterGain → masterGain → playPauseGain → destination
//   audioB → sourceB → channelGainB ─┘        ↓             (volume        (play/pause
//                                       Butterchurn tap     + mute)         fade)
//
// Convención de gains:
//   - channelGain canal activo:  1
//   - channelGain canal inactivo: 0
//   Durante un crossfade ambos están entre 0 y 1 mientras corre el ramp; al
//   terminar quedan en el extremo (active=1, inactive=0).
//
//   - playPauseGain: 0 al inicio (silencio antes del primer play) y al pause;
//     1 al play. Ramp lineal corto (~80ms al play, ~150ms al pause) para
//     evitar el "click" abrupto cuando el usuario alterna play/pause.
//
// Por qué `preMasterGain` existe: junction node que el visualizer tapea
// para ver la mezcla de los dos canales. Sin esto, si Butterchurn tapeara
// `sourceA` directo, perdería todo el audio del canal B durante un crossfade.
//
// Por qué `playPauseGain` está DESPUÉS de masterGain: así el control de
// volumen del usuario es independiente del fade de play/pause. Si estuvieran
// fusionados, mover el slider durante un fade interrumpe el ramp.
//
// El visualizer (que tapea preMasterGain) sigue reaccionando aunque el
// usuario mutee O esté en fade de pausa — coherente con el comportamiento
// previo de mute.
//
// `audio.volume` queda bypassed por Web Audio una vez que el `<audio>` está
// conectado a un `MediaElementAudioSourceNode`. Por eso el control de volumen
// real es `masterGain.gain.value`.

type Channel = {
  id: ChannelId;
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
};

let ctx: AudioContext | null = null;
let channelA: Channel | null = null;
let channelB: Channel | null = null;
let preMasterGain: GainNode | null = null;
let masterGain: GainNode | null = null;
let playPauseGain: GainNode | null = null;
let eqBands: BiquadFilterNode[] = [];

// EQ de 10 bandas estándar ISO. Lowshelf en la primera banda, highshelf en
// la última, peaking en las del medio — topología clásica de Foobar/Winamp.
// Insertado entre preMasterGain y masterGain → el visualizer (tap en
// preMasterGain) NO ve la EQ del usuario; reacciona al audio original.
// Decisión consciente: si el usuario sube +12dB en 60Hz, no queremos que
// el visualizer explote en bass como artefacto del slider — sería confuso.
// El EQ es ajuste de listening, el visualizer es lectura objetiva.
export const EQ_BAND_FREQS: readonly number[] = [
  32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];
const EQ_PEAKING_Q = 1.0;
// Timer del audio.pause() pendiente al final de un fade-out. Se cancela si el
// usuario hace click play antes de que el fade termine — sin esto, el pause
// programado correría igual y nos dejaría con audio pausado tras un click play.
let pendingPauseTimerId: number | null = null;

// 200ms es claramente perceptible como fade — abajo de ~120ms el oído lo
// registra como un click suave, no como una transición. El pause queda en
// 150ms (el usuario lo confirmó audible) — un poco más corto para no sentir
// lag al stop.
const PLAY_FADE_MS = 200;
const PAUSE_FADE_MS = 150;

function buildChannel(id: ChannelId, audio: HTMLAudioElement): Channel {
  const c = ctx!;
  const source = c.createMediaElementSource(audio);
  const gain = c.createGain();
  // El canal A nace activo (gain=1); B nace inactivo (gain=0). Cuando el
  // primer crossfade haga el swap, A pasa a 0 y B a 1.
  gain.gain.value = id === "a" ? 1 : 0;
  source.connect(gain);
  gain.connect(preMasterGain!);
  return { id, audio, source, gain };
}

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    preMasterGain = ctx.createGain();
    masterGain = ctx.createGain();
    playPauseGain = ctx.createGain();
    // Inicial 0: silencio hasta el primer play. fadeInPlayPause hace el ramp
    // 0→1 y se siente como "el reproductor cobra vida". Sin esto, el primer
    // play arrancaría a volumen full instantáneo.
    playPauseGain.gain.value = 0;

    // EQ chain: preMasterGain → eqBands[0..9] → masterGain.
    // Cada banda nace con gain=0 (neutro). El playerStore aplica los gains
    // del usuario via setEqBandGain una vez que el AudioContext existe.
    eqBands = EQ_BAND_FREQS.map((freq, i) => {
      const filter = ctx!.createBiquadFilter();
      if (i === 0) {
        filter.type = "lowshelf";
      } else if (i === EQ_BAND_FREQS.length - 1) {
        filter.type = "highshelf";
      } else {
        filter.type = "peaking";
        filter.Q.value = EQ_PEAKING_Q;
      }
      filter.frequency.value = freq;
      filter.gain.value = 0;
      return filter;
    });

    preMasterGain.connect(eqBands[0]);
    for (let i = 0; i < eqBands.length - 1; i++) {
      eqBands[i].connect(eqBands[i + 1]);
    }
    eqBands[eqBands.length - 1].connect(masterGain);

    masterGain.connect(playPauseGain);
    playPauseGain.connect(ctx.destination);

    channelA = buildChannel("a", getAudioElementA());
    channelB = buildChannel("b", getAudioElementB());
  }
  return ctx;
}

/**
 * Aplica un gain (en dB, -12..+12) a una banda específica del EQ.
 *
 * `enabled=false` fuerza 0dB sin tocar el valor "intencionado" del usuario
 * — el playerStore lo llama con `enabled=false` para bypassear sin perder
 * el preset que el usuario armó. Los nodos siguen procesando (overhead
 * insignificante: 10 BiquadFilters a 0dB es transparente), pero es
 * efectivamente flat.
 */
export function setEqBandGain(
  band: number,
  gainDb: number,
  enabled: boolean,
): void {
  if (band < 0 || band >= eqBands.length) return;
  getAudioContext();
  const effectiveGain = enabled ? gainDb : 0;
  // setTargetAtTime con time-constant chico (5ms) para evitar zipper noise
  // cuando el usuario arrastra el slider rápido. Si seteamos `.value =` raw
  // y el cambio es grande, Chrome inserta un step audible.
  eqBands[band].gain.setTargetAtTime(
    effectiveGain,
    ctx!.currentTime,
    0.005,
  );
}

export function getChannel(id: ChannelId): Channel {
  getAudioContext();
  return id === "a" ? channelA! : channelB!;
}

export function getMasterGain(): GainNode {
  getAudioContext();
  return masterGain!;
}

/** Punto donde el visualizer hace `connectAudio()`. Es la mezcla de los dos
 *  canales pre-volume/pre-mute → el visualizer reacciona al audio aunque
 *  el usuario tenga muted o el volume bajo. */
export function getVisualizerTap(): AudioNode {
  getAudioContext();
  return preMasterGain!;
}

function clearPendingPauseTimer(): void {
  if (pendingPauseTimerId !== null) {
    window.clearTimeout(pendingPauseTimerId);
    pendingPauseTimerId = null;
  }
}

// Por qué `cancelAndHoldAtTime(t)` y no `cancelScheduledValues(t) +
// setValueAtTime(g.value, t)`:
//
// `g.value` en Chromium/WebKit lee el valor INTRÍNSECO del AudioParam
// (la última asignación directa via `gain.value = X`), no el valor COMPUTADO
// que el ramp está produciendo en este instante. Como inicializamos
// `gain.value = 0` y nunca lo re-asignamos, `g.value` siempre devuelve 0 →
// si el usuario clickea play durante un fade-out a la mitad (gain computado
// ~0.5), `setValueAtTime(0, t)` snappea a 0 audible y después rampea 0→1.
// Click en vez de fade suave.
//
// `cancelAndHoldAtTime(t)` hace exactamente lo correcto: cancela ramps
// futuros e inserta un setValueAtTime IMPLÍCITO con el valor COMPUTADO en t.
// Available en Chrome 57+/Safari 14.1+/Firefox 53+ — todo macOS moderno.

/** Ramp valor-actual→1 sobre PLAY_FADE_MS. Cancela cualquier `audio.pause()`
 *  pendiente: si el usuario hace click play durante un fade-out, el pause
 *  programado debe cancelarse o silenciaría justo después del fade-in. */
export function fadeInPlayPause(): void {
  clearPendingPauseTimer();
  getAudioContext();
  const ctxRef = ctx!;
  const t = ctxRef.currentTime;
  const g = playPauseGain!.gain;
  g.cancelAndHoldAtTime(t);
  g.linearRampToValueAtTime(1, t + PLAY_FADE_MS / 1000);
}

/** Ramp valor-actual→0 sobre PAUSE_FADE_MS, después dispara `onFadeOut` que
 *  típicamente llama `audio.pause()`. Si se llama otro fadeIn/Out antes de
 *  completar, el timer se cancela y `onFadeOut` no corre. */
export function fadeOutPlayPause(onFadeOut: () => void): void {
  clearPendingPauseTimer();
  getAudioContext();
  const ctxRef = ctx!;
  const t = ctxRef.currentTime;
  const g = playPauseGain!.gain;
  g.cancelAndHoldAtTime(t);
  g.linearRampToValueAtTime(0, t + PAUSE_FADE_MS / 1000);
  pendingPauseTimerId = window.setTimeout(() => {
    pendingPauseTimerId = null;
    onFadeOut();
  }, PAUSE_FADE_MS);
}
