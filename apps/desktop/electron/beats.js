/**
 * Proactive scheduler: occasionally says something on its own, but only when
 * it will not be annoying. Every gate must pass and a daily cap applies.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, uptime } from "node:os";
import { join } from "node:path";

import { BEATS } from "../../../packages/persona/beats.mjs";
import { rewriteBeat } from "./beatgen.js";
import { lastMatch, lastWeather } from "./tools.js";
import { readConfig } from "./settings.js";

const STATE_DIR = join(homedir(), ".config", "baldborg");
const STATE_FILE = join(STATE_DIR, "beats.json");
const REMINDERS_FILE = join(STATE_DIR, "reminders.json");

const DEFAULTS = {
  enabled: true,
  minMinutes: 20,
  maxMinutes: 45,
  everyMinutes: 0,
  generator: "model",
  silentHours: [23, 8],
  dailyCap: 6,
  speak: true,
  language: "es",
};

const LANGUAGES = new Set(["es", "en", "auto"]);

function config() {
  try {
    const raw = readConfig();
    return { ...DEFAULTS, ...(raw.beats ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

let state = loadState();
let timer = null;
let nextAt = null;
let lastBlocked = null;
let startedAt = Date.now();
let send = () => {};
let getMode = () => "passive";

/** The old activity beat quoted the active window title; drop those lines. */
function withoutTabTitles(lines) {
  return (Array.isArray(lines) ? lines : []).filter(
    (line) => !/^(I see|Veo)\s+["«]/.test(String(line)),
  );
}

function loadState() {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      day: "",
      count: 0,
      lastFired: {},
      lastInteraction: 0,
      scores: {},
      pending: null,
      beatLanguage: null,
      lastLanguage: null,
      recentBeats: [],
      ...saved,
      recentBeats: withoutTabTitles(saved.recentBeats),
    };
  } catch {
    return {
      day: "",
      count: 0,
      lastFired: {},
      lastInteraction: 0,
      recentBeats: [],
    };
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
      time: new Date(upcoming[0].when).toLocaleTimeString(
        resolveLanguage() === "en" ? "en-US" : "es-MX",
        { hour: "2-digit", minute: "2-digit", hour12: false },
      ),
      text: upcoming[0].text,
      inMinutes: Math.round((upcoming[0].when - now) / 60_000),
    };
  } catch {
    return null;
  }
}

/** Manual language: UI and beats share `ui.language`. */
export function resolveLanguage() {
  const setting = config().language ?? "es";
  return setting === "en" ? "en" : "es";
}

export function setLanguage(code) {
  if (!LANGUAGES.has(code)) return null;
  state.beatLanguage = code;
  saveState();
  return resolveLanguage();
}

/** Remember the language the client last wrote in, for "auto". */
export function noteLanguage(code) {
  const normalised = code === "en" ? "en" : "es";
  if (state.lastLanguage === normalised) return;
  state.lastLanguage = normalised;
  saveState();
}

function mprisProperty(service, property) {
  try {
    const output = execFileSync(
      "busctl",
      [
        "--user",
        "get-property",
        service,
        "/org/mpris/MediaPlayer2",
        "org.mpris.MediaPlayer2.Player",
        property,
      ],
      { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    return output;
  } catch {
    return "";
  }
}

function mprisMedia() {
  try {
    const services = execFileSync("busctl", ["--user", "list", "--no-legend"], {
      timeout: 1200,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name.startsWith("org.mpris.MediaPlayer2."))
      .slice(0, 4);

    for (const service of services) {
      const status = mprisProperty(service, "PlaybackStatus");
      if (!/playing/i.test(status)) continue;
      const metadata = mprisProperty(service, "Metadata");
      const quoteAfter = (key) => {
        const index = metadata.indexOf(key);
        if (index < 0) return "";
        let rest = metadata.slice(index + key.length);
        if (rest.startsWith('"')) rest = rest.slice(1);
        return rest.match(/"([^"]*)"/)?.[1] ?? "";
      };
      const artist = quoteAfter("xesam:artist");
      const title = quoteAfter("xesam:title");
      const label = [artist, title].filter(Boolean).join(" — ");
      return (label || service).replace(/\s+/g, " ").trim().slice(0, 120);
    }
  } catch {
    /* MPRIS is optional */
  }
  return null;
}

function mediaStatus() {
  try {
    const status = execFileSync("playerctl", ["status"], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (status === "Playing") {
      const metadata = execFileSync(
        "playerctl",
        ["metadata", "--format", "{{artist}} — {{title}}"],
        { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      return metadata || status;
    }
  } catch {
    /* playerctl is optional; try MPRIS below */
  }
  return mprisMedia();
}

function packagesUpdating() {
  for (const process of ["pacman", "paru", "yay"]) {
    try {
      execFileSync("pgrep", ["-x", process], { timeout: 800, stdio: "ignore" });
      return true;
    } catch {
      /* not running */
    }
  }
  return false;
}

function currentActivity() {
  const media = mediaStatus();
  const updating = packagesUpdating();
  if (!media && !updating) return null;
  return { media, updating };
}

function buildContext(language) {
  const now = new Date();
  const activity = currentActivity();
  if (process.env.BALDBORG_BEAT_DEBUG) {
    console.info("[baldborg] activity:", JSON.stringify(activity));
  }
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
    locale: language === "en" ? "en-US" : "es-MX",
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
      match &&
      new Date(match.when).toLocaleDateString("en-CA") === now.toLocaleDateString("en-CA")
        ? match.event
        : null,
    activity,
  };
}

/**
 * A beat counts as engaged when the client talks to the assistant shortly
 * after it; otherwise it is ignored and loses weight over time.
 */
function resolvePending(engaged) {
  if (!state.pending) return;
  const age = Date.now() - (state.pending.at ?? 0);
  state.scores = state.scores ?? {};
  const id = state.pending.id;
  const delta = engaged && age < 15 * 60_000 ? 1 : -0.6;
  state.scores[id] = Math.max(-4, Math.min(4, (state.scores[id] ?? 0) + delta));
  state.pending = null;
}

function pickBeat(ctx) {
  const now = Date.now();
  const eligible = BEATS.filter((beat) => {
    const last = state.lastFired[beat.id] ?? 0;
    return now - last >= beat.cooldownHours * 3_600_000 && beat.when(ctx);
  });
  if (!eligible.length) return null;

  const weightOf = (beat) =>
    Math.max(0.2, beat.weight * (1 + (state.scores?.[beat.id] ?? 0) * 0.25));

  const total = eligible.reduce((sum, beat) => sum + weightOf(beat), 0);
  let roll = Math.random() * total;
  for (const beat of eligible) {
    roll -= weightOf(beat);
    if (roll <= 0) return beat;
  }
  return eligible[eligible.length - 1];
}

function gateReason() {
  const cfg = config();
  if (!cfg.enabled) return "beats desactivados";
  if (getMode() === "interactive") return "chat abierto";

  const now = new Date();
  if (inSilentHours(now.getHours(), cfg.silentHours)) return "horas silenciosas";
  if (desktopLocked()) return "sesión bloqueada";
  if (fullscreenActive()) return "pantalla completa";

  const day = todayKey(now);
  if (state.day !== day) {
    state.day = day;
    state.count = 0;
  }
  if (state.count >= cfg.dailyCap) return "tope diario";
  return null;
}

function gatesPass() {
  return gateReason() === null;
}

export function beatStatus() {
  const cfg = config();
  const minutes = nextAt ? Math.max(0, Math.round((nextAt - Date.now()) / 60_000)) : null;
  return {
    running: Boolean(timer),
    enabled: cfg.enabled,
    everyMinutes: cfg.everyMinutes ?? 0,
    minMinutes: cfg.minMinutes,
    maxMinutes: cfg.maxMinutes,
    silentHours: cfg.silentHours,
    dailyCap: cfg.dailyCap,
    count: state.count,
    nextAt: nextAt ? new Date(nextAt).toISOString() : null,
    nextInMinutes: minutes,
    lastBlocked,
    mode: getMode(),
  };
}

function deliver(text, id, mood, source, count = true) {
  state.lastFired[id] = Date.now();
  state.pending = { id, at: Date.now() };
  if (count) state.count += 1;
  state.recentBeats = [...(state.recentBeats ?? []), text].slice(-8);
  saveState();
  send({ type: "beat", id, text, mood, speak: config().speak });
  console.info(`[baldborg] ${source} beat: ${text}`);
  return id;
}

function poolBeat(ctx, forced) {
  if (forced) {
    const byCondition = BEATS.filter((beat) => beat.when(ctx));
    const pool = byCondition.length
      ? byCondition
      : BEATS.filter((beat) => ["checkin", "offer", "silence"].includes(beat.id));
    return (
      pool
        .slice()
        .sort((a, b) => (state.lastFired[a.id] ?? 0) - (state.lastFired[b.id] ?? 0))[0] ?? null
    );
  }
  return pickBeat(ctx);
}

function mentionsActivity(text, activity) {
  if (!activity) return true;
  const sample = String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const tokens = ["music", "musica", "cancion", "song", "listen", "escuch", "update", "actualiz", "paquete", "package"];
  if (activity.media) tokens.push(...activity.media.toLowerCase().split(/[^a-z0-9]+/));
  return tokens.some((token) => token.length >= 3 && sample.includes(token));
}

async function beatFor(ctx, language, forced) {
  const beat = poolBeat(ctx, forced);
  if (!beat) return null;

  const seed = language === "en" ? (beat.textEn?.(ctx) ?? beat.text(ctx)) : beat.text(ctx);
  if (config().generator !== "pool") {
    const rewritten = await rewriteBeat(seed, language, state.recentBeats ?? []);
    if (
      rewritten &&
      (beat.id !== "activity" || mentionsActivity(rewritten, ctx.activity))
    ) {
      if (!forced && !gatesPass()) return null;
      return deliver(rewritten, beat.id, beat.mood, "generated", !forced);
    }
  }

  if (!forced && !gatesPass()) return null;
  return deliver(seed, beat.id, beat.mood, forced ? "forced" : "pool", !forced);
}

async function fire() {
  // The previous beat was not answered: let it lose weight.
  resolvePending(false);

  const language = resolveLanguage();
  const ctx = buildContext(language);
  return beatFor(ctx, language, false);
}

export function nextIntervalMinutes(cfg = config()) {
  if (Number(cfg.everyMinutes) > 0) return Math.max(1, Number(cfg.everyMinutes));
  return cfg.minMinutes + Math.random() * Math.max(1, cfg.maxMinutes - cfg.minMinutes);
}

function schedule() {
  if (timer) clearTimeout(timer);
  const cfg = config();
  if (!cfg.enabled) return;
  const minutes = nextIntervalMinutes(cfg);
  nextAt = Date.now() + minutes * 60_000;
  timer = setTimeout(async () => {
    nextAt = null;
    const reason = gateReason();
    if (reason) {
      lastBlocked = { reason, at: Date.now() };
      console.info(`[baldborg] beat skipped: ${reason}`);
    } else {
      lastBlocked = null;
      try {
        await fire();
      } catch (error) {
        console.warn("[baldborg] beat failed:", error.message);
      }
    }
    schedule();
  }, minutes * 60_000);
}

export function startBeats(options) {
  send = options.send ?? send;
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
  nextAt = null;
}

/** Called whenever the client talks to the assistant: postpone the next beat. */
export function noteInteraction() {
  resolvePending(true);
  state.lastInteraction = Date.now();
  saveState();
  schedule();
}

/**
 * One-off announcement (Epic, future calendar hooks). It uses the same delivery
 * path as beats but does not consume the daily cap, and it is independent of
 * the chat voice switch.
 */
export function announceBeat(text, id = "announcement", mood = "pleased") {
  return deliver(text, id, mood, "announcement", false);
}

/**
 * Force a beat for testing: bypasses every gate, including cooldowns.
 * Falls back to the beats that always make sense if the context-specific ones
 * do not apply right now.
 */
export async function forceBeat() {
  resolvePending(false);

  const language = resolveLanguage();
  const ctx = buildContext(language);
  return beatFor(ctx, language, true);
}
