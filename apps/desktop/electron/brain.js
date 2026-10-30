/**
 * Local brain: talks to Ollama over HTTP, keeps the conversation history and
 * streams tokens back to the renderer.
 *
 * The call lives in the main process because the renderer is a file:// page
 * (and localhost:5173 in dev); going through IPC avoids CORS and keeps the
 * model endpoint out of the UI.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMood, SYSTEM_PROMPT } from "../../../packages/persona/delamain.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");
const MEMORY_DIR = join(homedir(), ".config", "delamain");
const MEMORY_FILE = join(MEMORY_DIR, "memory.json");

const DEFAULTS = {
  host: "http://127.0.0.1:11434",
  model: "qwen3:4b-instruct-2507-q4_K_M",
  fallbackModel: "llama3.2:3b",
  numCtx: 8192,
  numPredict: 180,
  keepAlive: "30m",
  temperature: 0.85,
};

const MAX_TURNS = 10; // stored user/assistant pairs kept in the rolling window

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULTS, ...(raw.brain ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

const config = loadConfig();

/** @type {{ role: "user" | "assistant", content: string }[]} */
let history = loadHistory();
let controller = null;
let busy = false;

function loadHistory() {
  try {
    const raw = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
    if (Array.isArray(raw.history)) return raw.history.slice(-MAX_TURNS * 2);
  } catch {
    /* first run */
  }
  return [];
}

function saveHistory() {
  try {
    mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(MEMORY_FILE, JSON.stringify({ history }, null, 2));
  } catch (error) {
    console.warn("[delamain] could not persist memory:", error.message);
  }
}

function clockContext() {
  const now = new Date();
  const time = now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  const day = now.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  return `Runtime context: it is ${time} on ${day} on the client's workstation.`;
}

export function getHistory() {
  return history.map((entry) => ({ ...entry }));
}

export function resetHistory() {
  history = [];
  saveHistory();
}

/**
 * Stream one assistant reply.
 * @param {string} text user message
 * @param {(event: object) => void} sink receives chunk/done/error events
 * @param {string} [modelOverride]
 */
export async function startChat(text, sink, modelOverride) {
  if (busy) cancelChat(sink);
  busy = true;
  controller = new AbortController();

  const userEntry = { role: "user", content: text };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: clockContext() },
    ...history,
    userEntry,
  ];

  const model = modelOverride ?? config.model;
  let full = "";
  let done = false;
  const started = performance.now();
  let firstToken = null;

  try {
    const response = await fetch(`${config.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: config.keepAlive,
        options: {
          temperature: config.temperature,
          num_ctx: config.numCtx,
          num_predict: config.numPredict,
        },
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`ollama ${response.status}: ${await response.text()}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const event = JSON.parse(line);
        const piece = event.message?.content ?? "";
        if (piece) {
          if (firstToken === null) firstToken = performance.now();
          full += piece;
          sink({ type: "chunk", text: piece });
        }
        if (event.done) done = true;
      }
    }

    const parsed = parseMood(full);
    history = [
      ...history,
      userEntry,
      { role: "assistant", content: parsed.text },
    ].slice(-MAX_TURNS * 2);
    saveHistory();

    console.info(
      `[delamain] ${model}: first token ${(firstToken ?? started) - started} ms, ` +
        `total ${performance.now() - started} ms, ${parsed.text.length} chars`,
    );
    sink({ type: "done", mood: parsed.mood, text: parsed.text, model, complete: done });
  } catch (error) {
    if (error.name === "AbortError") {
      sink({ type: "done", mood: "neutral", text: "", cancelled: true });
    } else {
      console.warn("[delamain] brain error:", error.message);
      sink({
        type: "error",
        message: error.message,
        hint: "El núcleo local no responde. Verifique que ollama esté en marcha.",
      });
    }
  } finally {
    busy = false;
    controller = null;
  }
}

export function cancelChat(sink) {
  if (controller) {
    controller.abort();
    controller = null;
  }
  if (sink) sink({ type: "done", mood: "neutral", text: "", cancelled: true });
}
