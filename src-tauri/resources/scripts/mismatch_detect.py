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
import re
import sys
import traceback


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
    """Match each LRC line to the best-overlapping transcribed segment.

    Returns list of (lrc_line, transcribed_text) pairs.
    """
    pairs = []
    for lrc in lrc_lines:
        lrc_start = lrc["timestamp_ms"] / 1000.0
        best_seg = None
        best_overlap = -1
        for seg in segments:
            seg_start = seg.get("start", 0)
            seg_end = seg.get("end", seg_start)
            overlap_start = max(lrc_start, seg_start)
            overlap_end = min(lrc_start + 10, seg_end)
            overlap = max(0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_seg = seg
        transcribed = best_seg["text"].strip() if best_seg and best_overlap > 0 else ""
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
    try:
        model = whisperx.load_model("base", device, compute_type="int8", language=language)
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
    print(f"[mismatch] transcribed {len(segments)} segments", file=sys.stderr)

    if not segments:
        print("whisperx returned 0 segments", file=sys.stderr)
        sys.exit(8)

    # 2. Match LRC lines to transcribed segments
    pairs = match_lines_to_segments(lrc_lines, segments)

    # 3. Convert to phonemes
    espeak_lang = espeak_language_code(language)
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
