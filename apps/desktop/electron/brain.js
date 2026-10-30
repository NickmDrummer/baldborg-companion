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
import { listPendingReminders, prepareTool, toolDefinitions, toolsEnabled } from "./tools.js";
import { detectLanguage } from "./voice.js";

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

// Keep a generous window and trim in blocks: dropping two messages every turn
// changes the prompt prefix and throws away Ollama's prompt cache.
const MAX_TURNS = 20;
const TRIM_BLOCK_TURNS = 6;
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

function trimHistory(list) {
  const max = MAX_TURNS * 2;
  const slack = TRIM_BLOCK_TURNS * 2;
  return list.length <= max + slack ? list : list.slice(-max);
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
  const time = now.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = now.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  return (
    `Runtime context: it is ${time} on ${day} on the client's workstation. ` +
    "Weather, reminders, clock, workstation status and the client's football team are available through tools. " +
    "Do not repeat phrases or closings you have already used in this conversation."
  );
}

let warmed = false;

/**
 * Build Ollama's prompt cache for (system prompt + tool schema). On this CPU
 * the first request of a session costs ~15 s of prompt evaluation; doing it in
 * the background keeps the first real answer fast.
 */
export async function warmup(onState) {
  if (warmed) return;
  warmed = true;
  onState?.(true);
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
          ...history,
          { role: "system", content: clockContext() },
          { role: "user", content: "ping" },
        ],
        ...(toolsEnabled() ? { tools: toolDefinitions() } : {}),
        options: { num_predict: 1, num_ctx: config.numCtx },
      }),
    });
    console.info("[baldborg] prompt cache warmed");
  } catch (error) {
    console.warn("[baldborg] warmup failed:", error.message);
  } finally {
    onState?.(false);
  }
}

export function isBusy() {
  return busy;
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
    }, 90_000);

    confirmations.set(id, (accepted) => {
      clearTimeout(timer);
      resolve(accepted);
    });

    sink({ type: "confirm", id, summary });
  });
}

/* ------------------------------------------------------- reminder router -- */

/**
 * Reminders are too important to depend on the model deciding to call the
 * tool: "recuérdame X en 20 minutos" is parsed here and scheduled directly.
 */
function routeReminder(raw) {
  const TRIGGER =
    /\b(recu[eé]rdame|recordarme|recordatorio|remind me|set(?:e)? (?:me )?a reminder|set up a reminder|create a reminder)\b/i;
  if (!TRIGGER.test(raw)) return null;

  let minutes = null;
  let at = null;

  const inMinutes =
    raw.match(/\ben\s+(\d{1,3})\s*(minutos?|min)\b/i) ??
    raw.match(/\bin\s+(\d{1,3})\s*(minutes?|mins?)\b/i);
  const inHours =
    raw.match(/\ben\s+(\d{1,2})\s*horas?\b/i) ??
    raw.match(/\bin\s+(\d{1,2})\s*hours?\b/i);
  const atClock = raw.match(
    /\b(?:a\s+las?|at)\s+(\d{1,2})[:.](\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/i,
  );

  if (inMinutes) minutes = Number(inMinutes[1]);
  else if (inHours) minutes = Number(inHours[1]) * 60;
  if (atClock) {
    at = `${atClock[1]}:${atClock[2]}${atClock[3] ? ` ${atClock[3]}` : ""}`;
  }

  if (minutes === null && at === null) return null;

  let text = raw
    .replace(
      /^.*?\b(recu[eé]rdame|recordarme|remind me|set(?:e)? (?:me )?a reminder|set up a reminder|create a reminder)\b\s*/i,
      "",
    )
    .replace(/\b(?:a\s+las?|at)\s+\d{1,2}[:.]\d{2}\s*(am|pm|a\.m\.|p\.m\.)?/i, "")
    .replace(/\ben\s+\d{1,3}\s*(minutos?|min)\b/i, "")
    .replace(/\bin\s+\d{1,3}\s*(minutes?|mins?)\b/i, "")
    .replace(/\ben\s+\d{1,2}\s*horas?\b/i, "")
    .replace(/\bin\s+\d{1,2}\s*hours?\b/i, "")
    .trim()
    .replace(/^(de|que|para|to|with|about|that|so that)\s+/i, "")
    .replace(/[.,;]+$/, "")
    .trim();

  if (!text) text = "recordatorio";

  return { text, minutes, at, language: detectLanguage(raw) };
}

/** Questions about pending reminders are answered from the store, not the model. */
function routeReminderQuery(raw) {
  if (!/(recordatorio|reminder)/i.test(raw)) return null;
  if (/(recu[eé]rdame|recordarme|remind me|set(?:e)? (?:me )?a reminder|create a reminder)/i.test(raw)) {
    return null;
  }
  if (/\ben\s+\d|a\s+las?\s+\d|at\s+\d|in\s+\d/i.test(raw)) return null;
  if (!/(pendiente|tengo|hay|cu[aá]l|lista|pending|have|list|any|qu[eé])/i.test(raw)) return null;
  return { language: detectLanguage(raw) };
}

async function runReminderQuery(route, sink, userText) {
  const pending = listPendingReminders();
  const english = route.language === "en";
  const locale = english ? "en-US" : "es-MX";

  let text;
  if (!pending.length) {
    text = english
      ? "[[mood:neutral]] No pending reminders, sir. Your external memory is currently idle."
      : "[[mood:neutral]] No hay recordatorios pendientes, señor. Su memoria externa está ociosa.";
  } else {
    const items = pending.slice(0, 5).map((entry) => {
      const when = new Date(entry.at).toLocaleString(locale, {
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return `${entry.text} (${when})`;
    });
    const plural = pending.length > 1;
    text = english
      ? `[[mood:neutral]] You have ${pending.length} pending reminder${plural ? "s" : ""}: ${items.join(", ")}.`
      : `[[mood:neutral]] Tiene ${pending.length} recordatorio${plural ? "s" : ""} pendiente${plural ? "s" : ""}: ${items.join(", ")}.`;
  }

  const parsed = parseMood(text);
  history = trimHistory([
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: parsed.text },
  ]);
  saveHistory();
  sink({ type: "done", mood: parsed.mood, text: parsed.text, model: "router" });
}

async function runReminderRoute(route, sink, userText) {
  sink({ type: "tool", name: "set_reminder", status: "running" });

  let outcome;
  try {
    const prepared = prepareTool("set_reminder", {
      text: route.text,
      language: route.language,
      ...(route.minutes !== null ? { minutes: route.minutes } : { at: route.at }),
    });
    const accepted = await requestConfirmation(prepared.summary, sink);
    outcome = accepted ? await prepared.run() : { ok: false, cancelled: true };
  } catch (error) {
    outcome = { ok: false, error: error.message };
  }

  sink({ type: "tool", name: "set_reminder", status: "done" });

  const english = route.language === "en";
  const whenLabel = String(outcome.summary ?? "").replace(/^.*·\s*/, "");
  const text = outcome.ok
    ? english
      ? `[[mood:pleased]] Noted, sir. I will remind you about it ${whenLabel}.`
      : `[[mood:pleased]] Anotado, señor. Le recordaré el asunto ${whenLabel}.`
    : outcome.cancelled
      ? english
        ? "[[mood:neutral]] Cancelled or expired. The reminder does not exist."
        : "[[mood:neutral]] Cancelado o expirado. El recordatorio no existe."
      : english
        ? "[[mood:stern]] I could not schedule it. Check the time, sir."
        : "[[mood:stern]] No pude programarlo. Revise la hora, señor.";

  const parsed = parseMood(text);
  history = trimHistory([...history, { role: "user", content: userText }, { role: "assistant", content: parsed.text }]);
  saveHistory();
  sink({ type: "done", mood: parsed.mood, text: parsed.text, model: "router" });
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
      ...(toolsEnabled() ? { tools: toolDefinitions() } : {}),
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

  const handleLine = (line) => {
    if (!line) return;
    const event = JSON.parse(line);
    const piece = event.message?.content ?? "";
    if (piece) {
      text += piece;
      sink({ type: "chunk", text: piece });
    }
    if (event.message?.tool_calls?.length) toolCalls.push(...event.message.tool_calls);
    if (event.done) {
      console.info(
        `[baldborg] round: prompt ${event.prompt_eval_count ?? "?"} tokens in ` +
          `${Math.round((event.prompt_eval_duration ?? 0) / 1e6)} ms`,
      );
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  }
  handleLine(buffer.trim());

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
  // Volatile context goes last so Ollama's prompt cache keeps the stable
  // prefix (system prompt + history) between turns.
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "system", content: clockContext() },
    userEntry,
  ];

  let finalText = "";
  let reminderToolRan = false;

  try {
    const reminder = routeReminder(text);
    if (reminder) {
      await runReminderRoute(reminder, sink, text);
      busy = false;
      controller = null;
      return;
    }

    const query = routeReminderQuery(text);
    if (query) {
      await runReminderQuery(query, sink, text);
      busy = false;
      controller = null;
      return;
    }

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

        if (name === "set_reminder") reminderToolRan = true;

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

    let parsed = parseMood(finalText);

    // Small models sometimes keep the language of the previous turn. One
    // corrective round is cheap and deterministic.
    const expected = detectLanguage(text);
    if (detectLanguage(parsed.text) !== expected) {
      console.info(`[baldborg] wrong language, retrying in ${expected}`);
      sink({ type: "discard" });
      messages.push({ role: "assistant", content: finalText });
      messages.push({
        role: "system",
        content:
          `That answer was in the wrong language. Reply again, only in ` +
          `${expected === "es" ? "Spanish" : "English"}, ignoring the language of earlier turns.`,
      });
      const retry = await chatRound(messages, model, (event) => sink(event));
      if (retry.text.trim()) {
        finalText = retry.text;
        parsed = parseMood(finalText);
      }
    }

    // Guard against claiming a reminder that was never created.
    const reminderIntent =
      /(recu[eé]rdame|recordarme|recordatorio|remind me|set(?:e)? (?:me )?a reminder)/i.test(text);
    const claimsDone =
      /\b(programad[oa]|anotad[oa]|guardad[oa]|scheduled|noted|created|set up)\b/i.test(parsed.text);
    if (reminderIntent && !reminderToolRan && claimsDone) {
      finalText =
        detectLanguage(text) === "en"
          ? '[[mood:stern]] Nothing was scheduled, sir. I need a concrete time: "in 20 minutes" or "at 18:30".'
          : "[[mood:stern]] No he programado nada, señor. Necesito una hora concreta: «en 20 minutos» o «a las 18:30».";
      parsed = parseMood(finalText);
    }

    history = trimHistory([...history, userEntry, { role: "assistant", content: parsed.text }]);
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
