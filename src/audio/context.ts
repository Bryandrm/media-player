import { getAudioElement } from "./element";

// Singleton del grafo Web Audio. `createMediaElementSource` sólo puede llamarse
// UNA vez por elemento, por eso ctx + source viven en module scope.
//
// Pipeline:
//   <audio>  →  MediaElementAudioSourceNode  ─┬→  GainNode  →  destination
//                (Butterchurn tapea aquí con  │
//                 `connectAudio(source)` —    │  ← el visualizer ve la señal
//                 ve la señal pre-volumen)    │    siempre, aunque mutees
//
// Importante: una vez conectado el <audio> a Web Audio, `audio.volume` queda
// bypassed en Chromium. Por eso el control de volumen real es el GainNode.

let ctx: AudioContext | null = null;
let source: MediaElementAudioSourceNode | null = null;
let masterGain: GainNode | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    source = ctx.createMediaElementSource(getAudioElement());
    masterGain = ctx.createGain();
    source.connect(masterGain);
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

export function getAudioSource(): MediaElementAudioSourceNode {
  getAudioContext();
  return source!;
}

export function getMasterGain(): GainNode {
  getAudioContext();
  return masterGain!;
}
