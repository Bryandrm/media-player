#!/usr/bin/env python3
"""
Mismatch detection: transcribe audio with WhisperX, compare against LRC
text using phonemic similarity (IPA via phonemizer + Levenshtein distance).

Pipeline:
  1. WhisperX transcribe mode → segments with actual audio text.
  2. Parse LRC lines with timestamps.
  3. Match LRC lines to transcribed segments by timestamp overlap.
  4. Convert both texts to IPA phonemes via phonemizer (espeak backend).
  5. Normalized Levenshtein similarity per line pair.
  6. Output JSON with per-line scores + overall score.

Args (argv):
    1. audio_path   : absolute path to audio file
    2. lrc_path     : file with raw LRC text (synced lyrics)
    3. output_path  : where to write the result JSON
    4. language      : ISO 639-1 code (en, es, ja, ko, ...)

Output JSON:
    {
      "overall_score": 0.82,
      "lines": [
        {
          "index": 0,
          "timestamp_ms": 25430,
          "lrc_text": "Hello world",
          "transcribed_text": "hello world",
          "lrc_phonemes": "hɛloʊ wɜːld",
          "transcribed_phonemes": "hɛloʊ wɜːld",
          "score": 0.95
        },
        ...
      ]
    }

Dependencies: whisperx, phonemizer (+ espeak-ng system package).
Errors go to stderr. Exit != 0 on failure.
"""

import json
import os
import re
import sys
import traceback

# Windows: phonemizer needs the espeak-ng shared library, not the CLI exe.
# Set PHONEMIZER_ESPEAK_LIBRARY to the DLL path before importing phonemizer.
if sys.platform == "win32" and "PHONEMIZER_ESPEAK_LIBRARY" not in os.environ:
    _dll = os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"),
                        "eSpeak NG", "libespeak-ng.dll")
    if os.path.isfile(_dll):
        os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = _dll


def parse_lrc_lines(lrc_text):
    """Parse LRC into list of {timestamp_ms, text}. Strips A2 markers."""
    lines = []
    for raw in lrc_text.splitlines():
        line = raw.strip()
        if not line or not line.startswith("["):
            continue
        close = line.find("]")
        if close < 0:
            continue
        ts_str = line[1:close]
        ts_ms = parse_timestamp(ts_str)
        if ts_ms is None:
            continue
        text = line[close + 1 :]
        text = re.sub(r"<[^>]+>", "", text).strip()
        if not text:
            continue
        lines.append({"timestamp_ms": ts_ms, "text": text})
    lines.sort(key=lambda x: x["timestamp_ms"])
    return lines


def parse_timestamp(ts):
    """Parse mm:ss.xx or mm:ss.xxx to ms. Returns None for metadata tags."""
    m = re.match(r"^(\d+):(\d+)(?:\.(\d+))?$", ts)
    if not m:
        return None
    mins = int(m.group(1))
    secs = int(m.group(2))
    frac_str = m.group(3) or "0"
    if len(frac_str) == 3:
        frac_ms = int(frac_str)
    else:
        frac_ms = int(frac_str.ljust(2, "0")[:2]) * 10
    return mins * 60000 + secs * 1000 + frac_ms


def match_lines_to_segments(lrc_lines, segments):
    """Match each LRC line to the overlapping transcribed text.

    Uses word-level timestamps when available (whisperx provides them).
    Falls back to proportional text slicing from the overlapping segment.
    """
    # Flatten word-level timings if available
    words = []
    for seg in segments:
        if "words" in seg:
            for w in seg["words"]:
                if "start" in w and "word" in w:
                    words.append(w)
        elif "word_segments" in seg:
            for w in seg["word_segments"]:
                if "start" in w and "word" in w:
                    words.append(w)

    pairs = []
    for i, lrc in enumerate(lrc_lines):
        lrc_start = lrc["timestamp_ms"] / 1000.0
        # Use next line's timestamp as end, or +10s for last line
        if i + 1 < len(lrc_lines):
            lrc_end = lrc_lines[i + 1]["timestamp_ms"] / 1000.0
        else:
            lrc_end = lrc_start + 10.0

        if words:
            # Word-level matching: collect words within this line's time range
            line_words = [
                w["word"] for w in words
                if w.get("start", 0) >= lrc_start - 0.3
                and w.get("start", 0) < lrc_end + 0.3
            ]
            transcribed = " ".join(line_words).strip()
        else:
            # Segment-level: find overlapping segments and extract proportional text
            collected = []
            for seg in segments:
                seg_start = seg.get("start", 0)
                seg_end = seg.get("end", seg_start)
                seg_text = seg.get("text", "").strip()
                if not seg_text:
                    continue
                overlap_start = max(lrc_start, seg_start)
                overlap_end = min(lrc_end, seg_end)
                if overlap_end <= overlap_start:
                    continue
                seg_dur = seg_end - seg_start
                if seg_dur <= 0:
                    collected.append(seg_text)
                    continue
                # Proportional slice of the segment text
                frac_start = (overlap_start - seg_start) / seg_dur
                frac_end = (overlap_end - seg_start) / seg_dur
                seg_words = seg_text.split()
                n_words = len(seg_words)
                w_start = int(frac_start * n_words)
                w_end = max(w_start + 1, int(frac_end * n_words + 0.5))
                collected.append(" ".join(seg_words[w_start:w_end]))
            transcribed = " ".join(collected).strip()

        pairs.append((lrc, transcribed))
    return pairs


def to_phonemes_batch(texts, language):
    """Convert a list of texts to IPA phonemes via phonemizer."""
    from phonemizer import phonemize
    from phonemizer.separator import Separator

    sep = Separator(phone=" ", word="  ", syllable="")
    result = phonemize(
        texts,
        language=language,
        backend="espeak",
        separator=sep,
        strip=True,
        preserve_punctuation=False,
        language_switch="remove-flags",
    )
    return result


def levenshtein_similarity(s1, s2):
    """Normalized Levenshtein similarity (0=no match, 1=identical)."""
    if not s1 and not s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    len1, len2 = len(s1), len(s2)
    if len1 < len2:
        s1, s2 = s2, s1
        len1, len2 = len2, len1
    prev = list(range(len2 + 1))
    for i in range(1, len1 + 1):
        curr = [i] + [0] * len2
        for j in range(1, len2 + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev = curr
    distance = prev[len2]
    max_len = max(len1, len2)
    return 1.0 - (distance / max_len)


def espeak_language_code(lang):
    """Map ISO 639-1 to espeak language code (most are identical)."""
    mapping = {
        "ja": "ja",
        "ko": "ko",
        "zh": "cmn",
        "en": "en-us",
        "es": "es",
        "fr": "fr-fr",
        "de": "de",
        "it": "it",
        "pt": "pt",
        "ru": "ru",
    }
    return mapping.get(lang, lang)


def main():
    if len(sys.argv) != 5:
        print(
            f"usage: {sys.argv[0]} audio_path lrc_path output_path language",
            file=sys.stderr,
        )
        sys.exit(2)

    audio_path = sys.argv[1]
    lrc_path = sys.argv[2]
    output_path = sys.argv[3]
    language = sys.argv[4]

    try:
        import whisperx
    except ImportError as e:
        print(f"whisperx not importable: {e}", file=sys.stderr)
        sys.exit(3)

    try:
        from phonemizer import phonemize  # noqa: F401
    except ImportError as e:
        print(f"phonemizer not importable: {e}", file=sys.stderr)
        print(
            "install: pipx inject whisperx phonemizer  (+ espeak-ng system package)",
            file=sys.stderr,
        )
        sys.exit(3)

    try:
        with open(lrc_path, encoding="utf-8") as f:
            lrc_text = f.read()
    except OSError as e:
        print(f"failed to read lrc: {e}", file=sys.stderr)
        sys.exit(4)

    lrc_lines = parse_lrc_lines(lrc_text)
    if not lrc_lines:
        print("no parseable LRC lines", file=sys.stderr)
        sys.exit(5)

    print(f"[mismatch] {len(lrc_lines)} LRC lines parsed", file=sys.stderr)

    # 1. Transcribe audio with WhisperX
    device = "cpu"
    # language="auto" → let whisperx detect the language from audio
    load_lang = None if language == "auto" else language
    try:
        model = whisperx.load_model("base", device, compute_type="int8", language=load_lang)
    except Exception as e:
        print(f"load_model failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(6)

    try:
        audio = whisperx.load_audio(audio_path)
    except Exception as e:
        print(f"load_audio failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(7)

    print("[mismatch] transcribing audio...", file=sys.stderr)
    result = model.transcribe(audio, batch_size=8)
    segments = result.get("segments", [])
    detected_lang = result.get("language", language)
    print(f"[mismatch] transcribed {len(segments)} segments (lang={detected_lang})", file=sys.stderr)

    if not segments:
        print("whisperx returned 0 segments", file=sys.stderr)
        sys.exit(8)

    # Align to get word-level timestamps for better per-line matching
    align_lang = detected_lang if language == "auto" else language
    try:
        align_model, align_meta = whisperx.load_align_model(
            language_code=align_lang, device=device
        )
        result = whisperx.align(
            segments, align_model, align_meta, audio, device,
            return_char_alignments=False,
        )
        segments = result.get("segments", segments)
        n_words = sum(len(s.get("words", [])) for s in segments)
        print(f"[mismatch] aligned {n_words} words for matching", file=sys.stderr)
    except Exception as e:
        print(f"[mismatch] align failed, using segment-level matching: {e}", file=sys.stderr)

    # 2. Match LRC lines to transcribed segments
    pairs = match_lines_to_segments(lrc_lines, segments)

    # 3. Convert to phonemes (use detected language for phonemizer)
    phoneme_lang = detected_lang if language == "auto" else language
    espeak_lang = espeak_language_code(phoneme_lang)
    lrc_texts = [p[0]["text"] for p in pairs]
    transcribed_texts = [p[1] for p in pairs]
    all_texts = lrc_texts + transcribed_texts

    print(f"[mismatch] converting {len(all_texts)} texts to phonemes (lang={espeak_lang})...", file=sys.stderr)
    try:
        all_phonemes = to_phonemes_batch(all_texts, espeak_lang)
    except Exception as e:
        print(f"phonemizer failed: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        # Fallback: compare raw text without phonemes
        print("[mismatch] falling back to raw text comparison", file=sys.stderr)
        all_phonemes = [t.lower() for t in all_texts]

    n = len(pairs)
    lrc_phonemes = all_phonemes[:n]
    transcribed_phonemes = all_phonemes[n:]

    # 4. Score each line
    output_lines = []
    total_score = 0.0
    for i, (pair, lrc_ph, tr_ph) in enumerate(zip(pairs, lrc_phonemes, transcribed_phonemes)):
        lrc_line, transcribed_text = pair
        score = levenshtein_similarity(lrc_ph, tr_ph)
        total_score += score
        output_lines.append({
            "index": i,
            "timestamp_ms": lrc_line["timestamp_ms"],
            "lrc_text": lrc_line["text"],
            "transcribed_text": transcribed_text,
            "lrc_phonemes": lrc_ph,
            "transcribed_phonemes": tr_ph,
            "score": round(score, 4),
        })

    overall_score = total_score / n if n > 0 else 0.0
    output = {
        "overall_score": round(overall_score, 4),
        "lines": output_lines,
    }

    try:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False)
    except OSError as e:
        print(f"failed to write output: {e}", file=sys.stderr)
        sys.exit(9)

    mismatched = [l for l in output_lines if l["score"] < 0.5]
    print(
        f"[mismatch] done: overall={overall_score:.3f}, "
        f"{len(mismatched)}/{n} lines below 0.5",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
