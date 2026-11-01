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
import {
  configuredCity,
  configuredTeam,
  listPendingReminders,
  parseConversionQuery,
  parseCurrencyQuery,
  prepareTool,
  toolDefinitions,
  toolsEnabled,
} from "./tools.js";
import {
  forgetFact,
  listFacts,
  memoryBlock,
  parseMemoryIntent,
  rememberFact,
} from "./memory.js";
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
  think: false,
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
    "Weather, reminders, clock, workstation status, the client's football team, dollar and currency rates, " +
    "unit conversion, the local calendar and Epic free games are available through tools. " +
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
        think: config.think,
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

function needsWeatherTool(text) {
  return /\b(clima|temperatura|lluvia|llueve|llover|calor|fr[ií]o|humedad|viento|paraguas|weather|forecast|temperature|rain|raining|hot|cold|humidity|wind|umbrella)\b/i.test(
    text,
  );
}

function extractCity(text) {
  const match = text.match(
    /\b(?:en|de|del|in|for|at)\s+([\p{Lu}][\p{L}\p{M}'-]*(?:\s+[\p{Lu}][\p{L}\p{M}'-]*)*)/u,
  );
  if (!match) return null;
  const city = match[1].replace(/[?.!,;:]+$/g, "").trim();
  const stop = /^(hoy|mañana|manana|esta|este|la|el|the|today|tomorrow|morning|afternoon|evening|night)$/i;
  return city.length >= 3 && !stop.test(city) ? city : null;
}

function needsTeamTool(text) {
  return /\b(cu[aá]ndo (juega|jugar[aá])|pr[oó]xim[oa] partido|partidos|fixtures?|resultado|marcador|c[oó]mo qued[oó]|when (does|do|is) .* play|next match|last result|score)\b/i.test(
    text,
  );
}

function needsSystemTool(text) {
  return /\b(gpu|vram|gr[aá]fica|tarjeta gr[aá]fica|memoria ram|ram|bater[ií]a|battery|uptime|carga (del|de la) (sistema|equipo|m[aá]quina)|uso de (cpu|memoria|gpu)|system status|workstation status|estado del (equipo|sistema))\b/i.test(
    text,
  );
}

function needsCalendarTool(text) {
  return (
    /\b(agenda|calendario|calendar)\b/i.test(text) ||
    /\b(qu[eé] tengo|what do i have|pr[oó]xim[oa]s? (evento|reuni[oó]n)|next (event|meeting)|mis (eventos|reuniones)|my (events|meetings))\b/i.test(
      text,
    )
  );
}

function needsEpicTool(text) {
  return /\b(epic|juegos gratis|juego gratis|free games?|gratis en epic)\b/i.test(text);
}

function calendarDays(text) {
  const match = text.match(/\b(?:pr[oó]xim[oa]s?|next|en los pr[oó]ximos)\s+(\d{1,2})\s*(d[ií]as?|days?)\b/i);
  if (match) return Math.min(90, Math.max(1, Number(match[1])));
  if (/\b(hoy|today)\b/i.test(text)) return 1;
  if (/\b(mañana|tomorrow)\b/i.test(text)) return 2;
  if (/\b(esta semana|this week)\b/i.test(text)) return 7;
  return 7;
}

function authoritativeToolBrief(english, labelEs, labelEn, data) {
  return english
    ? `Authoritative ${labelEn} result for this turn: ${JSON.stringify(data)}. ` +
        "Answer only from these data, never from memory. Do not call the tool again."
    : `Resultado autoritativo de ${labelEs} para este turno: ${JSON.stringify(data)}. ` +
        "Responda solo con estos datos, nunca de memoria. No vuelva a llamar a la herramienta.";
}

/** True when the question is about the configured team, not another club. */
function mentionsConfiguredTeam(text) {
  const words = configuredTeam()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 4);
  const sample = text.toLowerCase();
  return words.some((word) => sample.includes(word));
}

function genericTeamQuestion(text) {
  return /(mi equipo|nuestro equipo|el equipo|pr[oó]xim[oa] partido|[uú]ltimo partido|my team|next match|last match)/i.test(
    text,
  );
}

/** "el último partido del Real Madrid" must not be answered with Bayern data. */
function namesAnotherTeam(text) {
  const match = text.match(
    /\b(?:de|del|of)\s+([\p{Lu}][\p{L}\p{M}'-]*(?:\s+[\p{Lu}][\p{L}\p{M}'-]*)*)/u,
  );
  if (!match) return false;
  return !mentionsConfiguredTeam(match[1]);
}

async function runMemoryRoute(route, sink, userText) {
  const english = detectLanguage(userText) === "en";
  let text;

  if (route.action === "list") {
    const facts = listFacts();
    if (!facts.length) {
      text = english
        ? "[[mood:neutral]] My long-term memory is empty, sir."
        : "[[mood:neutral]] Mi memoria de largo plazo está vacía, señor.";
    } else {
      const shown = facts.slice(0, 8).map((fact) => `${fact.key} = ${fact.value}`).join("; ");
      const more = facts.length > 8 ? (english ? "; more…" : "; y más…") : "";
      text = english
        ? `[[mood:wry]] I remember ${facts.length} fact${facts.length === 1 ? "" : "s"}: ${shown}${more}.`
        : `[[mood:wry]] Recuerdo ${facts.length} hecho${facts.length === 1 ? "" : "s"}: ${shown}${more}.`;
    }
  } else if (route.action === "save") {
    const existing = listFacts().find((fact) => fact.key === route.key);
    const summary = english
      ? `${existing ? "Update" : "Save"} memory: ${route.key} = ${route.value}`
      : `${existing ? "Actualizar" : "Guardar"} en memoria: ${route.key} = ${route.value}`;
    const accepted = await requestConfirmation(summary, sink);

    if (!accepted) {
      text = english
        ? "[[mood:neutral]] I did not store it, sir."
        : "[[mood:neutral]] No lo he guardado, señor.";
    } else {
      try {
        rememberFact(route.key, route.value);
        text = english
          ? `[[mood:pleased]] Stored in permanent memory: ${route.key} = ${route.value}.`
          : `[[mood:pleased]] Guardado en mi memoria permanente: ${route.key} = ${route.value}.`;
      } catch (error) {
        text = english
          ? `[[mood:stern]] I could not store it: ${error.message}.`
          : `[[mood:stern]] No pude guardarlo: ${error.message}.`;
      }
    }
  } else if (route.action === "forget") {
    const exists = listFacts().some((fact) => fact.key === route.key);
    if (!exists) {
      text = english
        ? `[[mood:wry]] I have nothing stored under ${route.key}, sir.`
        : `[[mood:wry]] No tengo nada guardado bajo ${route.key}, señor.`;
    } else {
      const summary = english
        ? `Delete memory: ${route.key}`
        : `Borrar de memoria: ${route.key}`;
      const accepted = await requestConfirmation(summary, sink);
      if (!accepted) {
        text = english
          ? "[[mood:neutral]] I left it in place, sir."
          : "[[mood:neutral]] Lo he dejado como estaba, señor.";
      } else {
        forgetFact(route.key);
        text = english
          ? `[[mood:neutral]] Deleted ${route.key} from memory.`
          : `[[mood:neutral]] He borrado ${route.key} de mi memoria.`;
      }
    }
  } else {
    return;
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
async function chatRound(messages, model, sink, useTools = true) {
  const withTools = useTools && toolsEnabled();
  const response = await fetch(`${config.host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: config.keepAlive,
      ...(withTools ? { tools: toolDefinitions() } : {}),
      think: config.think,
      options: {
        temperature: withTools ? config.temperature : 0.2,
        num_ctx: config.numCtx,
        num_predict: withTools ? config.numPredict : 512,
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
export async function startChat(text, sink, modelOverride, languageOverride) {
  if (busy) cancelChat(sink);
  busy = true;
  controller = new AbortController();

  const model = modelOverride ?? config.model;
  const started = performance.now();
  let firstToken = null;

  const userEntry = { role: "user", content: text };
  const expectedLanguage = languageOverride ?? detectLanguage(text);
  const languageInstruction =
    expectedLanguage === "en"
      ? "Reply only in English."
      : "Reply only in Spanish, using formal usted.";
  // Volatile context goes last so Ollama's prompt cache keeps the stable
  // prefix (system prompt + history) between turns.
  const memory = memoryBlock(text);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "system", content: clockContext() },
    { role: "system", content: languageInstruction },
    ...(memory ? [{ role: "system", content: memory }] : []),
    userEntry,
  ];

  // The model answers football questions from memory too often. For the
  // configured team we fetch the fixtures first and hand them over as the only
  // valid source; other clubs still go through the normal tool call.
  const english = expectedLanguage === "en";
  if (
    toolsEnabled() &&
    needsTeamTool(text) &&
    (mentionsConfiguredTeam(text) || (genericTeamQuestion(text) && !namesAnotherTeam(text)))
  ) {
    let fixtures = null;
    try {
      const prepared = prepareTool("team_fixtures", {});
      fixtures = await prepared.run();
    } catch (error) {
      console.warn("[baldborg] fixture prefetch failed:", error.message);
    }
    console.info(
      `[baldborg] fixtures prefetch: ${fixtures ? fixtures.team : "failed"}`,
    );

    const brief = fixtures
      ? english
        ? { team: fixtures.team, summary: fixtures.summaryEn }
        : { team: fixtures.team, summary: fixtures.summary }
      : null;
    messages.push({
      role: "system",
      content: brief
        ? english
          ? `Authoritative team_fixtures result for this turn: ${JSON.stringify(brief)}. ` +
            "Answer only from these data, never from memory. Times are already in the " +
            "client's local timezone; do not convert them."
          : `Resultado autoritativo de team_fixtures para este turno: ${JSON.stringify(brief)}. ` +
            "Responda solo con estos datos, nunca de memoria. Las horas ya están en la " +
            "zona horaria local del cliente; no las convierta."
        : english
          ? "The fixture lookup failed. Say so plainly; do not invent a match or a score."
          : "La consulta de partidos falló. Dígalo claramente; no invente un partido ni un marcador.",
    });
  } else if (toolsEnabled() && needsTeamTool(text)) {
    // Another club: the model must call the tool with its name.
    messages.push({
      role: "system",
      content: english
        ? "This is a football question about another club. Call team_fixtures with " +
          "that club's name before replying. Never answer from memory. Times are " +
          "already local; do not convert them."
        : "Esta es una pregunta de fútbol sobre otro club. Llame a team_fixtures " +
          "con el nombre de ese club antes de responder. No responda de memoria. " +
          "Las horas ya son locales; no las convierta.",
    });
  }

  // Same problem as fixtures: the model prefers to refuse. Give it the real
  // weather for the requested or configured city before it answers.
  let weatherData = null;
  if (toolsEnabled() && needsWeatherTool(text)) {
    const city = extractCity(text);
    try {
      const prepared = prepareTool("get_weather", city ? { city } : {});
      weatherData = await prepared.run();
    } catch (error) {
      console.warn("[baldborg] weather prefetch failed:", error.message);
    }
    console.info(
      `[baldborg] weather prefetch: ${weatherData ? weatherData.place : "failed"}`,
    );

    messages.push({
      role: "system",
      content: weatherData
        ? english
          ? `Authoritative weather data for this turn: ${JSON.stringify({
              place: weatherData.place,
              summary: weatherData.summaryEn,
            })}. Answer only from these data, never from memory. Do not refuse: the data is available.`
          : `Datos autoritativos del clima para este turno: ${JSON.stringify({
              place: weatherData.place,
              summary: weatherData.summary,
            })}. Responda solo con estos datos, nunca de memoria. No se niegue: los datos están disponibles.`
        : english
          ? "The weather lookup failed. Say so plainly; do not invent a forecast."
          : "La consulta del clima falló. Dígalo claramente; no invente un pronóstico.",
    });
  }

  // Deterministic lookups: fetch first and hand the model the result, so a
  // small local model cannot refuse or invent numbers.
  if (toolsEnabled() && parseConversionQuery(text)) {
    const conversion = parseConversionQuery(text);
    try {
      const converted = await prepareTool("convert_units", conversion).run();
      messages.push({
        role: "system",
        content: authoritativeToolBrief(
          english,
          "convert_units",
          "convert_units",
          english ? converted.summaryEn : converted.summary,
        ),
      });
    } catch (error) {
      console.warn("[baldborg] conversion prefetch failed:", error.message);
    }
  }

  if (toolsEnabled() && parseCurrencyQuery(text)) {
    try {
      const rate = await prepareTool("get_exchange_rate", parseCurrencyQuery(text)).run();
      messages.push({
        role: "system",
        content: authoritativeToolBrief(
          english,
          "get_exchange_rate",
          "get_exchange_rate",
          english ? rate.summaryEn : rate.summary,
        ),
      });
    } catch (error) {
      console.warn("[baldborg] currency prefetch failed:", error.message);
      messages.push({
        role: "system",
        content: english
          ? "The exchange-rate lookup failed. Say so plainly; do not invent a rate."
          : "La consulta de cotizaciones falló. Dígalo claramente; no invente una cotización.",
      });
    }
  }

  if (toolsEnabled() && needsSystemTool(text)) {
    try {
      const status = await prepareTool("system_status", {}).run();
      messages.push({
        role: "system",
        content: authoritativeToolBrief(
          english,
          "system_status",
          "system_status",
          english ? status.summaryEn : status.summary,
        ),
      });
    } catch (error) {
      console.warn("[baldborg] system status prefetch failed:", error.message);
    }
  }

  if (toolsEnabled() && needsCalendarTool(text)) {
    try {
      const agenda = await prepareTool("calendar_events", { days: calendarDays(text) }).run();
      messages.push({
        role: "system",
        content: authoritativeToolBrief(
          english,
          "calendar_events",
          "calendar_events",
          english ? agenda.summaryEn : agenda.summary,
        ),
      });
    } catch (error) {
      console.warn("[baldborg] calendar prefetch failed:", error.message);
      messages.push({
        role: "system",
        content: english
          ? "The local calendar lookup failed. Say so plainly; do not invent events."
          : "La consulta del calendario local falló. Dígalo claramente; no invente eventos.",
      });
    }
  }

  if (toolsEnabled() && needsEpicTool(text)) {
    try {
      const epic = await prepareTool("epic_free_games", {}).run();
      messages.push({
        role: "system",
        content: authoritativeToolBrief(
          english,
          "epic_free_games",
          "epic_free_games",
          english ? epic.summaryEn : epic.summary,
        ),
      });
    } catch (error) {
      console.warn("[baldborg] epic prefetch failed:", error.message);
      messages.push({
        role: "system",
        content: english
          ? "The Epic free-games lookup failed. Say so plainly; do not invent games."
          : "La consulta de juegos gratis de Epic falló. Dígalo claramente; no invente juegos.",
      });
    }
  }

  let finalText = "";
  let reminderToolRan = false;

  try {
    const memoryIntent = parseMemoryIntent(text);
    if (memoryIntent) {
      await runMemoryRoute(memoryIntent, sink, text);
      busy = false;
      controller = null;
      return;
    }

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
    // Speech recognition reports the spoken language directly, which is more
    // reliable than a stop-word guess on a short utterance.
    const expected = expectedLanguage;
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

    // If the model still refuses despite having the data, answer directly.
    const refusal =
      /\b(cannot|can't|can not|unable|not within|no puedo|no tengo acceso|fuera de mi alcance|no monitor|no dispongo|no est[aá] a mi alcance)\b/i;
    if (weatherData && refusal.test(parsed.text)) {
      finalText = `[[mood:neutral]] ${english ? weatherData.summaryEn : weatherData.summary}`;
      parsed = parseMood(finalText);
    }

    // Guard against claiming a reminder that was never created.
    const reminderIntent =
      /(recu[eé]rdame|recordarme|recordatorio|remind me|set(?:e)? (?:me )?a reminder)/i.test(text);
    const claimsDone =
      /\b(programad[oa]|anotad[oa]|guardad[oa]|scheduled|noted|created|set up)\b/i.test(parsed.text);
    if (reminderIntent && !reminderToolRan && claimsDone) {
      finalText =
        expected === "en"
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

/**
 * One-shot text utility (translation or grammar correction).
 * It is not part of the conversation: no persona, no history, no tools.
 */
export async function startTask(kind, text, target, sink, language = "es") {
  if (busy) cancelChat(sink);
  busy = true;
  controller = new AbortController();

  const english = language === "en";
  const model = config.model;
  const task = kind === "correct" ? "correct" : "translate";
  const destination = target === "en" ? "English" : "Spanish";

  const system =
    task === "translate"
      ? `You are a precise translator. Translate the user's text into ${destination}. ` +
        "Preserve meaning, tone and formatting. Return only the translation, without quotes, " +
        "labels or commentary. If the text is already in the target language, return it unchanged."
      : "You are a careful copy editor. Correct spelling, grammar, punctuation and awkward phrasing " +
        "in the user's text while preserving its language, meaning, tone and formatting. " +
        "Return only the corrected text, without quotes, labels or commentary.";

  const messages = [
    { role: "system", content: system },
    { role: "user", content: text },
  ];

  try {
    const result = await chatRound(messages, model, sink, false);
    const clean = result.text.trim();
    if (!clean) throw new Error("empty task result");
    sink({ type: "done", mood: "neutral", text: clean, model: "task" });
  } catch (error) {
    if (error.name === "AbortError") {
      sink({ type: "done", mood: "neutral", text: "", cancelled: true });
    } else {
      console.warn("[baldborg] task error:", error.message);
      sink({
        type: "error",
        message: error.message,
        hint: english
          ? "The local core is not responding. Check that Ollama is running."
          : "El núcleo local no responde. Verifique que ollama esté en marcha.",
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
  for (const resolve of confirmations.values()) resolve(false);
  confirmations.clear();
  if (sink) sink({ type: "done", mood: "neutral", text: "", cancelled: true });
}
