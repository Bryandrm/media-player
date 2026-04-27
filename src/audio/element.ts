// Singleton HTMLAudioElement. Vive fuera del DOM React — así Butterchurn
// (futuro) puede crear su MediaElementAudioSourceNode desde un subtree distinto
// sin depender de un ref que viva en App.tsx.

let element: HTMLAudioElement | null = null;

export function getAudioElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = "auto";
    element.crossOrigin = "anonymous";
  }
  return element;
}
