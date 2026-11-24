#!/usr/bin/env python3
"""
Motor CapCut-Grade Auto Captions via faster-whisper (CPU INT8):
- Preserva obrigatoriamente o idioma original falado no video (task="transcribe", NUNCA translate)
- Usa initial_prompt contextual (titulo/canal/tags) para acertar nomes proprios e girias
- Usa condition_on_previous_text=False para impedir que um ruido pontual contamine frases seguintes
- Filtra segmentos/palavras de baixa confianca (ruido/musica)
- Agrupa em blocos curtos de 2 a 4 palavras estilo CapCut com timestamps word-level exatos e zero sobreposicao.
"""

import json
import os
import sys


def chunk_words_into_capcut_cues(segments, max_words=4, max_chars=26):
    raw_cues = []
    for seg in segments:
        # Ignora janelas de puro ruido/musica de fundo
        no_speech_prob = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
        if no_speech_prob > 0.78:
            continue

        words = getattr(seg, "words", None) or []
        if not words:
            text = (seg.text or "").strip()
            if text:
                raw_cues.append(
                    {
                        "startSec": round(max(0.0, float(seg.start)), 3),
                        "endSec": round(max(float(seg.start) + 0.22, float(seg.end)), 3),
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

            prob = float(getattr(w, "probability", 1.0) or 1.0)
            # Descarta alucinacoes isoladas de baixissima probabilidade em trechos de musica/efeito
            if prob < 0.14 and len(token) <= 3:
                continue

            w_start = max(0.0, float(w.start))
            w_end = max(w_start + 0.08, float(w.end))

            gap = (w_start - buf_end) if buf_end is not None else 0.0
            candidate_text = " ".join(buf_words + [token])

            if buf_words and (
                len(buf_words) >= max_words
                or len(candidate_text) > max_chars
                or gap >= 0.35
            ):
                raw_cues.append(
                    {
                        "startSec": round(buf_start, 3),
                        "endSec": round(max(buf_start + 0.18, buf_end), 3),
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

            if token.endswith((".", "!", "?", ",")) and len(buf_words) >= 2:
                raw_cues.append(
                    {
                        "startSec": round(buf_start, 3),
                        "endSec": round(max(buf_start + 0.18, buf_end), 3),
                        "text": " ".join(buf_words).strip(),
                    }
                )
                buf_words = []
                buf_start = None
                buf_end = None

        if buf_words and buf_start is not None and buf_end is not None:
            raw_cues.append(
                {
                    "startSec": round(buf_start, 3),
                    "endSec": round(max(buf_start + 0.18, buf_end), 3),
                    "text": " ".join(buf_words).strip(),
                }
            )

    # Garante zero sobreposicao temporal entre um bloco e o seguinte (transicao limpa estilo CapCut)
    for i in range(len(raw_cues) - 1):
        curr = raw_cues[i]
        nxt = raw_cues[i + 1]
        if curr["endSec"] > nxt["startSec"] - 0.02:
            curr["endSec"] = round(max(curr["startSec"] + 0.14, nxt["startSec"] - 0.02), 3)

    return raw_cues


def load_whisper_model(preferred_size):
    from faster_whisper import WhisperModel

    candidates = [preferred_size, "base", "tiny"]
    seen = set()
    for size in candidates:
        if not size or size in seen:
            continue
        seen.add(size)
        try:
            return WhisperModel(size, device="cpu", compute_type="int8")
        except Exception:
            continue
    raise RuntimeError("Nao foi possivel inicializar nenhum modelo faster-whisper")


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: transcribe_clip.py <audio_path> [language_hint] [context_prompt]"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    lang_hint = sys.argv[2].strip() if len(sys.argv) >= 3 and sys.argv[2].strip() else None
    if lang_hint in ("auto", "unknown", "null", "none"):
        lang_hint = None
    context_prompt = sys.argv[3].strip() if len(sys.argv) >= 4 and sys.argv[3].strip() else None
    model_size = os.environ.get("WHISPER_MODEL_SIZE", "small")

    model = load_whisper_model(model_size)

    # task="transcribe" + condition_on_previous_text=False + initial_prompt contextual:
    # evita que erros pontuais se propaguem ("intercalando partes certas e erradas")
    segments_gen, info = model.transcribe(
        audio_path,
        task="transcribe",
        language=lang_hint,
        initial_prompt=context_prompt[:240] if context_prompt else None,
        beam_size=4,
        best_of=4,
        temperature=0.0,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.3,
        vad_filter=True,
        vad_parameters=dict(
            threshold=0.45,
            min_speech_duration_ms=180,
            min_silence_duration_ms=300,
            speech_pad_ms=180,
        ),
        word_timestamps=True,
    )
    segments = list(segments_gen)
    cues = chunk_words_into_capcut_cues(segments)

    result = {
        "language": getattr(info, "language", lang_hint or "unknown"),
        "languageProbability": round(float(getattr(info, "language_probability", 0.0)), 3),
        "cues": cues,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
