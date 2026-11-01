/**
 * Epic free-games watch.
 *
 * One scheduled check per week, not a poll: Epic refreshes its free games on
 * Thursdays at 16:00 UTC (13:00 in Argentina). We check a few minutes later and
 * announce only titles that were not in the previous list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { announceBeat, resolveLanguage } from "./beats.js";
import { epicFreeGames } from "./tools.js";

const STATE_DIR = join(homedir(), ".config", "baldborg");
const STATE_FILE = join(STATE_DIR, "epic.json");

/** Thursday, 13:05 local time. */
const CHECK_DAY = 4;
const CHECK_HOUR = 13;
const CHECK_MINUTE = 5;

let timer = null;
let started = false;
let checking = false;
let seeding = false;

function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function nextEpicCheck(now = new Date()) {
  const next = new Date(now);
  next.setHours(CHECK_HOUR, CHECK_MINUTE, 0, 0);
  let days = (CHECK_DAY - next.getDay() + 7) % 7;
  if (days === 0 && next.getTime() <= now.getTime()) days = 7;
  next.setDate(next.getDate() + days);
  return next;
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      lastCheck: typeof raw.lastCheck === "string" ? raw.lastCheck : null,
      current: Array.isArray(raw.current) ? raw.current.filter((title) => typeof title === "string") : [],
    };
  } catch {
    return { lastCheck: null, current: [] };
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function epicTitles(games) {
  return [...new Set((games ?? []).map((game) => game?.title).filter(Boolean))].sort();
}

export function newEpicTitles(previous, current) {
  const known = new Set(previous ?? []);
  return (current ?? []).filter((title) => !known.has(title));
}

export function epicBeatText(titles, language = "es") {
  return language === "en"
    ? `New free games on Epic: ${titles.join(", ")}.`
    : `Nuevos juegos gratis en Epic: ${titles.join(", ")}.`;
}

/**
 * One silent fetch on first run, so the first Thursday can compare against the
 * games that were already available when the user installed the app. This is
 * not a recurring check.
 */
async function seedIfNeeded() {
  if (seeding || existsSync(STATE_FILE)) return;
  seeding = true;
  try {
    const games = await epicFreeGames();
    const current = epicTitles(games.current);
    if (current.length) saveState({ lastCheck: localDay(), current });
  } catch (error) {
    console.warn("[baldborg] epic seed failed:", error.message);
  } finally {
    seeding = false;
  }
}

async function checkNow() {
  if (checking) return;
  checking = true;
  try {
    const games = await epicFreeGames();
    const current = epicTitles(games.current);
    if (!current.length) return;

    const state = loadState();
    const fresh = newEpicTitles(state.current, current);
    const firstRun = state.lastCheck === null || state.current.length === 0;

    if (!firstRun && fresh.length) {
      const language = resolveLanguage();
      announceBeat(epicBeatText(fresh, language), "epic-free-games", "pleased");
      console.info(`[baldborg] epic beat: ${fresh.join(", ")}`);
    } else {
      console.info(`[baldborg] epic check: ${fresh.length} new game(s)`);
    }

    saveState({ lastCheck: localDay(), current });
  } catch (error) {
    console.warn("[baldborg] epic check failed:", error.message);
  } finally {
    checking = false;
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  const next = nextEpicCheck();
  timer = setTimeout(async () => {
    timer = null;
    await checkNow();
    schedule();
  }, Math.max(1_000, next.getTime() - Date.now()));
  console.info(`[baldborg] next Epic check: ${next.toISOString()}`);
}

/**
 * Called after the beat scheduler is ready. Idempotent: changing the beat
 * cadence calls it again without duplicating the weekly timer or the catch-up.
 */
export function startEpicWatch() {
  if (started) {
    schedule();
    return;
  }
  started = true;
  schedule();

  void (async () => {
    await seedIfNeeded();
    const now = new Date();
    const dueToday =
      now.getDay() === CHECK_DAY &&
      now.getHours() * 60 + now.getMinutes() >= CHECK_HOUR * 60 + CHECK_MINUTE;
    if (dueToday && loadState().lastCheck !== localDay(now)) {
      await checkNow();
    }
  })();
}

export function stopEpicWatch() {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}
