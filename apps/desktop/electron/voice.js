/**
 * Voice sidecar client.
 *
 * Owns the Python Kokoro process (started on first use, one model load per
 * session) and turns text into a WAV buffer for the renderer to play.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig } from "./settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const VOICE_DIR = join(REPO_ROOT, "services", "voice");
const HOST = "http://127.0.0.1:8765";

const DEFAULTS = {
  autoSpeak: true,
  provider: "kokoro",
  es: { voice: "em_alex", lang: "es", speed: 1.0 },
  en: { voice: "bm_lewis", lang: "en-gb", speed: 1.0 },
  azure: {
    es: { voice: "es-MX-JorgeMultilingualNeural", lang: "es-MX" },
    en: { voice: "en-US-AndrewMultilingualNeural", lang: "en-US" },
  },
};

const VENV_PYTHON = join(VOICE_DIR, ".venv", "bin", "python");

const UV_CANDIDATES = [
  "uv",
  join(homedir(), ".local/share/mise/shims/uv"),
  join(homedir(), ".local/share/mise/installs/uv/latest/.mise-bins/uv"),
  join(homedir(), ".local/bin/uv"),
  "/usr/bin/uv",
];

let child = null;
let starting = null;
let uvIndex = 0;
let lastError = null;

function azureCredentials() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".config", "baldborg", "voice.json"), "utf8"));
  } catch {
    /* no optional cloud credentials */
  }
  return {
    key: process.env.AZURE_SPEECH_KEY ?? file.azureKey ?? null,
    region: process.env.AZURE_SPEECH_REGION ?? file.azureRegion ?? null,
  };
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function synthesizeAzure(text, lang, config) {
  const { key, region } = azureCredentials();
  if (!key || !region) throw new Error("Azure key/region not configured");

  const voice = config.azure?.[lang] ?? config.azure?.es;
  if (!voice?.voice) throw new Error("Azure voice not configured");

  const ssml =
    `<speak version="1.0" xml:lang="${voice.lang}">` +
    `<voice name="${voice.voice}">${escapeXml(text)}</voice></speak>`;

  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
        "User-Agent": "Baldborg",
      },
      body: ssml,
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`azure ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) throw new Error("azure returned empty audio");
  console.info(`[baldborg] azure tts: ${voice.voice} (${voice.lang})`);
  return { wav: buffer, lang, voice: voice.voice };
}

function voiceConfig() {
  try {
    const raw = readConfig();
    return { ...DEFAULTS, ...(raw.voice ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Cheap language guess: enough to pick between the Spanish and English voices. */
export function detectLanguage(text) {
  const sample = text.toLowerCase();
  // Accents are strong evidence for Spanish and cheap to check.
  const accent = /[ñáéíóúü¿¡]/.test(sample) ? 2 : 0;
  const es = (
    sample.match(
      /\b(el|la|los|las|un|una|unos|unas|de|del|que|qué|y|o|para|con|sin|su|sus|mi|mis|usted|señor|está|estoy|es|son|por|en|al|lo|le|les|se|no|sí|cómo|cuándo|dónde|quién|cuál|por qué|partido|juega|jugó|quedó|gracias|hola|buenos|días|favor|recordatorio|recuérdame|hora|clima|equipo|ciudad)\b/g,
    ) ?? []
  ).length;
  const en = (
    sample.match(
      /\b(the|a|an|and|or|of|to|in|on|at|for|with|without|you|your|is|are|was|were|be|been|do|does|did|can|could|will|would|should|have|has|had|this|that|these|those|it|its|i|my|me|we|our|they|their|he|she|his|her|what|when|where|why|how|which|who|not|no|yes|please|thanks|hello|hi|sir|remind|reminder|weather|time|team|match|play|plays|next|last|score|result|today|tomorrow)\b/g,
    ) ?? []
  ).length;
  return es + accent >= en ? "es" : "en";
}

async function isHealthy() {
  try {
    const response = await fetch(`${HOST}/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

function spawnServer() {
  // Prefer the project venv: one process, killed cleanly on quit. `uv run`
  // spawns the interpreter as a child and leaves it orphaned behind.
  const useVenv = existsSync(VENV_PYTHON);
  const binary = useVenv
    ? VENV_PYTHON
    : UV_CANDIDATES[Math.min(uvIndex, UV_CANDIDATES.length - 1)];
  const args = useVenv
    ? ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8765"]
    : ["run", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8765"];

  console.info(`[baldborg] starting voice sidecar with ${binary}`);

  const proc = spawn(binary, args, {
    cwd: VOICE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  proc.stdout.on("data", (data) => {
    const line = data.toString().trim();
    if (line) console.info(`[voice] ${line}`);
  });
  proc.stderr.on("data", (data) => {
    const line = data.toString().trim();
    if (line && !line.includes("Uvicorn running")) console.warn(`[voice] ${line}`);
  });
  proc.on("exit", (code) => {
    if (child === proc) {
      child = null;
      starting = null;
      if (code !== 0 && code !== null) lastError = `sidecar exited with ${code}`;
    }
  });
  proc.on("error", (error) => {
    console.warn(`[baldborg] voice spawn failed (${uv}): ${error.message}`);
    if (uvIndex < UV_CANDIDATES.length - 1) {
      uvIndex += 1;
      child = null;
      starting = null;
      startServer().catch(() => {});
    }
  });

  child = proc;
  return proc;
}

async function startServer() {
  if (await isHealthy()) return;
  if (!existsSync(join(VOICE_DIR, "server.py"))) {
    throw new Error("voice sidecar not found");
  }
  if (!child) spawnServer();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("voice sidecar did not become ready");
}

export async function ensureVoiceReady() {
  if (!starting) {
    starting = startServer().catch((error) => {
      starting = null;
      lastError = error.message;
      throw error;
    });
  }
  return starting;
}

/**
 * Synthesize text and return the WAV buffer plus the language used.
 * Returns null when the voice is disabled or unavailable.
 */
export function autoSpeakEnabled() {
  return voiceConfig().autoSpeak !== false;
}

export async function synthesize(text) {
  const config = voiceConfig();
  const lang = detectLanguage(text);
  const voice = config[lang] ?? config.es;

  if (config.provider === "azure") {
    try {
      const result = await synthesizeAzure(text, lang, config);
      lastError = null;
      return result;
    } catch (error) {
      lastError = error.message;
      console.warn("[baldborg] Azure TTS unavailable, using Kokoro:", error.message);
    }
  }

  try {
    await ensureVoiceReady();
    const response = await fetch(`${HOST}/synth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        voice: voice.voice,
        lang: voice.lang,
        speed: voice.speed ?? 1.0,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`voice ${response.status}: ${await response.text()}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    lastError = null;
    return { wav: buffer, lang, voice: voice.voice };
  } catch (error) {
    lastError = error.message;
    console.warn("[baldborg] synthesize failed:", error.message);
    return null;
  }
}

export function voiceStatus() {
  const config = voiceConfig();
  return {
    ready: Boolean(child),
    error: lastError,
    provider: config.provider ?? "kokoro",
    azureConfigured: Boolean(azureCredentials().key && azureCredentials().region),
  };
}

export function stopVoice() {
  if (!child) return;
  try {
    // Negative pid targets the whole process group (uvicorn workers included).
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  child = null;
  starting = null;
}
