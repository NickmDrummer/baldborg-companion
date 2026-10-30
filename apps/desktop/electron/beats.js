/**
 * Proactive scheduler: occasionally says something on its own, but only when
 * it will not be annoying. Every gate must pass and a daily cap applies.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BEATS } from "../../../packages/persona/beats.mjs";
import { lastMatch, lastWeather } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CONFIG_PATH = join(REPO_ROOT, "config", "default.json");
const STATE_DIR = join(homedir(), ".config", "baldborg");
const STATE_FILE = join(STATE_DIR, "beats.json");
const REMINDERS_FILE = join(STATE_DIR, "reminders.json");

const DEFAULTS = {
  enabled: true,
  minMinutes: 20,
  maxMinutes: 45,
  silentHours: [23, 8],
  dailyCap: 6,
  speak: false,
};

function config() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULTS, ...(raw.beats ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

let state = loadState();
let timer = null;
let startedAt = Date.now();
let send = () => {};
let isMuted = () => false;
let getMode = () => "passive";

function loadState() {
  try {
    return {
      day: "",
      count: 0,
      lastFired: {},
      lastInteraction: 0,
      ...JSON.parse(readFileSync(STATE_FILE, "utf8")),
    };
  } catch {
    return { day: "", count: 0, lastFired: {}, lastInteraction: 0 };
  }
}

function saveState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn("[baldborg] could not persist beats:", error.message);
  }
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function inSilentHours(hour, [start, end]) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function desktopLocked() {
  try {
    execFileSync("pgrep", ["-x", "hyprlock"], { timeout: 1000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fullscreenActive() {
  try {
    const raw = execFileSync("hyprctl", ["activewindow", "-j"], { timeout: 1500 }).toString();
    const active = JSON.parse(raw);
    return Boolean(active?.fullscreen);
  } catch {
    return false;
  }
}

function nextReminder() {
  try {
    const reminders = JSON.parse(readFileSync(REMINDERS_FILE, "utf8"));
    if (!Array.isArray(reminders)) return null;
    const now = Date.now();
    const upcoming = reminders
      .map((entry) => ({ ...entry, when: new Date(entry.at).getTime() }))
      .filter((entry) => entry.when > now)
      .sort((a, b) => a.when - b.when);
    if (!upcoming.length) return null;
    return {
      time: new Date(upcoming[0].when).toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      text: upcoming[0].text,
      inMinutes: Math.round((upcoming[0].when - now) / 60_000),
    };
  } catch {
    return null;
  }
}

function buildContext() {
  const now = new Date();
  const weather = lastWeather();
  const match = lastMatch();
  const reminder = nextReminder();

  return {
    now,
    hour: now.getHours(),
    weekday: now.getDay(),
    uptimeDays: uptime() / 86400,
    sessionHours: (now.getTime() - startedAt) / 3_600_000,
    hoursSinceInteraction: (now.getTime() - (state.lastInteraction || startedAt)) / 3_600_000,
    nextReminder: reminder && reminder.inMinutes <= 45 ? reminder : null,
    weather:
      weather && now.getTime() - weather.at < 2 * 3_600_000
        ? {
            place: weather.place,
            temperature: weather.temperature,
            rainChance: weather.rainChance,
          }
        : null,
    matchToday:
      match && new Date(match.when).toDateString() === now.toDateString()
        ? match.event
        : null,
  };
}

function pickBeat(ctx) {
  const now = Date.now();
  const eligible = BEATS.filter((beat) => {
    const last = state.lastFired[beat.id] ?? 0;
    return now - last >= beat.cooldownHours * 3_600_000 && beat.when(ctx);
  });
  if (!eligible.length) return null;

  const total = eligible.reduce((sum, beat) => sum + beat.weight, 0);
  let roll = Math.random() * total;
  for (const beat of eligible) {
    roll -= beat.weight;
    if (roll <= 0) return beat;
  }
  return eligible[eligible.length - 1];
}

function gatesPass() {
  const cfg = config();
  if (!cfg.enabled) return false;
  if (isMuted()) return false;
  if (getMode() === "interactive") return false;

  const now = new Date();
  if (inSilentHours(now.getHours(), cfg.silentHours)) return false;
  if (desktopLocked()) return false;
  if (fullscreenActive()) return false;

  const day = todayKey(now);
  if (state.day !== day) {
    state.day = day;
    state.count = 0;
  }
  if (state.count >= cfg.dailyCap) return false;

  return true;
}

function fire() {
  const ctx = buildContext();
  const beat = pickBeat(ctx);
  if (!beat) return null;

  const text = beat.text(ctx);
  state.lastFired[beat.id] = Date.now();
  state.count += 1;
  saveState();
  send({ type: "beat", id: beat.id, text, mood: beat.mood, speak: config().speak });
  console.info(`[baldborg] beat ${beat.id}: ${text}`);
  return beat.id;
}

function schedule() {
  if (timer) clearTimeout(timer);
  const cfg = config();
  if (!cfg.enabled) return;
  const minutes = cfg.minMinutes + Math.random() * Math.max(1, cfg.maxMinutes - cfg.minMinutes);
  timer = setTimeout(() => {
    try {
      if (gatesPass()) fire();
    } catch (error) {
      console.warn("[baldborg] beat failed:", error.message);
    }
    schedule();
  }, minutes * 60_000);
}

export function startBeats(options) {
  send = options.send ?? send;
  isMuted = options.isMuted ?? isMuted;
  getMode = options.getMode ?? getMode;
  startedAt = Date.now();
  state.lastInteraction = Date.now();
  saveState();
  schedule();
  console.info("[baldborg] beats scheduled");
}

export function stopBeats() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Called whenever the client talks to the assistant: postpone the next beat. */
export function noteInteraction() {
  state.lastInteraction = Date.now();
  saveState();
  schedule();
}

/** Force a beat, bypassing every gate; used by the control socket. */
export function forceBeat() {
  return fire();
}
