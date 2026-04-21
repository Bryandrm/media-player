import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "m4a", "opus", "ogg", "aac"];

function App() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const [src, setSrc] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  async function pickFile() {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
      });
      if (typeof selected === "string") {
        setSrc(convertFileSrc(selected));
        setFileName(selected.split("/").pop() ?? selected);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function ensureAudioGraph() {
    const audio = audioRef.current;
    if (!audio) return null;
    if (!audioCtxRef.current) {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      sourceRef.current = source;
      analyserRef.current = analyser;
    }
    return analyserRef.current;
  }

  function draw() {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const { width, height } = canvas;
    ctx2d.fillStyle = "#000000";
    ctx2d.fillRect(0, 0, width, height);

    const barWidth = width / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * height;
      ctx2d.fillStyle = "#FF3B00";
      ctx2d.fillRect(i * barWidth, height - barHeight, barWidth - 1, barHeight);
    }

    rafRef.current = requestAnimationFrame(draw);
  }

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !src) return;
    const analyser = ensureAudioGraph();
    if (!analyser) return;

    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") await ctx.resume();

    if (audio.paused) {
      await audio.play();
      setIsPlaying(true);
      if (rafRef.current == null) draw();
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const btnBase =
    "bg-bg text-fg border-2 border-fg px-6 py-3 font-mono font-bold text-sm tracking-wider uppercase cursor-pointer transition-none";
  const btnHover = "hover:bg-accent hover:text-bg hover:border-accent";
  const btnDisabled = "disabled:text-muted disabled:border-muted disabled:cursor-not-allowed disabled:bg-bg";

  return (
    <main className="max-w-[900px] mx-auto p-8 flex flex-col gap-6">
      <header>
        <h1 className="m-0 text-2xl tracking-wide font-bold pb-2 border-b-2 border-fg">
          AUDIO PIPELINE // SMOKE TEST
        </h1>
        <p className="mt-2 text-xs text-muted">
          convertFileSrc &rarr; &lt;audio&gt; &rarr; MediaElementAudioSourceNode &rarr; AnalyserNode &rarr; destination
        </p>
      </header>

      <div className="flex gap-4">
        <button onClick={pickFile} className={`${btnBase} ${btnHover}`}>
          LOAD AUDIO
        </button>
        <button onClick={togglePlay} disabled={!src} className={`${btnBase} ${btnHover} ${btnDisabled}`}>
          {isPlaying ? "PAUSE" : "PLAY"}
        </button>
      </div>

      <div className="border border-fg px-3 py-2 text-sm">
        <span className="text-muted mr-2">FILE:</span>
        {fileName ?? "—"}
      </div>

      {error && (
        <div className="border-2 border-accent text-accent p-3 text-sm">
          ERROR: {error}
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={800}
        height={200}
        className="w-full h-[200px] border-2 border-fg bg-bg block"
      />

      <audio ref={audioRef} src={src ?? undefined} preload="auto" crossOrigin="anonymous" />
    </main>
  );
}

export default App;
