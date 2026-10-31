/**
 * Single writer for `config/default.json`.
 *
 * Tools and commands read this file on every call, so a change takes effect
 * immediately without restarting the app. Writes are atomic to avoid leaving a
 * half-written config if the process dies mid-save.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");

export const BEAT_LANGUAGES = new Set(["es", "en", "auto"]);
export const AVATAR_MATERIALS = new Set(["normal", "hologram"]);
export const VOICE_PROVIDERS = new Set(["kokoro", "azure"]);

export function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

export function updateConfig(mutator) {
  const raw = readConfig();
  mutator(raw);
  const temporary = `${CONFIG_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n");
  renameSync(temporary, CONFIG_PATH);
  return raw;
}

export function setAutoSpeak(value) {
  updateConfig((raw) => {
    raw.voice = raw.voice ?? {};
    raw.voice.autoSpeak = Boolean(value);
  });
  return Boolean(value);
}

export function setBeatsEnabled(value) {
  updateConfig((raw) => {
    raw.beats = raw.beats ?? {};
    raw.beats.enabled = Boolean(value);
  });
  return Boolean(value);
}

export function setVoiceProvider(value) {
  if (!VOICE_PROVIDERS.has(value)) throw new Error("invalid voice provider");
  updateConfig((raw) => {
    raw.voice = raw.voice ?? {};
    raw.voice.provider = value;
  });
  return value;
}

export function setBeatsEvery(minutes) {
  const value = Number(minutes);
  if (!Number.isInteger(value) || value < 0 || value > 240) {
    throw new Error("invalid beat interval");
  }
  updateConfig((raw) => {
    raw.beats = raw.beats ?? {};
    raw.beats.everyMinutes = value;
  });
  return value;
}

export function setSilentHours(start, end) {
  const from = Number(start);
  const to = Number(end);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 23 || to < 0 || to > 23) {
    throw new Error("invalid silent hours");
  }
  updateConfig((raw) => {
    raw.beats = raw.beats ?? {};
    raw.beats.silentHours = [from, to];
  });
  return [from, to];
}

export function setBeatsLanguage(value) {
  if (!BEAT_LANGUAGES.has(value)) throw new Error("invalid beat language");
  updateConfig((raw) => {
    raw.beats = raw.beats ?? {};
    raw.beats.language = value;
  });
  return value;
}

export function setAvatarMaterial(value) {
  if (!AVATAR_MATERIALS.has(value)) throw new Error("invalid avatar material");
  updateConfig((raw) => {
    raw.avatar = raw.avatar ?? {};
    raw.avatar.material = value;
  });
  return value;
}

/** Flat snapshot for `/config` and `/status`. */
export function configSummary() {
  const raw = readConfig();
  return {
    model: raw.brain?.model ?? "?",
    context: raw.brain?.numCtx ?? 0,
    temperature: raw.brain?.temperature ?? 0,
    autoSpeak: raw.voice?.autoSpeak !== false,
    voiceProvider: raw.voice?.provider ?? "kokoro",
    sttModel: raw.voice?.stt?.model ?? "?",
    beatsEnabled: raw.beats?.enabled !== false,
    beatsLanguage: raw.beats?.language ?? "es",
    beatsMin: raw.beats?.minMinutes ?? 20,
    beatsMax: raw.beats?.maxMinutes ?? 45,
    beatsEvery: raw.beats?.everyMinutes ?? 0,
    silentStart: raw.beats?.silentHours?.[0] ?? 23,
    silentEnd: raw.beats?.silentHours?.[1] ?? 8,
    beatsGenerator: raw.beats?.generator ?? "model",
    dailyCap: raw.beats?.dailyCap ?? 6,
    material: raw.avatar?.material ?? "normal",
    team: raw.tools?.team?.name ?? "?",
    city: raw.tools?.weather?.defaultCity ?? "?",
    toolsEnabled: raw.tools?.enabled !== false,
  };
}
