#!/usr/bin/env python3
"""
Transcreve o audio real de um clipe de video usando faster-whisper (CPU INT8),
preservando obrigatoriamente o idioma original falado no video (task="transcribe", NUNCA translate)
e gerando legendas curtas sincronizadas por timestamp para YouTube Shorts.
"""

import json
import os
import sys


def chunk_words_into_short_cues(segments, max_words=5, max_chars=34):
    cues = []
    for seg in segments:
        words = getattr(seg, "words", None) or []
        if not words:
            text = (seg.text or "").strip()
            if text:
                cues.append(
                    {
                        "startSec": round(max(0.0, float(seg.start)), 3),
                        "endSec": round(max(float(seg.start) + 0.25, float(seg.end)), 3),
                        "text": text,
                    }
                )
            continue

        buf_words = []
        buf_start = None
        buf_end = None

        for w in words:
            token = (w.word or "").strip()
            if not token:
                continue

            w_start = max(0.0, float(w.start))
            w_end = max(w_start + 0.08, float(w.end))

            gap = (w_start - buf_end) if buf_end is not None else 0.0
            candidate_text = " ".join(buf_words + [token])

            if buf_words and (
                len(buf_words) >= max_words
                or len(candidate_text) > max_chars
                or gap >= 0.45
            ):
                cues.append(
                    {
                        "startSec": round(buf_start, 3),
                        "endSec": round(max(buf_start + 0.2, buf_end), 3),
                        "text": " ".join(buf_words).strip(),
                    }
                )
                buf_words = []
                buf_start = None
                buf_end = None

            if buf_start is None:
                buf_start = w_start
            buf_words.append(token)
            buf_end = w_end

            if token.endswith((".", "!", "?")) and len(buf_words) >= 2:
                cues.append(
                    {
                        "startSec": round(buf_start, 3),
                        "endSec": round(max(buf_start + 0.2, buf_end), 3),
                        "text": " ".join(buf_words).strip(),
                    }
                )
                buf_words = []
                buf_start = None
                buf_end = None

        if buf_words and buf_start is not None and buf_end is not None:
            cues.append(
                {
                    "startSec": round(buf_start, 3),
                    "endSec": round(max(buf_start + 0.2, buf_end), 3),
                    "text": " ".join(buf_words).strip(),
                }
            )

    return cues


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: transcribe_clip.py <audio_path> [language_hint]"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    lang_hint = sys.argv[2].strip() if len(sys.argv) >= 3 and sys.argv[2].strip() else None
    model_size = os.environ.get("WHISPER_MODEL_SIZE", "base")

    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    # task="transcribe" garante que o idioma falado original seja preservado (NUNCA traduz!)
    segments_gen, info = model.transcribe(
        audio_path,
        task="transcribe",
        language=lang_hint,
        beam_size=2,
        vad_filter=True,
        word_timestamps=True,
    )
    segments = list(segments_gen)
    cues = chunk_words_into_short_cues(segments)

    result = {
        "language": getattr(info, "language", lang_hint or "unknown"),
        "languageProbability": round(float(getattr(info, "language_probability", 0.0)), 3),
        "cues": cues,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
