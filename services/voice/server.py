"""Local TTS sidecar for Delamain.

Kokoro-82M via kokoro-onnx, served over HTTP so the Electron main process can
request speech without paying the model load cost on every sentence.

Run with:
    uv run uvicorn server:app --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import io
import time
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from kokoro_onnx import Kokoro
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
MODEL_PATH = HERE / "assets" / "models" / "kokoro-v1.0.onnx"
VOICES_PATH = HERE / "assets" / "models" / "voices-v1.0.bin"

app = FastAPI(title="Delamain voice")

_kokoro: Kokoro | None = None


def model() -> Kokoro:
    global _kokoro
    if _kokoro is None:
        if not MODEL_PATH.exists():
            raise HTTPException(500, "missing kokoro model, run download_assets.sh")
        started = time.perf_counter()
        _kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
        print(f"[voice] model loaded in {time.perf_counter() - started:.2f}s", flush=True)
    return _kokoro


class SynthRequest(BaseModel):
    text: str
    voice: str = "em_alex"
    lang: str = "es"
    speed: float = 1.0


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


@app.get("/health")
def health() -> dict:
    return {"ok": True, "loaded": _kokoro is not None}


@app.post("/synth")
def synth(request: SynthRequest) -> Response:
    text = request.text.strip()
    if not text:
        raise HTTPException(400, "empty text")

    started = time.perf_counter()
    try:
        samples, sample_rate = model().create(
            text, voice=request.voice, speed=request.speed, lang=request.lang
        )
    except Exception as error:  # noqa: BLE001 - surface the reason to the client
        raise HTTPException(500, f"synth failed: {error}") from error

    payload = wav_bytes(samples, sample_rate)
    duration = len(samples) / sample_rate
    elapsed = time.perf_counter() - started
    print(
        f"[voice] {len(text)} chars -> {duration:.2f}s audio in {elapsed:.2f}s "
        f"(rtf {elapsed / duration:.2f}) voice={request.voice}",
        flush=True,
    )
    return Response(
        content=payload,
        media_type="audio/wav",
        headers={
            "X-Duration": f"{duration:.3f}",
            "X-Sample-Rate": str(sample_rate),
        },
    )
