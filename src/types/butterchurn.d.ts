// Stubs mínimos. butterchurn no publica tipos; cubrimos sólo lo que usamos.

declare module "butterchurn" {
  export interface VisualizerOptions {
    width: number;
    height: number;
    pixelRatio?: number;
    textureRatio?: number;
    meshWidth?: number;
    meshHeight?: number;
  }

  export interface Visualizer {
    connectAudio(node: AudioNode): void;
    loadPreset(preset: unknown, blendTimeS: number): void;
    setRendererSize(width: number, height: number): void;
    render(): void;
  }

  const butterchurn: {
    createVisualizer(
      audioContext: AudioContext,
      canvas: HTMLCanvasElement,
      options: VisualizerOptions,
    ): Visualizer;
  };
  export default butterchurn;
}

declare module "butterchurn-presets" {
  const butterchurnPresets: {
    getPresets(): Record<string, unknown>;
  };
  export default butterchurnPresets;
}
