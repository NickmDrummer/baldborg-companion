/**
 * Tool registry for the assistant.
 *
 * Each tool exposes an Ollama-compatible JSON schema plus a `prepare` step that
 * validates the arguments and, for actions with side effects, returns a
 * human-readable summary that the user must confirm before `run` executes.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, loadavg, totalmem, freemem, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");
const STATE_DIR = join(homedir(), ".config", "baldborg");
const REMINDERS_FILE = join(STATE_DIR, "reminders.json");
const SPORTS_KEY = "123"; // TheSportsDB public test key

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
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function toolsConfig() {
  const raw = config().tools ?? {};
  return {
    enabled: raw.enabled !== false,
    weather: { defaultCity: "Rosario", ...(raw.weather ?? {}) },
    team: { name: "Rosario Central", ...(raw.team ?? {}) },
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

async function getJson(url, timeout = 12_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
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
            description: "Absolute local datetime in ISO 8601 (e.g. 2026-10-31T18:30).",
          },
        },
        required: ["text"],
      },
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
        "Workstation status: uptime, load average, memory usage and battery level.",
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
    current: forecast.current,
    daily: forecast.daily,
  };
}

/* ------------------------------------------------------------- reminders -- */

function loadReminders() {
  try {
    const raw = JSON.parse(readFileSync(REMINDERS_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveReminders(list) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2));
}

function parseWhen(args) {
  if (typeof args.minutes === "number" && Number.isFinite(args.minutes) && args.minutes > 0) {
    return new Date(Date.now() + args.minutes * 60_000);
  }
  if (typeof args.at === "string" && args.at.trim()) {
    const date = new Date(args.at.trim());
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function formatWhen(date) {
  return date.toLocaleString("es-MX", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function prepareReminder(args) {
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("reminder text is required");

  const when = parseWhen(args);
  if (!when) throw new Error("se necesita 'minutes' o 'at' para el recordatorio");
  if (when.getTime() <= Date.now() + 5_000) throw new Error("esa hora ya pasó");

  return {
    requiresConfirmation: true,
    summary: `Recordatorio: "${text}" · ${formatWhen(when)}`,
    async run() {
      const id = `r${Date.now().toString(36)}`;
      const reminder = { id, text, at: when.toISOString(), created: new Date().toISOString() };

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

      return { ok: true, scheduledFor: when.toISOString(), summary: formatWhen(when) };
    },
  };
}

/* ------------------------------------------------------------------ team -- */

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

  const format = (event) => {
    const date = event.strTimestamp ? new Date(`${event.strTimestamp}Z`) : null;
    return {
      event: event.strEvent,
      league: event.strLeague,
      whenIso: date ? date.toISOString() : null,
      when: date
        ? date.toLocaleString("es-MX", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
        : event.dateEvent,
      score: event.intHomeScore != null ? `${event.intHomeScore}-${event.intAwayScore}` : null,
    };
  };

  const upcoming = (next.events ?? []).slice(0, 3).map(format);
  const previous = (last.results ?? []).slice(0, 1).map(format);

  if (upcoming[0]) {
    matchCache = { event: upcoming[0].event, when: upcoming[0].whenIso, at: Date.now() };
  }

  const parts = [];
  if (upcoming.length) parts.push(`Próximos partidos: ${upcoming.map((item) => `${item.event} (${item.when})`).join(" · ")}`);
  if (previous.length) {
    const p = previous[0];
    parts.push(`Último resultado: ${p.event}${p.score ? ` ${p.score}` : ""} (${p.when})`);
  }
  if (!parts.length) parts.push(`${team.strTeam}: sin partidos próximos ni resultados recientes registrados.`);

  return {
    team: team.strTeam,
    league: team.strLeague,
    upcoming,
    previous,
    summary: parts.join(". "),
  };
}

/* ------------------------------------------------------------------ misc -- */

function systemStatus() {
  const batteryPath = "/sys/class/power_supply/BAT0/capacity";
  const battery = existsSync(batteryPath) ? readFileSync(batteryPath, "utf8").trim() : null;
  const memory = Math.round(((totalmem() - freemem()) / totalmem()) * 100);
  const load = loadavg()[0].toFixed(2);
  const hours = Math.floor(uptime() / 3600);
  const minutes = Math.floor((uptime() % 3600) / 60);

  return {
    uptime: `${hours} h ${minutes} min`,
    load,
    memory: `${memory} % en uso`,
    battery: battery ? `${battery} %` : "sin batería",
    summary:
      `Equipo encendido ${hours} h ${minutes} min, carga media ${load}, ` +
      `memoria ${memory} %${battery ? `, batería ${battery} %` : ""}.`,
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

    case "get_time":
      return { summary: "Consultar la hora", run: async () => ({ ok: true, ...localTime() }) };

    case "system_status":
      return { summary: "Consultar el estado del equipo", run: async () => ({ ok: true, ...systemStatus() }) };

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
