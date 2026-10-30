/**
 * Local brain: talks to Ollama over HTTP, runs the tool loop, keeps the
 * conversation history and streams tokens back to the renderer.
 *
 * Tool calls are executed in the main process; anything with side effects
 * (reminders) asks the renderer for confirmation before running.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMood, SYSTEM_PROMPT } from "../../../packages/persona/baldborg.mjs";
import { prepareTool, TOOL_DEFINITIONS, toolsEnabled } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");
const MEMORY_DIR = join(homedir(), ".config", "baldborg");
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

const MAX_TURNS = 10;
const MAX_TOOL_ROUNDS = 4;

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

/** Pending user confirmations: id -> resolve(accepted). */
const confirmations = new Map();
let confirmationSeq = 0;

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
    console.warn("[baldborg] could not persist memory:", error.message);
  }
}

function clockContext() {
  const now = new Date();
  const time = now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  const day = now.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  return (
    `Runtime context: it is ${time} on ${day} on the client's workstation. ` +
    "Weather, reminders, clock, workstation status and the client's football team are available through tools."
  );
}

let warmed = false;

/**
 * Build Ollama's prompt cache for (system prompt + tool schema). On this CPU
 * the first request of a session costs ~15 s of prompt evaluation; doing it in
 * the background keeps the first real answer fast.
 */
export async function warmup() {
  if (warmed) return;
  warmed = true;
  try {
    await fetch(`${config.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: config.model,
        stream: false,
        keep_alive: config.keepAlive,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: clockContext() },
          { role: "user", content: "ping" },
        ],
        ...(toolsEnabled() ? { tools: TOOL_DEFINITIONS } : {}),
        options: { num_predict: 1, num_ctx: config.numCtx },
      }),
    });
    console.info("[baldborg] prompt cache warmed");
  } catch (error) {
    console.warn("[baldborg] warmup failed:", error.message);
  }
}

export function getHistory() {
  return history.map((entry) => ({ ...entry }));
}

export function resetHistory() {
  history = [];
  saveHistory();
}

/** Resolve a pending confirmation; called from the IPC layer. */
export function confirmAction(id, accepted) {
  const resolve = confirmations.get(id);
  if (!resolve) return false;
  confirmations.delete(id);
  resolve(Boolean(accepted));
  return true;
}

function requestConfirmation(summary, sink) {
  const id = `c${(confirmationSeq += 1)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      confirmations.delete(id);
      sink({ type: "confirm-cancel", id });
      resolve(false);
    }, 120_000);

    confirmations.set(id, (accepted) => {
      clearTimeout(timer);
      resolve(accepted);
    });

    sink({ type: "confirm", id, summary });
  });
}

/** One request/response round against Ollama. */
async function chatRound(messages, model, sink) {
  const response = await fetch(`${config.host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: config.keepAlive,
      ...(toolsEnabled() ? { tools: TOOL_DEFINITIONS } : {}),
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
  let text = "";
  const toolCalls = [];

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
        text += piece;
        sink({ type: "chunk", text: piece });
      }
      if (event.message?.tool_calls?.length) toolCalls.push(...event.message.tool_calls);
    }
  }

  return { text, toolCalls };
}

/**
 * Stream one assistant reply, running tools as needed.
 * @param {string} text user message
 * @param {(event: object) => void} sink receives chunk/tool/confirm/done/error
 * @param {string} [modelOverride]
 */
export async function startChat(text, sink, modelOverride) {
  if (busy) cancelChat(sink);
  busy = true;
  controller = new AbortController();

  const model = modelOverride ?? config.model;
  const started = performance.now();
  let firstToken = null;

  const userEntry = { role: "user", content: text };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: clockContext() },
    ...history,
    userEntry,
  ];

  let finalText = "";

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const result = await chatRound(messages, model, (event) => {
        if (firstToken === null) firstToken = performance.now();
        sink(event);
      });

      if (!result.toolCalls.length) {
        finalText = result.text;
        break;
      }

      // The text of a tool-calling round is internal reasoning, not the answer.
      sink({ type: "discard" });
      messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });

      for (const call of result.toolCalls) {
        const name = call.function?.name ?? "unknown";
        sink({ type: "tool", name, status: "running" });

        let outcome;
        try {
          const prepared = prepareTool(name, call.function?.arguments);
          if (prepared.requiresConfirmation) {
            const accepted = await requestConfirmation(prepared.summary, sink);
            outcome = accepted
              ? await prepared.run()
              : { ok: false, error: "El cliente canceló la acción." };
          } else {
            outcome = await prepared.run();
          }
        } catch (error) {
          outcome = { ok: false, error: error.message };
        }

        console.info(
          `[baldborg] tool ${name}: ${outcome.ok ? "ok" : outcome.error ?? "failed"}`,
        );
        sink({ type: "tool", name, status: "done" });
        messages.push({ role: "tool", content: JSON.stringify(outcome) });
      }
    }

    if (!finalText.trim()) {
      finalText =
        "[[mood:neutral]] Mis registros no devolvieron una conclusión útil, señor. " +
        "¿Desea que lo intente por otra vía?";
    }

    const parsed = parseMood(finalText);
    history = [...history, userEntry, { role: "assistant", content: parsed.text }].slice(-MAX_TURNS * 2);
    saveHistory();

    console.info(
      `[baldborg] ${model}: first token ${(firstToken ?? started) - started} ms, ` +
        `total ${performance.now() - started} ms, ${parsed.text.length} chars`,
    );
    sink({ type: "done", mood: parsed.mood, text: parsed.text, model });
  } catch (error) {
    if (error.name === "AbortError") {
      sink({ type: "done", mood: "neutral", text: "", cancelled: true });
    } else {
      console.warn("[baldborg] brain error:", error.message);
      sink({
        type: "error",
        message: error.message,
        hint: "El núcleo local no responde. Verifique que ollama esté en marcha.",
      });
    }
  } finally {
    busy = false;
    controller = null;
    for (const resolve of confirmations.values()) resolve(false);
    confirmations.clear();
  }
}

export function cancelChat(sink) {
  if (controller) {
    controller.abort();
    controller = null;
  }
  for (const resolve of confirmations.values()) resolve(false);
  confirmations.clear();
  if (sink) sink({ type: "done", mood: "neutral", text: "", cancelled: true });
}
