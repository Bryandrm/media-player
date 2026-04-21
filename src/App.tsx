import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

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

  return (
    <main className="smoke">
      <header className="smoke__header">
        <h1>AUDIO PIPELINE // SMOKE TEST</h1>
        <p className="smoke__sub">
          convertFileSrc &rarr; &lt;audio&gt; &rarr; MediaElementAudioSourceNode &rarr; AnalyserNode &rarr; destination
        </p>
      </header>

      <div className="smoke__controls">
        <button onClick={pickFile} className="btn">LOAD AUDIO</button>
        <button onClick={togglePlay} className="btn" disabled={!src}>
          {isPlaying ? "PAUSE" : "PLAY"}
        </button>
      </div>

      <div className="smoke__status">
        <span className="label">FILE:</span> {fileName ?? "—"}
      </div>

      {error && <div className="smoke__error">ERROR: {error}</div>}

      <canvas ref={canvasRef} width={800} height={200} className="smoke__canvas" />

      <audio ref={audioRef} src={src ?? undefined} preload="auto" crossOrigin="anonymous" />
    </main>
  );
}

export default App;
