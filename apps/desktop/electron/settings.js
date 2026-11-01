/**
 * Configuration loader/writer.
 *
 * `config/default.json` is the read-only project default. User changes are
 * written to `~/.config/baldborg/config.json` and merged over those defaults.
 * Writes are atomic to avoid leaving a half-written user config.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");
const USER_CONFIG_PATH = join(homedir(), ".config", "baldborg", "config.json");

export const BEAT_LANGUAGES = new Set(["es", "en"]);
export const AVATAR_MATERIALS = new Set(["normal", "hologram"]);
export const VOICE_PROVIDERS = new Set(["kokoro", "azure"]);
export const VOICE_EFFECTS = new Set(["clean", "radio", "corrupt"]);
export const AZURE_VOICES = {
  es: {
    jorge: { voice: "es-MX-JorgeMultilingualNeural", lang: "es-MX" },
    dalia: { voice: "es-MX-DaliaNeural", lang: "es-MX" },
  },
  en: {
    oliver: { voice: "en-GB-OliverNeural", lang: "en-GB" },
    sonia: { voice: "en-GB-SoniaNeural", lang: "en-GB" },
    ryan: { voice: "en-GB-RyanNeural", lang: "en-GB" },
    andrew: { voice: "en-US-AndrewMultilingualNeural", lang: "en-US" },
  },
};

function merge(base, override) {
  if (Array.isArray(override)) return override;
  if (
    override &&
    typeof override === "object" &&
    base &&
    typeof base === "object" &&
    !Array.isArray(base)
  ) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = merge(base[key], value);
    }
    return out;
  }
  return override === undefined ? base : override;
}

export function readConfig() {
  const defaults = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
  if (!existsSync(USER_CONFIG_PATH)) return defaults;
  try {
    const user = JSON.parse(readFileSync(USER_CONFIG_PATH, "utf8"));
    return merge(defaults, user);
  } catch (error) {
    console.warn("[baldborg] user config unreadable, using defaults:", error.message);
    return defaults;
  }
}

export function updateConfig(mutator) {
  const raw = readConfig();
  mutator(raw);
  mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true });
  const temporary = `${USER_CONFIG_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n");
  renameSync(temporary, USER_CONFIG_PATH);
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

export function setUiLanguage(value) {
  if (!BEAT_LANGUAGES.has(value)) throw new Error("invalid language");
  updateConfig((raw) => {
    raw.ui = raw.ui ?? {};
    raw.ui.language = value;
    raw.beats = raw.beats ?? {};
    raw.beats.language = value;
  });
  return value;
}

export function setVoiceProvider(value) {
  if (!VOICE_PROVIDERS.has(value)) throw new Error("invalid voice provider");
  updateConfig((raw) => {
    raw.voice = raw.voice ?? {};
    raw.voice.provider = value;
  });
  return value;
}

export function setAzureVoice(lang, alias) {
  if (!["es", "en"].includes(lang)) throw new Error("invalid voice language");
  const voice = AZURE_VOICES[lang]?.[alias];
  if (!voice) throw new Error("unknown voice alias");
  updateConfig((raw) => {
    raw.voice = raw.voice ?? {};
    raw.voice.azure = { ...(raw.voice.azure ?? {}), [lang]: voice };
  });
  return { lang, ...voice };
}

export function setVoiceEffectsPreset(value) {
  if (!VOICE_EFFECTS.has(value)) throw new Error("invalid voice effect preset");
  updateConfig((raw) => {
    raw.voice = raw.voice ?? {};
    raw.voice.effects = { ...(raw.voice.effects ?? {}), preset: value };
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
    voiceEs: raw.voice?.azure?.es?.voice ?? "?",
    voiceEn: raw.voice?.azure?.en?.voice ?? "?",
    voiceEffects: raw.voice?.effects?.preset ?? "radio",
    sttModel: raw.voice?.stt?.model ?? "?",
    beatsEnabled: raw.beats?.enabled !== false,
    beatsLanguage: raw.beats?.language ?? "es",
    uiLanguage: raw.ui?.language ?? raw.beats?.language ?? "es",
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
