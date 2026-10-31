/**
 * Push-to-talk capture and transcription.
 *
 * The compositor binds the hotkey and calls the control socket: "start" while
 * the key is held, "stop" on release. Recording goes through PipeWire
 * (`pw-record`), and the WAV is posted to the voice sidecar, which runs
 * faster-whisper on CPU. Nothing leaves the machine.
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureVoiceReady } from "./voice.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");

const HOST = "http://127.0.0.1:8765";
const SAMPLE_RATE = 16000;
/** Below this, it was a tap, not speech: cheaper to ignore than to transcribe. */
const MIN_SECONDS = 0.35;
const STOP_TIMEOUT = 2500;

/** @type {{ proc: import("node:child_process").ChildProcess, file: string, startedAt: number, stderr: string } | null} */
let session = null;

export function isListening() {
  return session !== null;
}

/**
 * Start recording. Returns false when a capture is already running.
 * Failures (no microphone, missing pw-record) surface on stop().
 */
export function startListening() {
  if (session) return false;

  const file = join(tmpdir(), `baldborg-ptt-${process.pid}.wav`);
  rmSync(file, { force: true });

  const proc = spawn(
    "pw-record",
    ["--rate", String(SAMPLE_RATE), "--channels", "1", "--format", "s16", file],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const current = { proc, file, startedAt: Date.now(), stderr: "" };
  session = current;

  proc.stderr.on("data", (chunk) => {
    if (session === current) current.stderr += chunk.toString();
  });
  proc.on("error", (error) => {
    current.stderr += error.message;
    if (session === current) session = null;
  });

  console.info("[baldborg] listening");
  return true;
}

function collect(current) {
  const seconds = (Date.now() - current.startedAt) / 1000;
  try {
    const size = statSync(current.file).size;
    // 44-byte header + 2 bytes per sample.
    if (size < 44 + SAMPLE_RATE * 2 * MIN_SECONDS) {
      console.info(`[baldborg] capture too short (${seconds.toFixed(2)}s)`);
      return null;
    }
    return { wav: readFileSync(current.file), seconds };
  } catch (error) {
    console.warn("[baldborg] capture unavailable:", error.message, current.stderr.trim());
    return null;
  } finally {
    rmSync(current.file, { force: true });
  }
}

/**
 * Stop recording and resolve with the captured WAV. `null` when the clip is
 * too short or the recorder failed.
 */
export function stopListening() {
  const current = session;
  session = null;
  if (!current) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(collect(current));
    };

    current.proc.once("close", finish);
    try {
      // SIGINT makes pw-record write the final WAV header.
      current.proc.kill("SIGINT");
    } catch {
      finish();
    }
    setTimeout(() => {
      try {
        current.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish();
    }, STOP_TIMEOUT).unref?.();
  });
}

function sttConfig() {
  try {
    const voice = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).voice ?? {};
    return { model: "small", language: "auto", ...(voice.stt ?? {}) };
  } catch {
    return { model: "small", language: "auto" };
  }
}

/** Kill any capture without transcribing (used when the app quits). */
export function abortListening() {
  const current = session;
  session = null;
  if (!current) return;
  try {
    current.proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(current.file, { force: true });
}

/** Load the model in the sidecar so the first hotkey press is not slow. */
export async function warmTranscription() {
  const { model } = sttConfig();
  await ensureVoiceReady();
  const response = await fetch(`${HOST}/warm?model=${encodeURIComponent(model)}`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`warm-up failed (${response.status})`);
  console.info(`[baldborg] stt ready (${model})`);
}

export async function transcribe(wav) {
  const { model, language } = sttConfig();
  await ensureVoiceReady();

  const params = new URLSearchParams({ model, language });
  const response = await fetch(`${HOST}/transcribe?${params}`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`transcription failed (${response.status})`);
  return response.json();
}
