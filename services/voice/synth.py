#!/usr/bin/env python3
"""Synthesize speech to a WAV file with Kokoro.

Usage:
    uv run synth.py "text" --voice bm_lewis --lang en-gb --out out.wav
    uv run synth.py "texto" --voice em_alex --lang es --out salida.wav
"""

from __future__ import annotations

import argparse
import time
import wave
from pathlib import Path

import numpy as np
from kokoro_onnx import Kokoro

HERE = Path(__file__).resolve().parent
MODELS = HERE / "assets" / "models"
MODEL_PATH = MODELS / "kokoro-v1.0.onnx"
VOICES_PATH = MODELS / "voices-v1.0.bin"


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """Write float32 mono audio in [-1, 1] as 16-bit PCM WAV."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(sample_rate)
        fh.writeframes(pcm.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description="Kokoro TTS to WAV")
    parser.add_argument("text")
    parser.add_argument("--voice", default="bm_lewis")
    parser.add_argument("--lang", default="en-gb")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    started = time.perf_counter()
    kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
    loaded = time.perf_counter()
    samples, sample_rate = kokoro.create(
        args.text, voice=args.voice, speed=args.speed, lang=args.lang
    )
    spoken = time.perf_counter()

    write_wav(args.out, samples, sample_rate)
    duration = len(samples) / sample_rate
    print(
        f"{args.out}  voice={args.voice} lang={args.lang} "
        f"audio={duration:.2f}s load={loaded - started:.2f}s "
        f"infer={spoken - loaded:.2f}s rtf={(spoken - loaded) / duration:.2f}"
    )


if __name__ == "__main__":
    main()
