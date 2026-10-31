"""Local TTS sidecar for Baldborg.

Kokoro-82M via kokoro-onnx, served over HTTP so the Electron main process can
request speech without paying the model load cost on every sentence.

Run with:
    uv run uvicorn server:app --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import io
import os
import time
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from kokoro_onnx import Kokoro
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
MODEL_PATH = HERE / "assets" / "models" / "kokoro-v1.0.onnx"
VOICES_PATH = HERE / "assets" / "models" / "voices-v1.0.bin"

app = FastAPI(title="Baldborg voice")

_kokoro: Kokoro | None = None
_whisper = None
_whisper_name = ""

# Multilingual models we accept from the client. Anything else falls back to
# "small", which is the accuracy/latency sweet spot on CPU.
STT_MODELS = {"tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"}


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


def stt_model(name: str):
    """Load faster-whisper lazily: it costs RAM that the brain may need."""
    global _whisper, _whisper_name
    if _whisper is not None and _whisper_name == name:
        return _whisper

    from faster_whisper import WhisperModel

    threads = min(8, os.cpu_count() or 4)
    started = time.perf_counter()
    _whisper = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
    _whisper_name = name
    print(
        f"[voice] stt model {name} loaded in {time.perf_counter() - started:.2f}s "
        f"({threads} threads)",
        flush=True,
    )
    return _whisper


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """Decode a PCM16 WAV into mono float32 at 16 kHz."""
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as error:
        raise HTTPException(400, f"invalid wav: {error}") from error

    if width != 2:
        raise HTTPException(400, "expected 16-bit PCM")

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if rate != 16000:
        duration = len(samples) / rate
        target = max(1, int(duration * 16000))
        samples = np.interp(
            np.linspace(0, len(samples) - 1, target),
            np.arange(len(samples)),
            samples,
        ).astype(np.float32)

    return samples, 16000


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "loaded": _kokoro is not None,
        "stt": _whisper_name or None,
    }


def run_transcription(data: bytes, model: str, language: str) -> dict:
    if len(data) <= 44:
        return {"text": "", "language": None, "duration": 0.0}

    samples, rate = decode_wav(data)
    duration = len(samples) / rate
    if duration < 0.2:
        return {"text": "", "language": None, "duration": round(duration, 2)}

    name = model if model in STT_MODELS else "small"
    target = None if language in ("", "auto") else language

    started = time.perf_counter()
    segments, info = stt_model(name).transcribe(
        samples,
        language=target,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    elapsed = time.perf_counter() - started

    print(
        f"[voice] stt {duration:.2f}s audio -> {len(text)} chars in {elapsed:.2f}s "
        f"lang={info.language} ({info.language_probability:.2f}) model={name}",
        flush=True,
    )
    return {
        "text": text,
        "language": info.language,
        "probability": round(info.language_probability, 3),
        "duration": round(duration, 2),
        "elapsed": round(elapsed, 2),
    }


@app.get("/warm")
def warm(model: str = "small") -> dict:
    """Load the STT model ahead of the first hotkey press."""
    name = model if model in STT_MODELS else "small"
    stt_model(name)
    return {"ok": True, "model": name}


@app.post("/transcribe")
async def transcribe(request: Request, model: str = "small", language: str = "auto") -> dict:
    data = await request.body()
    # Whisper is CPU-heavy and releases the GIL; keep the event loop free so
    # TTS and health checks still answer while a phrase is being transcribed.
    return await run_in_threadpool(run_transcription, data, model, language)


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
