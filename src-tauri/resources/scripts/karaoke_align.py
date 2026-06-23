#!/usr/bin/env python3
"""
Wrapper de WhisperX para forced alignment en modo align-only.

Recibe segmentos `[{start, end, text}, ...]` (uno por línea del LRC con
sus bounds del LRC) y devuelve word-level timestamps per palabra.

Lecciones aprendidas en intentos previos (ver doc git history):

- **Whole-track [0, audio_dur]**: CTC greedy-asigna palabras al intro
  instrumental. Falla.
- **Bounds con buffer ±Ns**: whisperx aprovecha el buffer para "encontrar"
  palabras en sonidos instrumentales. Falla.
- **Blind transcribe + pareo proporcional**: distribuir palabras LRC por
  duración de segmentos whisperx asume densidad de palabras uniforme,
  cosa que no es cierta. Falla peor.

El approach actual (align-only con bounds del LRC) es el **más simple y
predecible**. Limitación honesta: si el LRC tiene drift, el alignment
hereda ese drift dentro de la línea afectada — pero el error queda
confinado, no se propaga al resto del track.

Para tracks con LRC de mala calidad, el usuario tiene fallbacks:
- SLOWER/FASTER + offset manual.
- Editar el LRC (futuro).
- Buscar mejor LRC de otra fuente (futuro).

Args (por argv):
    1. audio_path        : ruta absoluta al archivo de audio
    2. segments_json_path: JSON con [{"start": s, "end": s, "text": "..."}, ...]
                           start/end en SEGUNDOS. text es el contenido de la línea.
    3. output_json_path  : ruta donde escribimos el resultado
    4. language          : ISO 639-1 code (en, es, ja, ko, ...)

Output JSON shape:
    {
      "word_segments": [
        {"word": "There's", "start": 19.99, "end": 20.27, "score": 0.45},
        ...
      ]
    }

Errores van a stderr. Exit code != 0 si algo falla — el caller lee stderr
para el mensaje de error legible.
"""

import json
import os
import sys
import traceback


def _progress(stage, **extra):
    """Emite un marcador de progreso estructurado a stderr. El wrapper Rust
    parsea las líneas con prefijo @@PROGRESS@@ y las reenvía como evento Tauri
    `karaoke-progress`. El resto del stderr sigue siendo log/error normal."""
    payload = {"stage": stage}
    payload.update(extra)
    print("@@PROGRESS@@" + json.dumps(payload), file=sys.stderr, flush=True)


def _hf_cached(repo_id):
    """Best-effort: True si el repo de HuggingFace ya está en el cache local
    (→ no se va a descargar). Sirve para que la UI muestre el aviso de
    descarga SOLO cuando realmente baja. Si no podemos determinarlo,
    el caller pasa downloading=None y la UI muestra un texto neutral."""
    from pathlib import Path
    base = os.environ.get("HF_HOME")
    hub = Path(base) / "hub" if base else Path.home() / ".cache" / "huggingface" / "hub"
    folder = "models--" + repo_id.replace("/", "--")
    return (hub / folder).is_dir()


def main():
    if len(sys.argv) != 5:
        print(
            f"usage: {sys.argv[0]} audio_path segments_json output_json language",
            file=sys.stderr,
        )
        sys.exit(2)

    audio_path = sys.argv[1]
    segments_path = sys.argv[2]
    output_path = sys.argv[3]
    language = sys.argv[4]

    try:
        # Importar whisperx tarde para que errores de invocación (argv malo)
        # no esperen a la carga de PyTorch (~3-5s).
        _progress("loading_engine")
        import whisperx  # noqa: E402
    except ImportError as e:
        print(f"whisperx not importable: {e}", file=sys.stderr)
        sys.exit(3)

    try:
        with open(segments_path, encoding="utf-8") as f:
            segments = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"failed to read segments_json_path: {e}", file=sys.stderr)
        sys.exit(4)

    if not segments:
        print("no segments to align", file=sys.stderr)
        sys.exit(5)

    # CPU por default. MPS (Apple Silicon GPU) requiere setup adicional;
    # validamos primero el path básico y después optimizamos si hace falta.
    device = "cpu"

    # Cargar audio una vez.
    try:
        audio = whisperx.load_audio(audio_path)
    except Exception as e:
        print(f"load_audio failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(7)

    # Auto-detect language if requested
    if language == "auto":
        print("auto-detecting language from audio...", file=sys.stderr)
        _progress(
            "detecting_language",
            model="faster-whisper-base",
            downloading=not _hf_cached("Systran/faster-whisper-base"),
        )
        try:
            detect_model = whisperx.load_model(
                "base", device, compute_type="int8", language=None,
                vad_options={"vad_onset": 0.1, "vad_offset": 0.05},
            )
            clip = audio[: 30 * 16000]
            detect_result = detect_model.transcribe(clip, batch_size=1)
            language = detect_result.get("language", "en")
            print(f"detected language: {language}", file=sys.stderr)
            del detect_model
        except Exception as e:
            print(f"language detection failed, defaulting to 'en': {e}", file=sys.stderr)
            language = "en"

    print(
        f"forced alignment: {len(segments)} segments, lang={language} (LRC bounds, align-only mode)",
        file=sys.stderr,
    )

    # Forced alignment con los segmentos del LRC tal como vinieron — bounds y
    # texto. WhisperX aligna word-level dentro de cada bound. Approach
    # conservador y predecible.
    aligned_input = segments

    # Determinar el modelo de alignment (wav2vec2 por idioma) y si ya está
    # cacheado, para que la UI muestre el aviso de descarga sólo cuando baja.
    # Best-effort: si los dicts internos de whisperx cambian, caemos a un
    # texto neutral (model/downloading = None).
    _align_model = None
    _align_downloading = None
    try:
        from whisperx.alignment import (
            DEFAULT_ALIGN_MODELS_HF,
            DEFAULT_ALIGN_MODELS_TORCH,
        )
        if language in DEFAULT_ALIGN_MODELS_TORCH:
            # torchaudio bundle (en cache de torch, no de HF) — no chequeamos.
            _align_model = DEFAULT_ALIGN_MODELS_TORCH[language]
        elif language in DEFAULT_ALIGN_MODELS_HF:
            _align_model = DEFAULT_ALIGN_MODELS_HF[language]
            _align_downloading = not _hf_cached(_align_model)
    except Exception:
        pass
    _progress("loading_align_model", model=_align_model, downloading=_align_downloading)

    try:
        model_a, metadata = whisperx.load_align_model(
            language_code=language, device=device
        )
    except Exception as e:
        print(f"load_align_model failed for language='{language}': {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(6)

    _progress("aligning")
    try:
        result = whisperx.align(
            aligned_input,
            model_a,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
    except Exception as e:
        print(f"whisperx.align failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(8)

    # `result` viene con varias claves; sólo nos importan los word_segments.
    # Filtramos lo justo y nada más para que el JSON quede chico.
    word_segments = result.get("word_segments", [])
    output = {"word_segments": word_segments}

    try:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output, f)
    except OSError as e:
        print(f"failed to write output: {e}", file=sys.stderr)
        sys.exit(9)

    print(f"aligned {len(word_segments)} words", file=sys.stderr)


if __name__ == "__main__":
    main()
