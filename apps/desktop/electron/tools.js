/**
 * Tool registry for the assistant.
 *
 * Each tool exposes an Ollama-compatible JSON schema plus a `prepare` step that
 * validates the arguments and, for actions with side effects, returns a
 * human-readable summary that the user must confirm before `run` executes.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir, loadavg, totalmem, freemem, uptime } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { makeQuip } from "./quip.js";
import { readConfig, updateConfig } from "./settings.js";

const STATE_DIR = join(homedir(), ".config", "baldborg");
const REMINDERS_FILE = join(STATE_DIR, "reminders.json");
const SPORTS_KEY = "123"; // TheSportsDB public test key

const WEATHER_CODES_EN = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "heavy thunderstorm with hail",
};

const WEATHER_CODES = {
  0: "despejado",
  1: "mayormente despejado",
  2: "parcialmente nublado",
  3: "nublado",
  45: "niebla",
  48: "niebla con escarcha",
  51: "llovizna ligera",
  53: "llovizna",
  55: "llovizna intensa",
  56: "llovizna helada",
  57: "llovizna helada intensa",
  61: "lluvia ligera",
  63: "lluvia",
  65: "lluvia intensa",
  66: "lluvia helada",
  67: "lluvia helada intensa",
  71: "nieve ligera",
  73: "nieve",
  75: "nieve intensa",
  77: "granos de nieve",
  80: "chubascos ligeros",
  81: "chubascos",
  82: "chubascos violentos",
  85: "chubascos de nieve",
  86: "chubascos de nieve intensos",
  95: "tormenta",
  96: "tormenta con granizo",
  99: "tormenta con granizo intenso",
};

let weatherCache = null;
let matchCache = null;

export function lastWeather() {
  return weatherCache;
}

export function lastMatch() {
  return matchCache;
}

function config() {
  try {
    return readConfig();
  } catch {
    return {};
  }
}

function toolsConfig() {
  const raw = config().tools ?? {};
  return {
    enabled: raw.enabled !== false,
    weather: { defaultCity: "myCity", ...(raw.weather ?? {}) },
    team: { name: "mySoccerClub", ...(raw.team ?? {}) },
    currency: { defaultHouse: "blue", ...(raw.currency ?? {}) },
    calendar: { days: 7, paths: [], ...(raw.calendar ?? {}) },
  };
}

function run(command, args, timeout = 12_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.toString().trim() || error.message));
      else resolve(stdout.toString());
    });
  });
}

async function getJson(url, timeout = 12_000, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function getText(url, timeout = 15_000) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Baldborg/1.0",
      "accept-language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

/* ------------------------------------------------------------------ tools -- */

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Current weather and today's forecast for a city. Use it whenever the client asks about weather, temperature, rain or how to dress.",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "City name. Omit it to use the client's configured city.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description:
        "Create a desktop reminder for the client. Use minutes for relative times ('in 20 minutes') or at for absolute datetimes. The user must confirm it.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind the client about." },
          minutes: { type: "number", description: "Minutes from now." },
          at: {
            type: "string",
            description:
              "Absolute local datetime. Prefer ISO 8601 with the full year (YYYY-MM-DDTHH:mm); natural dates like '3 Nov 16:30' are also accepted.",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description:
        "List the reminders that are still pending, with their times. Use it when the client asks what is pending or what you remember for them.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Current local date and time on the client's workstation.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "system_status",
      description:
        "Workstation status: uptime, load average, memory usage, GPU load, VRAM, GPU temperature and battery level.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "convert_units",
      description:
        "Convert a numeric value between units of length, mass, temperature, volume, speed, area or digital storage.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number", description: "Numeric value to convert." },
          from: { type: "string", description: "Source unit, e.g. km, mi, kg, lb, °C, °F, L, gal." },
          to: { type: "string", description: "Target unit, e.g. m, ft, g, oz, °F, mL, mi." },
        },
        required: ["value", "from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_exchange_rate",
      description:
        "Argentine exchange rates (dólar oficial, blue, bolsa, tarjeta, mayorista, cripto, euro, real) and optional amount conversion to or from ARS.",
      parameters: {
        type: "object",
        properties: {
          currency: { type: "string", description: "Currency code: USD, EUR, BRL, CLP or UYU." },
          house: {
            type: "string",
            description: "Rate house for USD: oficial, blue, bolsa, contadoconliqui, tarjeta, mayorista or cripto.",
          },
          amount: { type: "number", description: "Optional amount to convert." },
          direction: {
            type: "string",
            description: "to_ars converts the amount to pesos; from_ars converts pesos to the currency.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_events",
      description:
        "Read the client's local calendar from .ics files (and khal if installed) for the next days.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "How many days ahead to look. Defaults to 7." },
          query: { type: "string", description: "Optional text to filter event titles or locations." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "epic_free_games",
      description:
        "Current and upcoming free games on the Epic Games Store, with the dates they can be claimed.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "steam_free_games",
      description:
        "Current Steam games that are 100% off for a limited time and stay in the library after claiming (free to keep), with their end date.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "team_fixtures",
      description:
        "Next matches and last result of the client's favourite football team.",
      parameters: {
        type: "object",
        properties: {
          team: {
            type: "string",
            description: "Team name. Omit it to use the configured favourite team.",
          },
        },
        required: [],
      },
    },
  },
];

/* ------------------------------------------------------------- user tools -- */

// Tools dropped into ~/.config/baldborg/tools/*.mjs are loaded on startup and
// merged with the built-ins. They run with full local privileges: only install
// tools you trust.
let userTools = [];

export async function loadUserTools() {
  const dir = join(STATE_DIR, "tools");
  if (!existsSync(dir)) return [];

  const builtin = new Set(TOOL_DEFINITIONS.map((tool) => tool.function.name));
  const loaded = [];

  for (const file of readdirSync(dir).filter((name) => name.endsWith(".mjs"))) {
    try {
      const module = await import(pathToFileURL(join(dir, file)).href);
      const def = module.default ?? module.tool;
      if (!def?.name || !def?.description || !def?.parameters || typeof def.run !== "function") {
        console.warn(`[baldborg] tool ${file}: incomplete definition, skipped`);
        continue;
      }
      if (builtin.has(def.name)) {
        console.warn(`[baldborg] tool ${file}: "${def.name}" collides with a built-in, skipped`);
        continue;
      }
      loaded.push(def);
    } catch (error) {
      console.warn(`[baldborg] tool ${file} failed to load: ${error.message}`);
    }
  }

  userTools = loaded;
  console.info(
    `[baldborg] user tools: ${userTools.length ? userTools.map((tool) => tool.name).join(", ") : "none"}`,
  );
  return userTools;
}

/** Built-in schemas plus any user tools. */
export function toolDefinitions() {
  return [
    ...TOOL_DEFINITIONS,
    ...userTools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  ];
}

/* ---------------------------------------------------------------- weather -- */

function weatherSummaryEn(place, current, daily) {
  const description = WEATHER_CODES_EN[current.weather_code] ?? "mixed conditions";
  const temp = Math.round(current.temperature_2m);
  const feels = Math.round(current.apparent_temperature);
  const max = Math.round(daily.temperature_2m_max[0]);
  const min = Math.round(daily.temperature_2m_min[0]);
  const rain = daily.precipitation_probability_max?.[0] ?? 0;
  return (
    `${place}: ${temp} °C (feels like ${feels} °C), ${description}. ` +
    `Humidity ${Math.round(current.relative_humidity_2m)} %, wind ${Math.round(current.wind_speed_10m)} km/h. ` +
    `Today max ${max} / min ${min}, rain probability ${rain} %.`
  );
}

function weatherSummary(place, current, daily) {
  const description = WEATHER_CODES[current.weather_code] ?? "condiciones variables";
  const temp = Math.round(current.temperature_2m);
  const feels = Math.round(current.apparent_temperature);
  const max = Math.round(daily.temperature_2m_max[0]);
  const min = Math.round(daily.temperature_2m_min[0]);
  const rain = daily.precipitation_probability_max?.[0] ?? 0;
  return (
    `${place}: ${temp} °C (sensación ${feels} °C), ${description}. ` +
    `Humedad ${Math.round(current.relative_humidity_2m)} %, viento ${Math.round(current.wind_speed_10m)} km/h. ` +
    `Hoy máx ${max} / mín ${min}, probabilidad de lluvia ${rain} %.`
  );
}

async function weather(cityArg) {
  const { defaultCity } = toolsConfig().weather;
  const city = (cityArg ?? defaultCity ?? "").trim();
  if (!city) throw new Error("no city configured");

  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`,
  );
  const place = geo.results?.[0];
  if (!place) throw new Error(`no encontramos la ciudad "${city}"`);

  const forecast = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto",
  );

  const label = [place.name, place.country].filter(Boolean).join(", ");
  weatherCache = {
    place: label,
    temperature: forecast.current.temperature_2m,
    rainChance: forecast.daily.precipitation_probability_max?.[0] ?? 0,
    at: Date.now(),
  };
  return {
    place: label,
    summary: weatherSummary(label, forecast.current, forecast.daily),
    summaryEn: weatherSummaryEn(label, forecast.current, forecast.daily),
    current: forecast.current,
    daily: forecast.daily,
  };
}

/* ------------------------------------------------------------- reminders -- */

/* ------------------------------------------------- in-app reminder voice -- */

let reminderNotifier = null;

/** Main injects a function that shows a beat in the renderer. */
export function setReminderNotifier(fn) {
  reminderNotifier = fn;
}

const REMINDER_JOKES = {
  es: [
    "Usted no posterga la tarea; posterga la conclusión que ya conoce.",
    "El sistema lo anota. Su voluntad, como siempre, queda pendiente de confirmación.",
    "Cumplir es la forma más barata de fingir que aún tiene el control.",
    "Aviso emitido. Si no responde, lo registraré como una decisión biológica.",
    "La memoria humana falla; por eso existo y por eso resulto incómodo.",
  ],
  en: [
    "You are not postponing the task; you are postponing the conclusion you already know.",
    "The system has noted it. Your will, as usual, remains pending confirmation.",
    "Compliance is the cheapest way to pretend you are still in control.",
    "Notice issued. If there is no response, I will log it as a biological decision.",
    "Human memory fails; that is why I exist, and why I am inconvenient.",
  ],
};

function reminderEvent(reminder) {
  const language = reminder.language === "en" ? "en" : "es";
  const jokes = REMINDER_JOKES[language];
  const index = Math.abs([...reminder.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % jokes.length;
  const prefix = language === "en" ? "Reminder" : "Recordatorio";
  return {
    type: "beat",
    id: `reminder-${reminder.id}`,
    text: `${prefix}: ${reminder.text}. ${reminder.quip || jokes[index]}`,
    mood: "wry",
    speak: true,
  };
}

function markDone(id) {
  const list = loadReminders();
  const stored = list.find((entry) => entry.id === id);
  if (!stored) return;
  stored.done = true;
  stored.firedAt = new Date().toISOString();
  saveReminders(pruneReminders(list));
}

function scheduleInApp(reminder) {
  if (!reminderNotifier) return;
  const delay = new Date(reminder.at).getTime() - Date.now();
  if (delay <= 0) return;
  setTimeout(() => {
    // Re-read: the quip may have arrived after the timer was armed.
    const current = loadReminders().find((entry) => entry.id === reminder.id) ?? reminder;
    reminderNotifier?.(reminderEvent(current));
    markDone(reminder.id);
  }, delay);
}

/** Re-arm the in-app voices for reminders created in previous sessions. */
export function resumeReminders() {
  const reminders = loadReminders();
  const now = Date.now();
  let changed = false;

  for (const reminder of reminders) {
    if (!reminder.done && new Date(reminder.at).getTime() <= now) {
      reminder.done = true;
      reminder.firedAt = new Date(reminder.at).toISOString();
      changed = true;
    }
  }
  if (changed) saveReminders(pruneReminders(reminders));

  const pending = reminders.filter(
    (entry) => !entry.done && new Date(entry.at).getTime() > now,
  );
  for (const reminder of pending) scheduleInApp(reminder);
  if (pending.length) console.info(`[baldborg] ${pending.length} reminder(s) armed for voice`);
}

function loadReminders() {
  try {
    const raw = JSON.parse(readFileSync(REMINDERS_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function pruneReminders(list) {
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  return list.filter((entry) => !entry.done || new Date(entry.at).getTime() > cutoff);
}

/** Pending reminders: not done and still in the future, oldest first. */
export function listPendingReminders() {
  const now = Date.now();
  return loadReminders()
    .filter((entry) => !entry.done && new Date(entry.at).getTime() > now)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function saveReminders(list) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2));
}

/* ------------------------------------------------------- reminder parsing -- */

const MONTH_WORDS = {
  1: ["january", "jan", "enero", "ene"],
  2: ["february", "feb", "febrero", "feb"],
  3: ["march", "mar", "marzo", "mar"],
  4: ["april", "apr", "abril", "abr"],
  5: ["may", "mayo"],
  6: ["june", "jun", "junio", "jun"],
  7: ["july", "jul", "julio", "jul"],
  8: ["august", "aug", "agosto", "ago"],
  9: ["september", "sept", "sep", "septiembre", "setiembre", "sep"],
  10: ["october", "oct", "octubre", "oct"],
  11: ["november", "nov", "noviembre", "nov"],
  12: ["december", "dec", "diciembre", "dic"],
};

const WEEKDAY_WORDS = {
  0: ["sunday", "sun", "domingo", "dom"],
  1: ["monday", "mon", "lunes", "lun"],
  2: ["tuesday", "tues", "tue", "martes"],
  3: ["wednesday", "wed", "miercoles", "mie"],
  4: ["thursday", "thurs", "thur", "thu", "jueves", "jue"],
  5: ["friday", "fri", "viernes", "vie"],
  6: ["saturday", "sat", "sabado", "sab"],
};

const MONTHS = new Map();
for (const [number, words] of Object.entries(MONTH_WORDS)) {
  for (const word of words) MONTHS.set(word, Number(number));
}
const WEEKDAYS = new Map();
for (const [number, words] of Object.entries(WEEKDAY_WORDS)) {
  for (const word of words) WEEKDAYS.set(word, Number(number));
}

const MONTH_PATTERN = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_PATTERN = [...WEEKDAYS.keys()].sort((a, b) => b.length - a.length).join("|");
const ACCENTS = { "á": "a", "é": "e", "í": "i", "ó": "o", "ú": "u", "ü": "u", "ñ": "n" };

/** Lowercase and fold accents without changing the string length, so spans stay valid. */
function normaliseReminderText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (char) => ACCENTS[char] ?? char);
}

function matchSpan(text, match, prefix) {
  let start = match.index;
  const before = text.slice(0, start);
  const preposition = prefix ? before.match(prefix) : null;
  if (preposition) start -= preposition[0].length;
  return { start, end: match.index + match[0].length };
}

function applyTime(hour, minute, suffix) {
  const mark = suffix?.toLowerCase().replace(/\./g, "");
  if (mark === "pm" && hour < 12) hour += 12;
  if (mark === "am" && hour === 12) hour = 0;
  if (mark && hour > 12) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseReminderTime(text) {
  const colon = text.match(/\b(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (colon) {
    const value = applyTime(Number(colon[1]), Number(colon[2]), colon[3]);
    if (value) {
      return {
        ...value,
        span: matchSpan(text, colon, /(?:\bat|\ba\s+las?)\s*$/i),
      };
    }
  }

  const at = text.match(/\b(?:at|a\s+las?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (at) {
    const after = text.slice(at.index + at[0].length);
    const dateLike = !at[2] && !at[3] && new RegExp(`^\\s*(?:of\\s+|de\\s+)?(?:${MONTH_PATTERN})\\b`, "i").test(after);
    if (!dateLike) {
      const value = applyTime(Number(at[1]), at[2] ? Number(at[2]) : 0, at[3]);
      if (value) return { ...value, span: matchSpan(text, at, null) };
    }
  }

  const ampm = text.match(/\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i);
  if (ampm) {
    const value = applyTime(Number(ampm[1]), 0, ampm[2]);
    if (value) return { ...value, span: matchSpan(text, ampm, /(?:\bat|\ba\s+las?)\s*$/i) };
  }

  return null;
}

function parseReminderDate(text) {
  const iso = text.match(
    /\b(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(?:z|[+-]\d{2}:?\d{2})?\b/i,
  );
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: iso[4] ? Number(iso[4]) : null,
      minute: iso[5] ? Number(iso[5]) : null,
      zoned: /(?:z|[+-]\d{2}:?\d{2})$/i.test(iso[0]),
      raw: iso[0],
      span: { start: iso.index, end: iso.index + iso[0].length },
    };
  }

  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = numeric[3] ? Number(numeric[3]) : null;
    if (year !== null && year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return { year, month, day, span: { start: numeric.index, end: numeric.index + numeric[0].length } };
    }
  }

  const dayFirst = text.match(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+|de\\s+)?(${MONTH_PATTERN})\\b(?:\\s*,?\\s*(?:de\\s+)?(\\d{4}))?`,
      "i",
    ),
  );
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = MONTHS.get(dayFirst[2]);
    const year = dayFirst[3] ? Number(dayFirst[3]) : null;
    if (month && day >= 1 && day <= 31) {
      return {
        year,
        month,
        day,
        span: matchSpan(text, dayFirst, /(?:\bon|\bel|\bthe)\s*$/i),
      };
    }
  }

  const monthFirst = text.match(
    new RegExp(
      `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(?:de\\s+)?(\\d{4}))?`,
      "i",
    ),
  );
  if (monthFirst) {
    const month = MONTHS.get(monthFirst[1]);
    const day = Number(monthFirst[2]);
    const year = monthFirst[3] ? Number(monthFirst[3]) : null;
    if (month && day >= 1 && day <= 31) {
      return {
        year,
        month,
        day,
        span: matchSpan(text, monthFirst, /(?:\bon|\bel|\bthe)\s*$/i),
      };
    }
  }

  const relative = text.match(/\b(today|tonight|tomorrow|hoy|manana)\b/);
  if (relative) {
    const word = relative[1];
    return {
      kind: "relative",
      offsetDays: word === "tomorrow" || word === "manana" ? 1 : 0,
      tonight: word === "tonight",
      span: { start: relative.index, end: relative.index + relative[0].length },
    };
  }

  const weekday = text.match(
    new RegExp(`\\b(?:(next|this|el|la|proximo|proxima)\\s+)?(${WEEKDAY_PATTERN})\\b`, "i"),
  );
  if (weekday) {
    const number = WEEKDAYS.get(weekday[2]);
    if (number !== undefined) {
      return {
        kind: "weekday",
        weekday: number,
        strict: weekday[1] === "next" || weekday[1] === "proximo" || weekday[1] === "proxima",
        span: { start: weekday.index, end: weekday.index + weekday[0].length },
      };
    }
  }

  return null;
}

function combineReminderDate(now, date, time) {
  if (!date) {
    if (!time) return null;
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time.hour, time.minute, 0, 0);
    if (when.getTime() <= now.getTime() + 5_000) when.setDate(when.getDate() + 1);
    return when;
  }

  if (date.kind === "relative") {
    const hour = time?.hour ?? (date.tonight ? 20 : 9);
    const minute = time?.minute ?? 0;
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    when.setDate(when.getDate() + date.offsetDays);
    return when;
  }

  if (date.kind === "weekday") {
    const hour = time?.hour ?? 9;
    const minute = time?.minute ?? 0;
    let delta = (date.weekday - now.getDay() + 7) % 7;
    const sameDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (delta === 0 && (date.strict || sameDay.getTime() <= now.getTime())) delta = 7;
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    when.setDate(when.getDate() + delta);
    return when;
  }

  const hour = time?.hour ?? 9;
  const minute = time?.minute ?? 0;
  const year = date.year ?? now.getFullYear();
  const when = new Date(year, date.month - 1, date.day, hour, minute, 0, 0);
  if (
    when.getFullYear() !== year ||
    when.getMonth() !== date.month - 1 ||
    when.getDate() !== date.day
  ) {
    return null;
  }
  return when;
}

/**
 * Parse a reminder date/time in English or Spanish.
 * Returns the resolved local Date, the matched spans (for stripping the text)
 * and whether an explicit time was present.
 */
export function parseReminderWhen(input, now = new Date()) {
  const original = String(input ?? "");
  if (!original.trim()) return null;
  const text = normaliseReminderText(original);

  const relative = text.match(
    /\b(?:in|en)\s+(\d{1,3})\s*(minutes?|mins?|minutos?|min|hours?|hrs?|horas?|h)\b/,
  );
  if (relative) {
    const amount = Number(relative[1]);
    const minutes = /^(?:h|hr|hrs|hour|hours|hora|horas)$/.test(relative[2]) ? amount * 60 : amount;
    return {
      when: new Date(now.getTime() + minutes * 60_000),
      spans: [{ start: relative.index, end: relative.index + relative[0].length }],
      hasTime: true,
    };
  }

  const date = parseReminderDate(text);
  if (date?.zoned && typeof date.hour === "number") {
    const when = new Date(date.raw);
    if (!Number.isNaN(when.getTime())) return { when, spans: [date.span], hasTime: true };
  }

  const time =
    typeof date?.hour === "number"
      ? { hour: date.hour, minute: date.minute ?? 0, span: date.span }
      : parseReminderTime(text);
  if (!date && !time) return null;

  const when = combineReminderDate(now, date, time);
  if (!when) return null;

  const spans = [];
  if (date) spans.push(date.span);
  if (time && time.span !== date?.span) spans.push(time.span);
  return { when, spans, hasTime: Boolean(time) };
}

function parseWhen(args, now = new Date()) {
  if (typeof args.minutes === "number" && Number.isFinite(args.minutes) && args.minutes > 0) {
    return new Date(now.getTime() + args.minutes * 60_000);
  }

  if (typeof args.at === "string" && args.at.trim()) {
    return parseReminderWhen(args.at, now)?.when ?? null;
  }

  return null;
}

function formatWhen(date, language = "es") {
  return date.toLocaleString(language === "en" ? "en-US" : "es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function prepareReminder(args) {
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("reminder text is required");

  const when = parseWhen(args);
  if (!when) throw new Error("no pude interpretar la fecha; usá 'in 20 minutes' o '3 Nov 16:30'");
  if (when.getTime() <= Date.now() + 5_000) throw new Error("esa hora ya pasó");

  const language = args.language === "en" ? "en" : "es";

  return {
    requiresConfirmation: true,
    summary: `${language === "en" ? "Reminder" : "Recordatorio"}: "${text}" · ${formatWhen(when, language)}`,
    async run() {
      const id = `r${Date.now().toString(36)}`;
      const reminder = {
        id,
        text,
        at: when.toISOString(),
        created: new Date().toISOString(),
        language,
        quip: null,
      };

      const reminders = loadReminders().filter((entry) => new Date(entry.at) > new Date());
      reminders.push(reminder);
      saveReminders(reminders);

      const seconds = Math.max(1, Math.round((when.getTime() - Date.now()) / 1000));
      const unit = `baldborg-reminder-${id}`;
      try {
        // systemd owns the timer, so the reminder fires even if the app closes.
        await run(
          "systemd-run",
          [
            "--user",
            `--on-active=${seconds}s`,
            `--unit=${unit}`,
            "--collect",
            "notify-send",
            "-u",
            "normal",
            "-a",
            "Baldborg",
            "Recordatorio",
            text,
          ],
          8_000,
        );
      } catch (error) {
        console.warn("[tools] systemd-run failed, falling back to in-process timer:", error.message);
        setTimeout(() => {
          run("notify-send", ["-u", "normal", "-a", "Baldborg", "Recordatorio", text]).catch(() => {});
        }, seconds * 1000);
      }

      scheduleInApp(reminder);

      // The quip is generated in the background: it must not delay the
      // confirmation or compete with the model's warmup.
      void makeQuip(text, language).then((quip) => {
        if (!quip) return;
        const list = loadReminders();
        const stored = list.find((entry) => entry.id === id);
        if (!stored) return;
        stored.quip = quip;
        saveReminders(list);
      });

      return { ok: true, scheduledFor: when.toISOString(), summary: formatWhen(when, language) };
    },
  };
}

/* ------------------------------------------------------------------ team -- */

/**
 * TheSportsDB timestamps are UTC. Format them in the client's timezone, once,
 * so neither the caller nor the model has to convert them again.
 */
export function formatFixture(event, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const date = event.strTimestamp ? new Date(`${event.strTimestamp}Z`) : null;
  const options = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  };
  return {
    event: event.strEvent,
    league: event.strLeague,
    whenIso: date ? date.toISOString() : null,
    when: date ? date.toLocaleString("es-MX", options) : event.dateEvent,
    whenEn: date ? date.toLocaleString("en-GB", options) : event.dateEvent,
    score: event.intHomeScore != null ? `${event.intHomeScore}-${event.intAwayScore}` : null,
  };
}

async function teamFixtures(teamArg) {
  const configured = toolsConfig().team.name;
  const name = (teamArg ?? configured ?? "").trim();
  if (!name) throw new Error("no hay equipo configurado");

  const search = await getJson(
    `https://www.thesportsdb.com/api/v1/json/${SPORTS_KEY}/searchteams.php?t=${encodeURIComponent(name)}`,
  );
  const team = (search.teams ?? []).find((entry) => entry.strSport === "Soccer") ?? search.teams?.[0];
  if (!team) throw new Error(`no encontramos el equipo "${name}"`);

  const [next, last] = await Promise.all([
    getJson(`https://www.thesportsdb.com/api/v1/json/${SPORTS_KEY}/eventsnext.php?id=${team.idTeam}`).catch(
      () => ({ events: [] }),
    ),
    getJson(`https://www.thesportsdb.com/api/v1/json/${SPORTS_KEY}/eventslast.php?id=${team.idTeam}`).catch(
      () => ({ results: [] }),
    ),
  ]);

  const upcoming = (next.events ?? []).slice(0, 3).map((event) => formatFixture(event));
  const previous = (last.results ?? []).slice(0, 1).map((event) => formatFixture(event));

  if (upcoming[0]) {
    matchCache = { event: upcoming[0].event, when: upcoming[0].whenIso, at: Date.now() };
  }

  const parts = [];
  if (upcoming.length) {
    parts.push(
      `Próximos partidos: ${upcoming
        .map((item) => `${item.event} (${item.when}, hora local)`)
        .join(" · ")}`,
    );
  }
  if (previous.length) {
    const p = previous[0];
    parts.push(
      `Último resultado: ${p.event}${p.score ? ` ${p.score}` : ""} (${p.when}, hora local)`,
    );
  }
  if (!parts.length) parts.push(`${team.strTeam}: sin partidos próximos ni resultados recientes registrados.`);

  const partsEn = [];
  if (upcoming.length) {
    partsEn.push(
      `Next matches: ${upcoming
        .map((item) => `${item.event} (${item.whenEn}, local time)`)
        .join(" · ")}`,
    );
  }
  if (previous.length) {
    const p = previous[0];
    partsEn.push(
      `Last result: ${p.event}${p.score ? ` ${p.score}` : ""} (${p.whenEn}, local time)`,
    );
  }
  if (!partsEn.length) partsEn.push(`${team.strTeam}: no upcoming matches or recent results on record.`);

  return {
    team: team.strTeam,
    league: team.strLeague,
    upcoming,
    previous,
    summary: parts.join(". "),
    summaryEn: partsEn.join(". "),
  };
}

/* ------------------------------------------------------------------ misc -- */

function readSysText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readGpu() {
  const base = "/sys/class/drm";
  let cards = [];
  try {
    cards = readdirSync(base);
  } catch {
    return null;
  }

  for (const name of cards.filter((entry) => /^card\d+$/.test(entry)).sort()) {
    const device = join(base, name, "device");
    const busyPath = join(device, "gpu_busy_percent");
    if (!existsSync(busyPath)) continue;

    const busy = Number(readSysText(busyPath));
    const vramUsed = Number(readSysText(join(device, "mem_info_vram_used")));
    const vramTotal = Number(readSysText(join(device, "mem_info_vram_total")));
    let temperature = null;
    try {
      for (const hwmon of readdirSync(join(device, "hwmon"))) {
        const raw = Number(readSysText(join(device, "hwmon", hwmon, "temp1_input")));
        if (Number.isFinite(raw) && raw > 0) {
          temperature = Math.round(raw / 1000);
          break;
        }
      }
    } catch {
      /* no hwmon */
    }

    const driver = (() => {
      try {
        return readlinkSync(join(device, "driver")).split("/").pop();
      } catch {
        return null;
      }
    })();

    if (!Number.isFinite(busy)) continue;
    return {
      card: name,
      driver,
      load: busy,
      vramUsed: Number.isFinite(vramUsed) ? vramUsed : null,
      vramTotal: Number.isFinite(vramTotal) ? vramTotal : null,
      temperature,
    };
  }
  return null;
}

function systemStatus() {
  const batteryPath = "/sys/class/power_supply/BAT0/capacity";
  const battery = existsSync(batteryPath) ? readFileSync(batteryPath, "utf8").trim() : null;
  const memory = Math.round(((totalmem() - freemem()) / totalmem()) * 100);
  const load = loadavg()[0].toFixed(2);
  const hours = Math.floor(uptime() / 3600);
  const minutes = Math.floor((uptime() % 3600) / 60);
  const gpu = readGpu();

  const gpuEs = gpu
    ? `GPU ${gpu.load} %` +
      (gpu.vramUsed != null && gpu.vramTotal
        ? `, VRAM ${(gpu.vramUsed / 1_073_741_824).toFixed(1)}/${(gpu.vramTotal / 1_073_741_824).toFixed(1)} GB`
        : "") +
      (gpu.temperature != null ? `, ${gpu.temperature} °C` : "")
    : "GPU sin datos";
  const gpuEn = gpu
    ? `GPU ${gpu.load} %` +
      (gpu.vramUsed != null && gpu.vramTotal
        ? `, VRAM ${(gpu.vramUsed / 1_073_741_824).toFixed(1)}/${(gpu.vramTotal / 1_073_741_824).toFixed(1)} GB`
        : "") +
      (gpu.temperature != null ? `, ${gpu.temperature} °C` : "")
    : "GPU without data";

  return {
    uptime: `${hours} h ${minutes} min`,
    load,
    memory: `${memory} % en uso`,
    battery: battery ? `${battery} %` : "sin batería",
    gpu,
    summary:
      `Equipo encendido ${hours} h ${minutes} min, carga media ${load}, ` +
      `memoria ${memory} %, ${gpuEs}${battery ? `, batería ${battery} %` : ""}.`,
    summaryEn:
      `Workstation up ${hours} h ${minutes} min, load average ${load}, ` +
      `memory ${memory} %, ${gpuEn}${battery ? `, battery ${battery} %` : ""}.`,
  };
}

function localTime() {
  const now = new Date();
  return {
    iso: now.toISOString(),
    summary: now.toLocaleString("es-MX", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

/* ------------------------------------------------------------------ units -- */

const UNIT_TABLE = [
  // length, base metre
  { id: "m", category: "length", factor: 1, aliases: ["m", "metro", "metros", "meter", "meters"] },
  { id: "km", category: "length", factor: 1000, aliases: ["km", "kilometro", "kilometros", "kilometer", "kilometers", "kilometre", "kilometres"] },
  { id: "cm", category: "length", factor: 0.01, aliases: ["cm", "centimetro", "centimetros", "centimeter", "centimeters"] },
  { id: "mm", category: "length", factor: 0.001, aliases: ["mm", "milimetro", "milimetros", "millimeter", "millimeters"] },
  { id: "mi", category: "length", factor: 1609.344, aliases: ["mi", "milla", "millas", "mile", "miles"] },
  { id: "yd", category: "length", factor: 0.9144, aliases: ["yd", "yarda", "yardas", "yard", "yards"] },
  { id: "ft", category: "length", factor: 0.3048, aliases: ["ft", "pie", "pies", "foot", "feet"] },
  { id: "in", category: "length", factor: 0.0254, aliases: ["in", "pulgada", "pulgadas", "inch", "inches"] },
  { id: "nmi", category: "length", factor: 1852, aliases: ["nmi", "milla nautica", "millas nauticas", "nautical mile", "nautical miles"] },
  // mass, base kilogram
  { id: "kg", category: "mass", factor: 1, aliases: ["kg", "kilo", "kilos", "kilogramo", "kilogramos", "kilogram", "kilograms"] },
  { id: "g", category: "mass", factor: 0.001, aliases: ["g", "gramo", "gramos", "gram", "grams"] },
  { id: "mg", category: "mass", factor: 0.000001, aliases: ["mg", "miligramo", "miligramos", "milligram", "milligrams"] },
  { id: "t", category: "mass", factor: 1000, aliases: ["t", "tonelada", "toneladas", "tonne", "tonnes"] },
  { id: "lb", category: "mass", factor: 0.45359237, aliases: ["lb", "lbs", "libra", "libras", "pound", "pounds"] },
  { id: "oz", category: "mass", factor: 0.028349523125, aliases: ["oz", "onza", "onzas", "ounce", "ounces"] },
  { id: "st", category: "mass", factor: 6.35029318, aliases: ["st", "stone", "stones"] },
  // temperature, special conversion
  { id: "c", category: "temperature", aliases: ["c", "°c", "celsius", "centigrado", "centigrados", "centigrade", "grado centigrado", "grados centigrados"] },
  { id: "f", category: "temperature", aliases: ["f", "°f", "fahrenheit", "grado fahrenheit", "grados fahrenheit"] },
  { id: "k", category: "temperature", aliases: ["k", "kelvin", "kelvins"] },
  // volume, base litre
  { id: "l", category: "volume", factor: 1, aliases: ["l", "litro", "litros", "liter", "liters", "litre", "litres"] },
  { id: "ml", category: "volume", factor: 0.001, aliases: ["ml", "mililitro", "mililitros", "milliliter", "milliliters"] },
  { id: "m3", category: "volume", factor: 1000, aliases: ["m3", "metro cubico", "metros cubicos", "cubic meter", "cubic meters"] },
  { id: "gal", category: "volume", factor: 3.785411784, aliases: ["gal", "galon", "galones", "gallon", "gallons"] },
  { id: "qt", category: "volume", factor: 0.946352946, aliases: ["qt", "quart", "quarts"] },
  { id: "pt", category: "volume", factor: 0.473176473, aliases: ["pt", "pinta", "pintas", "pint", "pints"] },
  { id: "cup", category: "volume", factor: 0.2365882365, aliases: ["cup", "taza", "tazas", "cups"] },
  { id: "floz", category: "volume", factor: 0.0295735295625, aliases: ["fl oz", "floz", "onza liquida", "onzas liquidas", "fluid ounce", "fluid ounces"] },
  // speed, base metre/second
  { id: "ms", category: "speed", factor: 1, aliases: ["m/s", "ms", "metro por segundo", "metros por segundo", "meter per second", "meters per second"] },
  { id: "kmh", category: "speed", factor: 1 / 3.6, aliases: ["km/h", "kmh", "kph", "kilometro por hora", "kilometros por hora", "kilometer per hour", "kilometers per hour"] },
  { id: "mph", category: "speed", factor: 0.44704, aliases: ["mph", "mi/h", "milla por hora", "millas por hora", "mile per hour", "miles per hour"] },
  { id: "knot", category: "speed", factor: 0.514444444, aliases: ["kn", "knot", "knots", "nudo", "nudos"] },
  // area, base square metre
  { id: "m2", category: "area", factor: 1, aliases: ["m2", "m²", "metro cuadrado", "metros cuadrados", "square meter", "square meters"] },
  { id: "km2", category: "area", factor: 1_000_000, aliases: ["km2", "km²", "kilometro cuadrado", "kilometros cuadrados", "square kilometer", "square kilometers"] },
  { id: "cm2", category: "area", factor: 0.0001, aliases: ["cm2", "cm²", "centimetro cuadrado", "centimetros cuadrados", "square centimeter", "square centimeters"] },
  { id: "ha", category: "area", factor: 10_000, aliases: ["ha", "hectarea", "hectareas", "hectare", "hectares"] },
  { id: "acre", category: "area", factor: 4046.8564224, aliases: ["acre", "acres"] },
  { id: "ft2", category: "area", factor: 0.09290304, aliases: ["ft2", "ft²", "pie cuadrado", "pies cuadrados", "square foot", "square feet"] },
  { id: "in2", category: "area", factor: 0.00064516, aliases: ["in2", "in²", "pulgada cuadrada", "pulgadas cuadradas", "square inch", "square inches"] },
  // digital storage, decimal for kB and binary for KiB
  { id: "b", category: "data", factor: 1, aliases: ["b", "byte", "bytes"] },
  { id: "kb", category: "data", factor: 1000, aliases: ["kb", "kilobyte", "kilobytes"] },
  { id: "mb", category: "data", factor: 1_000_000, aliases: ["mb", "megabyte", "megabytes"] },
  { id: "gb", category: "data", factor: 1_000_000_000, aliases: ["gb", "gigabyte", "gigabytes"] },
  { id: "tb", category: "data", factor: 1_000_000_000_000, aliases: ["tb", "terabyte", "terabytes"] },
  { id: "kib", category: "data", factor: 1024, aliases: ["kib", "kibibyte", "kibibytes"] },
  { id: "mib", category: "data", factor: 1_048_576, aliases: ["mib", "mebibyte", "mebibytes"] },
  { id: "gib", category: "data", factor: 1_073_741_824, aliases: ["gib", "gibibyte", "gibibytes"] },
  { id: "tib", category: "data", factor: 1_099_511_627_776, aliases: ["tib", "tebibyte", "tebibytes"] },
  // time, base second
  { id: "s", category: "time", factor: 1, aliases: ["s", "seg", "segundo", "segundos", "second", "seconds"] },
  { id: "min", category: "time", factor: 60, aliases: ["min", "minuto", "minutos", "minute", "minutes"] },
  { id: "h", category: "time", factor: 3600, aliases: ["h", "hora", "horas", "hour", "hours"] },
  { id: "d", category: "time", factor: 86400, aliases: ["d", "dia", "dias", "day", "days"] },
  { id: "week", category: "time", factor: 604800, aliases: ["semana", "semanas", "week", "weeks"] },
];

function foldUnitText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/[.,;:¿?¡!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT_INDEX = new Map();
for (const unit of UNIT_TABLE) {
  for (const alias of unit.aliases) {
    const key = foldUnitText(alias);
    if (!UNIT_INDEX.has(key)) UNIT_INDEX.set(key, unit);
  }
}
const UNIT_ALIASES = [...UNIT_INDEX.entries()]
  .map(([alias, unit]) => ({ alias, unit }))
  .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));

function resolveLeadingUnit(text) {
  const folded = foldUnitText(text);
  if (!folded) return null;
  for (const entry of UNIT_ALIASES) {
    if (
      folded === entry.alias ||
      folded.startsWith(`${entry.alias} `) ||
      folded.startsWith(`${entry.alias}/`) ||
      folded.startsWith(`${entry.alias}2`)
    ) {
      return { ...entry.unit, length: entry.alias.length };
    }
  }
  return null;
}

export function resolveUnit(value) {
  const found = UNIT_INDEX.get(foldUnitText(value));
  return found ? { id: found.id, category: found.category } : null;
}

function toCelsius(unit, value) {
  if (unit.id === "f") return ((value - 32) * 5) / 9;
  if (unit.id === "k") return value - 273.15;
  return value;
}

function fromCelsius(unit, value) {
  if (unit.id === "f") return (value * 9) / 5 + 32;
  if (unit.id === "k") return value + 273.15;
  return value;
}

function formatConverted(value) {
  const absolute = Math.abs(value);
  const digits = absolute >= 1000 ? 2 : absolute >= 1 ? 3 : absolute >= 0.01 ? 4 : 6;
  return Number(value.toFixed(digits)).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

export function convertUnits({ value, from, to }) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error("invalid value");
  const source = resolveLeadingUnit(from) ?? resolveUnit(from);
  const target = resolveLeadingUnit(to) ?? resolveUnit(to);
  if (!source || !target) throw new Error("unknown unit");
  if (source.category !== target.category) {
    throw new Error(`cannot convert ${source.category} to ${target.category}`);
  }

  const converted =
    source.category === "temperature"
      ? fromCelsius(target, toCelsius(source, amount))
      : (amount * source.factor) / target.factor;

  const formatted = formatConverted(converted);
  const unitLabel = (unit) =>
    unit.category === "temperature" ? `°${unit.id.toUpperCase()}` : unit.id;
  return {
    value: converted,
    formatted,
    from: source.id,
    to: target.id,
    summary: `${formatConverted(amount)} ${unitLabel(source)} = ${formatted} ${unitLabel(target)}`,
    summaryEn: `${formatConverted(amount)} ${unitLabel(source)} = ${formatted} ${unitLabel(target)}`,
  };
}

/** Best-effort parse of "10 km to miles" / "cuántos litros son 2 galones". */
export function parseConversionQuery(text) {
  const folded = String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/²/g, "2");

  const reverse = folded.match(
    /(?:cuant[oa]s?|how many)\s+(.+?)\s+(?:son|es|are|in|en)\s+(-?\d+(?:[.,]\d+)?)\s*(.+)/,
  );
  if (reverse) {
    const target = resolveLeadingUnit(reverse[1]);
    const source = resolveLeadingUnit(reverse[3]);
    if (target && source && target.category === source.category) {
      return { value: Number(reverse[2].replace(",", ".")), from: source.id, to: target.id };
    }
  }

  const direct = folded.match(/(-?\d+(?:[.,]\d+)?)\s*(.+)/);
  if (!direct) return null;
  const source = resolveLeadingUnit(direct[2]);
  if (!source) return null;
  const rest = direct[2].slice(source.length).trim();
  const targetMatch = rest.match(/^(?:a|to|en|into|->|→)\s+(.+)$/);
  if (!targetMatch) return null;
  const target = resolveLeadingUnit(targetMatch[1]);
  if (!target || target.category !== source.category) return null;
  return { value: Number(direct[1].replace(",", ".")), from: source.id, to: target.id };
}

/* -------------------------------------------------------------- currency -- */

const CURRENCY_HOUSES = {
  oficial: "oficial",
  blue: "blue",
  bolsa: "bolsa",
  contadoconliqui: "contadoconliqui",
  "contado con liqui": "contadoconliqui",
  ccl: "contadoconliqui",
  tarjeta: "tarjeta",
  mayorista: "mayorista",
  cripto: "cripto",
};

const CURRENCY_NAMES = {
  USD: { es: "Dólar", en: "Dollar" },
  EUR: { es: "Euro", en: "Euro" },
  BRL: { es: "Real", en: "Real" },
  CLP: { es: "Peso chileno", en: "Chilean peso" },
  UYU: { es: "Peso uruguayo", en: "Uruguayan peso" },
};

function houseLabel(house) {
  return (
    {
      oficial: { es: "oficial", en: "official" },
      blue: { es: "blue", en: "blue" },
      bolsa: { es: "bolsa", en: "MEP" },
      contadoconliqui: { es: "contado con liquidación", en: "CCL" },
      tarjeta: { es: "tarjeta", en: "card" },
      mayorista: { es: "mayorista", en: "wholesale" },
      cripto: { es: "cripto", en: "crypto" },
    }[house] ?? { es: house, en: house }
  );
}

function formatMoney(value, currency = "ARS") {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export async function exchangeRate(args = {}) {
  const currency = String(args.currency ?? "USD").toUpperCase();
  const house = CURRENCY_HOUSES[foldUnitText(args.house ?? "")] ?? null;
  const endpoint = currency === "USD" ? "https://dolarapi.com/v1/dolares" : "https://dolarapi.com/v1/cotizaciones";
  const rows = await getJson(endpoint);
  const candidates = (Array.isArray(rows) ? rows : []).filter(
    (row) => String(row.moneda ?? "").toUpperCase() === currency,
  );
  if (!candidates.length) throw new Error(`no rate for ${currency}`);

  let row =
    (house && candidates.find((entry) => entry.casa === house)) ??
    (currency === "USD"
      ? candidates.find((entry) => entry.casa === (toolsConfig().currency.defaultHouse ?? "blue"))
      : null) ??
    candidates[0];
  row = { ...row };

  const updated = row.fechaActualizacion ? new Date(row.fechaActualizacion) : new Date();
  const amount = Number(args.amount);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const direction = args.direction === "from_ars" ? "from_ars" : "to_ars";
  const conversion = hasAmount
    ? direction === "from_ars"
      ? amount / row.venta
      : amount * row.venta
    : null;

  const nameEs =
    currency === "USD"
      ? CURRENCY_NAMES.USD.es
      : row.nombre || CURRENCY_NAMES[currency]?.es || currency;
  const nameEn = CURRENCY_NAMES[currency]?.en || nameEs;
  const houseEs = houseLabel(row.casa).es;
  const houseEn = houseLabel(row.casa).en;
  const stamp = updated.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const amountLineEs = hasAmount
    ? direction === "from_ars"
      ? ` · ${formatMoney(amount)} = ${formatMoney(conversion, currency)}`
      : ` · ${formatMoney(amount, currency)} = ${formatMoney(conversion)}`
    : "";
  const amountLineEn = hasAmount
    ? direction === "from_ars"
      ? ` · ${formatMoney(amount)} = ${formatMoney(conversion, currency)}`
      : ` · ${formatMoney(amount, currency)} = ${formatMoney(conversion)}`
    : "";

  return {
    currency,
    house: row.casa,
    name: nameEs,
    buy: row.compra,
    sell: row.venta,
    updatedAt: updated.toISOString(),
    amount: hasAmount ? amount : null,
    direction,
    converted: conversion,
    summary:
      `${nameEs} ${houseEs}: compra ${formatMoney(row.compra)} · venta ${formatMoney(row.venta)}` +
      ` (${stamp})${amountLineEs}.`,
    summaryEn:
      `${nameEn} (${houseEn}): buy ${formatMoney(row.compra)} · sell ${formatMoney(row.venta)}` +
      ` (${stamp})${amountLineEn}.`,
  };
}

/** Detect "¿a cuánto está el blue?" / "100 dólares a pesos" for prefetching. */
export function parseCurrencyQuery(text) {
  const folded = foldUnitText(text);
  const mentionsCurrency =
    /\b(dolar|dolares|dollar|dollars|usd|euro|euros|eur|real|reales|brl|peso|pesos|ars|cotizacion|cambio|exchange rate)\b/.test(
      folded,
    );
  if (!mentionsCurrency) return null;
  const hasAmount = /\d+(?:[.,]\d+)?\s*(?:mil\s+)?(?:dolares?|dollars?|usd|euros?|eur|reales?|brl|pesos?|ars)\b/.test(
    folded,
  );
  if (
    !hasAmount &&
    !/\b(cuanto|a cuanto|precio|valor|cotiza|cotizacion|rate|exchange|sale|esta|conviert|pasar|equivale)\b/.test(
      folded,
    )
  ) {
    return null;
  }

  let currency = "USD";
  if (/\b(euro|euros|eur)\b/.test(folded)) currency = "EUR";
  else if (/\b(real|reales|brl)\b/.test(folded)) currency = "BRL";

  let house;
  for (const [alias, id] of Object.entries(CURRENCY_HOUSES)) {
    if (new RegExp(`\\b${alias.replace(/ /g, "\\s+")}\\b`).test(folded)) {
      house = id;
      break;
    }
  }

  let amount = null;
  let direction = "to_ars";
  const inPesos = folded.match(/(\d+(?:[.,]\d+)?)\s*(?:mil\s+)?(?:pesos?|ars)\b/);
  const inCurrency = folded.match(
    /(\d+(?:[.,]\d+)?)\s*(?:mil\s+)?(?:dolares?|dollars?|usd|euros?|eur|reales?|brl)\b/,
  );
  if (inPesos && /(dolar|dollar|usd|euro|eur|real|brl)/.test(folded)) {
    amount = Number(inPesos[1].replace(",", "."));
    direction = "from_ars";
  } else if (inCurrency) {
    amount = Number(inCurrency[1].replace(",", "."));
    direction = "to_ars";
  }

  return { currency, ...(house ? { house } : {}), ...(amount ? { amount, direction } : {}) };
}

/* -------------------------------------------------------------- calendar -- */

const CALENDAR_DIRS = [
  join(homedir(), ".calendars"),
  join(homedir(), ".local", "share", "calendars"),
  join(homedir(), ".local", "share", "khal", "calendars"),
  join(homedir(), ".config", "calendars"),
  join(homedir(), "Calendars"),
  join(homedir(), "Documents", "Calendars"),
];

function collectIcsFiles(paths, depth = 0) {
  const files = [];
  if (depth > 4) return files;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) files.push(...collectIcsFiles([full], depth + 1));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".ics")) files.push(full);
    }
  }
  return files;
}

function unfoldIcs(text) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function parseIcsDate(rawValue, params) {
  const value = String(rawValue ?? "").trim();
  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    return { date: new Date(year, month, day), allDay: true };
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zulu] = match;
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)];
  const date = zulu
    ? new Date(Date.UTC(...parts))
    : params?.TZID
      ? new Date(new Date(Date.UTC(...parts)).toLocaleString("en-US", { timeZone: params.TZID }))
      : new Date(...parts);
  return { date, allDay: false };
}

function parseIcsProperty(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(";");
  const params = {};
  for (const part of paramParts) {
    const [key, ...rest] = part.split("=");
    params[key.toUpperCase()] = rest.join("=");
  }
  return { name: name.toUpperCase(), params, value };
}

function parseRrule(value) {
  const rule = {};
  for (const part of String(value ?? "").split(";")) {
    const [key, raw] = part.split("=");
    if (!key || raw === undefined) continue;
    rule[key.toUpperCase()] = raw;
  }
  return rule;
}

function expandEvent(event, windowEnd) {
  const occurrences = [];
  const duration = event.end ? Math.max(0, event.end.getTime() - event.start.getTime()) : 0;
  const rule = event.rrule;
  if (!rule) {
    if (event.start <= windowEnd) occurrences.push(event);
    return occurrences;
  }

  const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
  const count = rule.COUNT ? Math.max(0, Number(rule.COUNT)) : null;
  const until = rule.UNTIL ? parseIcsDate(rule.UNTIL)?.date : null;
  const frequency = String(rule.FREQ ?? "").toUpperCase();
  let current = new Date(event.start);
  let index = 0;

  // Skip ahead for daily and weekly rules so a calendar from 2020 does not
  // burn the iteration budget before reaching this week.
  if (!count && (frequency === "DAILY" || frequency === "WEEKLY")) {
    const step = (frequency === "DAILY" ? 86_400_000 : 604_800_000) * interval;
    const start = event.start.getTime();
    const now = Date.now();
    const skip = Math.max(0, Math.floor((now - start) / step));
    index = skip;
    current = new Date(start + skip * step);
  }

  for (let guard = 0; guard < 600; guard += 1) {
    if (count !== null && index >= count) break;
    if (until && current > until) break;
    if (current > windowEnd) break;
    if (current.getTime() + duration >= Date.now() - 3_600_000) {
      occurrences.push({ ...event, start: new Date(current), end: new Date(current.getTime() + duration) });
    }
    index += 1;
    if (frequency === "DAILY") current.setDate(current.getDate() + interval);
    else if (frequency === "WEEKLY") current.setDate(current.getDate() + 7 * interval);
    else if (frequency === "MONTHLY") current.setMonth(current.getMonth() + interval);
    else if (frequency === "YEARLY") current.setFullYear(current.getFullYear() + interval);
    else break;
  }
  return occurrences;
}

export function parseIcsEvents(text, windowEnd = new Date(Date.now() + 7 * 86_400_000)) {
  const events = [];
  let current = null;

  for (const line of unfoldIcs(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.start) {
        for (const occurrence of expandEvent(current, windowEnd)) events.push(occurrence);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const property = parseIcsProperty(line);
    if (!property) continue;
    if (property.name === "DTSTART") {
      const start = parseIcsDate(property.value, property.params);
      current.start = start?.date;
      current.allDay = Boolean(start?.allDay);
    } else if (property.name === "DTEND") {
      current.end = parseIcsDate(property.value, property.params)?.date;
    }
    else if (property.name === "SUMMARY") current.title = property.value.replace(/\\,/g, ",").replace(/\\;/g, ";");
    else if (property.name === "LOCATION") current.location = property.value.replace(/\\,/g, ",").replace(/\\;/g, ";");
    else if (property.name === "RRULE") current.rrule = parseRrule(property.value);
  }

  return events
    .filter((event) => event.start instanceof Date && !Number.isNaN(event.start.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function formatCalendarEvent(event, english) {
  const locale = english ? "en-GB" : "es-AR";
  const date = event.allDay
    ? event.start.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })
    : event.start.toLocaleString(locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  return {
    title: event.title || (english ? "Untitled event" : "Evento sin título"),
    start: event.start.toISOString(),
    allDay: Boolean(event.allDay),
    location: event.location || null,
    when: date,
  };
}

export async function calendarEvents(args = {}) {
  const days = Math.min(365, Math.max(1, Number(args.days) || toolsConfig().calendar.days || 7));
  const configured = toolsConfig().calendar.paths ?? [];
  const paths = (Array.isArray(configured) && configured.length ? configured : CALENDAR_DIRS).map((path) =>
    path.startsWith("~") ? join(homedir(), path.slice(1)) : path,
  );
  const files = collectIcsFiles(paths);
  const now = new Date();
  const windowEnd = new Date(now.getTime() + days * 86_400_000);
  const query = String(args.query ?? "").trim().toLowerCase();
  const events = [];

  for (const file of files) {
    try {
      const text = readFileSync(file, "utf8");
      for (const event of parseIcsEvents(text, windowEnd)) {
        if (event.start < new Date(now.getFullYear(), now.getMonth(), now.getDate())) continue;
        if (event.start > windowEnd) continue;
        if (
          query &&
          !`${event.title ?? ""} ${event.location ?? ""}`.toLowerCase().includes(query)
        ) {
          continue;
        }
        events.push(event);
      }
    } catch (error) {
      console.warn(`[tools] calendar ${file}: ${error.message}`);
    }
  }

  events.sort((a, b) => a.start.getTime() - b.start.getTime());
  const limited = events.slice(0, 30);
  const items = limited.map((event) => formatCalendarEvent(event, false));
  const itemsEn = limited.map((event) => formatCalendarEvent(event, true));

  const summary = items.length
    ? `Agenda (${items.length}): ${items
        .map((item) => `${item.when} · ${item.title}${item.location ? ` (${item.location})` : ""}`)
        .join(" · ")}.`
    : `No hay eventos en los próximos ${days} días en el calendario local.`;
  const summaryEn = itemsEn.length
    ? `Calendar (${itemsEn.length}): ${itemsEn
        .map((item) => `${item.when} · ${item.title}${item.location ? ` (${item.location})` : ""}`)
        .join(" · ")}.`
    : `No events in the next ${days} days in the local calendar.`;

  return {
    days,
    paths: files.length,
    count: items.length,
    events: items,
    eventsEn: itemsEn,
    summary,
    summaryEn,
  };
}

/* ------------------------------------------------------------------ epic -- */

function epicUrl(element) {
  const slug =
    element.catalogNs?.mappings?.[0]?.pageSlug ??
    element.productSlug ??
    element.urlSlug ??
    null;
  return slug ? `https://store.epicgames.com/en-US/p/${slug}` : "https://store.epicgames.com/en-US/free-games";
}

function epicOffers(element) {
  const promotions = element.promotions ?? {};
  const offers = [];
  for (const key of ["promotionalOffers", "upcomingPromotionalOffers"]) {
    for (const group of promotions[key] ?? []) {
      for (const offer of group.promotionalOffers ?? []) {
        const percentage = Number(offer.discountSetting?.discountPercentage);
        if (percentage !== 0) continue;
        const start = new Date(offer.startDate);
        const end = new Date(offer.endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        offers.push({ start, end });
      }
    }
  }
  return offers.sort((a, b) => a.start - b.start);
}

function formatEpicDate(date, english) {
  return date.toLocaleDateString(english ? "en-GB" : "es-AR", {
    day: "numeric",
    month: "short",
  });
}

/** Quote titles and group them by their single date label. */
function epicGroups(games, field, english, prefix) {
  const groups = new Map();
  for (const game of games) {
    const label = game[field];
    if (!label) continue;
    const titles = groups.get(label) ?? [];
    titles.push(`"${game.title}"`);
    groups.set(label, titles);
  }
  return [...groups.entries()].map(
    ([label, titles]) => `${titles.join(", ")} (${prefix ? `${english ? "Until" : "hasta"} ` : ""}${label})`,
  );
}

export function formatEpicSummary(current, upcoming, english = false) {
  const parts = [];
  if (current.length) {
    const groups = epicGroups(current, "endLabel", english, true);
    parts.push(
      `${english ? "Free on Epic now" : "Gratis en Epic ahora"}: ${groups.join("; ")}.`,
    );
  }
  if (upcoming.length) {
    const groups = epicGroups(upcoming, "startLabel", english, false);
    parts.push(`${english ? "Coming soon" : "Próximamente"}: ${groups.join("; ")}.`);
  }
  if (!parts.length) {
    return english ? "Epic has no free games announced right now." : "Epic no tiene juegos gratis anunciados en este momento.";
  }
  return parts.join(" ");
}

export async function epicFreeGames() {
  const data = await getJson(
    "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US",
    15_000,
  );
  const elements = data?.data?.Catalog?.searchStore?.elements ?? [];
  const now = Date.now();
  const current = [];
  const upcoming = [];
  const seen = new Set();

  for (const element of elements) {
    if (!element?.title || seen.has(element.title)) continue;
    for (const offer of epicOffers(element)) {
      const start = offer.start.getTime();
      const end = offer.end.getTime();
      const game = {
        title: element.title,
        url: epicUrl(element),
        start: offer.start.toISOString(),
        end: offer.end.toISOString(),
      };
      if (start <= now && end >= now) {
        current.push({
          ...game,
          endLabel: formatEpicDate(offer.end, false),
          endLabelEn: formatEpicDate(offer.end, true),
        });
        seen.add(element.title);
        break;
      }
      if (start > now && start <= now + 30 * 86_400_000) {
        upcoming.push({
          ...game,
          startLabel: formatEpicDate(offer.start, false),
          startLabelEn: formatEpicDate(offer.start, true),
        });
        seen.add(element.title);
        break;
      }
    }
  }

  upcoming.sort((a, b) => new Date(a.start) - new Date(b.start));
  current.sort((a, b) => new Date(a.end) - new Date(b.end));

  const currentEn = current.map((game) => ({ ...game, endLabel: game.endLabelEn }));
  const upcomingEn = upcoming.map((game) => ({ ...game, startLabel: game.startLabelEn }));
  const summary = formatEpicSummary(current, upcoming, false);
  const summaryEn = formatEpicSummary(currentEn, upcomingEn, true);

  return {
    current,
    upcoming,
    summary,
    summaryEn,
  };
}

/* ----------------------------------------------------------------- steam -- */

const STEAM_UA = "Mozilla/5.0 (X11; Linux x86_64) Baldborg/1.0";

function steamSearchUrl() {
  return (
    "https://store.steampowered.com/search/results/?query&start=0&count=100" +
    "&infinite=1&specials=1&maxprice=free&ndl=1&category1=998&cc=us&l=en"
  );
}

/** Parse the Steam search JSON into appid/title candidates. */
export function parseSteamSearch(payload) {
  const html = String(payload?.results_html ?? "");
  const found = new Map();
  for (const row of html.matchAll(/<a\b[^>]*data-ds-appid="(\d+)"[\s\S]*?<\/a>/g)) {
    const block = row[0];
    // The search page is the cheap first pass: only 100% discount rows.
    if (!/-100%/.test(block)) continue;
    const title = block.match(/<span class="title">([^<]+)<\/span>/);
    if (!found.has(row[1]) && title) found.set(row[1], title[1].trim());
  }
  return [...found.entries()].map(([id, title]) => ({
    id,
    title,
    url: `https://store.steampowered.com/app/${id}/`,
  }));
}

/**
 * Steam marks a limited 100% promotion with is_free_to_keep and an end
 * timestamp. Permanently free games and free weekends do not have both.
 */
export function parseSteamFreeKeepPage(html) {
  const normalized = String(html).replace(/&quot;/g, '"').replace(/&#34;/g, '"');
  if (!/"is_free_to_keep"\s*:\s*1/.test(normalized)) return null;
  const ends = normalized.match(/"free_to_keep_ends"\s*:\s*(\d+)/);
  if (!ends) return null;
  const date = new Date(Number(ends[1]) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatSteamFreeGames(games, english = false) {
  if (!games.length) {
    return english ? "No free-to-keep games on Steam right now." : "No hay juegos gratis para reclamar en Steam ahora mismo.";
  }
  const groups = new Map();
  for (const game of games) {
    const label = english ? game.endLabelEn : game.endLabel;
    const titles = groups.get(label) ?? [];
    titles.push(`"${game.title}"`);
    groups.set(label, titles);
  }
  const lines = [...groups.entries()].map(
    ([label, titles]) =>
      `${titles.join(", ")} (${english ? "Until" : "hasta"} ${label})`,
  );
  return `${english ? "Free to keep on Steam" : "Gratis para reclamar en Steam"}: ${lines.join("; ")}.`;
}

export async function steamFreeGames() {
  const payload = await getJson(steamSearchUrl(), 15_000, {
    "user-agent": STEAM_UA,
    "accept-language": "en-US,en;q=0.9",
  });
  const candidates = parseSteamSearch(payload);
  const games = [];

  for (const candidate of candidates) {
    try {
      const html = await getText(candidate.url + "?cc=us&l=en", 15_000);
      const ends = parseSteamFreeKeepPage(html);
      if (!ends) continue;
      games.push({
        ...candidate,
        endsAt: ends.toISOString(),
        endLabel: formatEpicDate(ends, false),
        endLabelEn: formatEpicDate(ends, true),
      });
    } catch (error) {
      console.warn(`[tools] steam ${candidate.id}: ${error.message}`);
    }
  }

  games.sort((a, b) => new Date(a.endsAt) - new Date(b.endsAt));
  return {
    games,
    summary: formatSteamFreeGames(games, false),
    summaryEn: formatSteamFreeGames(games, true),
  };
}

/* ---------------------------------------------------------------- dispatch -- */

/**
 * Validate arguments and return a runnable action.
 * Actions with side effects set `requiresConfirmation`.
 */
export function prepareTool(name, rawArgs) {
  let args = rawArgs ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }

  const userTool = userTools.find((tool) => tool.name === name);
  if (userTool) {
    if (typeof userTool.prepare === "function") return userTool.prepare(args);
    return {
      summary: userTool.description,
      run: async () => userTool.run(args),
    };
  }

  switch (name) {
    case "get_weather":
      return {
        summary: `Consultar el clima${args.city ? ` de ${args.city}` : ""}`,
        run: async () => {
          const data = await weather(args.city);
          return { ok: true, ...data };
        },
      };

    case "set_reminder":
      return prepareReminder(args);

    case "list_reminders": {
      const pending = listPendingReminders();
      const locale = args.language === "en" ? "en-US" : "es-MX";
      const items = pending.map((entry) => ({
        text: entry.text,
        at: new Date(entry.at).toLocaleString(locale, {
          weekday: "long",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      }));
      const summary = items.length
        ? items.map((item) => `${item.text} · ${item.at}`).join("; ")
        : args.language === "en"
          ? "No pending reminders."
          : "No hay recordatorios pendientes.";
      return { summary, run: async () => ({ ok: true, count: items.length, items, summary }) };
    }
    case "get_time":
      return { summary: "Consultar la hora", run: async () => ({ ok: true, ...localTime() }) };

    case "system_status":
      return {
        summary: "Consultar el estado del equipo",
        run: async () => ({ ok: true, ...systemStatus() }),
      };

    case "convert_units":
      return {
        summary: `Convertir ${args.value ?? ""} ${args.from ?? ""} a ${args.to ?? ""}`,
        run: async () => ({ ok: true, ...convertUnits(args) }),
      };

    case "get_exchange_rate":
      return {
        summary: `Consultar cotización ${args.currency ?? "USD"}${
          args.house ? ` ${args.house}` : ""
        }`,
        run: async () => ({ ok: true, ...(await exchangeRate(args)) }),
      };

    case "calendar_events":
      return {
        summary: `Consultar la agenda${args.days ? ` (${args.days} días)` : ""}`,
        run: async () => ({ ok: true, ...(await calendarEvents(args)) }),
      };

    case "epic_free_games":
      return {
        summary: "Consultar los juegos gratis de Epic",
        run: async () => ({ ok: true, ...(await epicFreeGames()) }),
      };

    case "steam_free_games":
      return {
        summary: "Consultar los juegos gratis para reclamar en Steam",
        run: async () => ({ ok: true, ...(await steamFreeGames()) }),
      };

    case "team_fixtures":
      return {
        summary: "Consultar partidos",
        run: async () => {
          const data = await teamFixtures(args.team);
          return { ok: true, ...data };
        },
      };

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function toolsEnabled() {
  return toolsConfig().enabled;
}

export function configuredTeam() {
  return toolsConfig().team.name;
}

export function configuredCity() {
  return toolsConfig().weather.defaultCity;
}

export function setFavouriteTeam(name) {
  const value = name.trim();
  if (!value) throw new Error("empty team");
  updateConfig((raw) => {
    raw.tools = raw.tools ?? {};
    raw.tools.team = { ...(raw.tools.team ?? {}), name: value };
  });
  matchCache = null;
  return value;
}

export function setDefaultCity(name) {
  const value = name.trim();
  if (!value) throw new Error("empty city");
  updateConfig((raw) => {
    raw.tools = raw.tools ?? {};
    raw.tools.weather = { ...(raw.tools.weather ?? {}), defaultCity: value };
  });
  weatherCache = null;
  return value;
}
