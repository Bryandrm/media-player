// Dos `<audio>` elements singleton, fuera del DOM React. Se usan dos para que
// el crossfade tenga overlap real (un sólo elemento sólo puede reproducir una
// fuente a la vez). En estado normal sólo el "activo" suena — el inactivo
// queda con `src=""` y gain=0 hasta que el siguiente crossfade lo levanta.
//
// Cada elemento tiene `crossOrigin="anonymous"` porque sin eso
// `createMediaElementSource()` marca el elemento como tainted y el
// AnalyserNode/Butterchurn ven ceros (audio suena pero visualizer queda
// muerto). Ver ARCHITECTURE §2.2.

let elementA: HTMLAudioElement | null = null;
let elementB: HTMLAudioElement | null = null;
let activeId: ChannelId = "a";

export type ChannelId = "a" | "b";

function makeElement(): HTMLAudioElement {
  const el = new Audio();
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  return el;
}

export function getAudioElementA(): HTMLAudioElement {
  if (!elementA) elementA = makeElement();
  return elementA;
}

export function getAudioElementB(): HTMLAudioElement {
  if (!elementB) elementB = makeElement();
  return elementB;
}

export function getActiveChannelId(): ChannelId {
  return activeId;
}

export function setActiveChannelId(id: ChannelId): void {
  activeId = id;
}

export function getInactiveChannelId(): ChannelId {
  return activeId === "a" ? "b" : "a";
}

/** El elemento "principal" — al que apuntan las acciones de UI (play/pause,
 *  seek, src=). Durante un crossfade es el track NUEVO que está fadeando in. */
export function getAudioElement(): HTMLAudioElement {
  return activeId === "a" ? getAudioElementA() : getAudioElementB();
}

export function getInactiveAudioElement(): HTMLAudioElement {
  return activeId === "a" ? getAudioElementB() : getAudioElementA();
}
