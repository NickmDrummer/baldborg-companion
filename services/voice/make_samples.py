#!/usr/bin/env python3
"""Generate the voice approval samples for the Spanish and English voices."""

from __future__ import annotations

import time
from pathlib import Path

from kokoro_onnx import Kokoro

from synth import MODEL_PATH, VOICES_PATH, write_wav

OUT_DIR = Path(__file__).resolve().parent / "samples"

CASES = [
    (
        "en_bm_lewis.wav",
        "bm_lewis",
        "en-gb",
        "Good evening. I am Baldborg, your personal assistant. "
        "I have detected a twelve percent increase in your fatigue levels. "
        "I strongly suggest you consider taking a break, before your judgment degrades further.",
    ),
    (
        "es_em_alex.wav",
        "em_alex",
        "es",
        "Buenas noches. Soy Baldborg, su asistente personal. "
        "He detectado un incremento del doce por ciento en sus niveles de fatiga. "
        "Le sugiero encarecidamente que considere tomar un descanso, antes de que su juicio se deteriore aún más.",
    ),
]


def main() -> None:
    started = time.perf_counter()
    kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
    print(f"model loaded in {time.perf_counter() - started:.2f}s")

    for filename, voice, lang, text in CASES:
        t0 = time.perf_counter()
        samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang=lang)
        elapsed = time.perf_counter() - t0
        duration = len(samples) / sample_rate
        path = OUT_DIR / filename
        write_wav(path, samples, sample_rate)
        print(
            f"{path.name}: {duration:.2f}s audio, {elapsed:.2f}s inference "
            f"(rtf {elapsed / duration:.2f}) -> {path}"
        )


if __name__ == "__main__":
    main()
