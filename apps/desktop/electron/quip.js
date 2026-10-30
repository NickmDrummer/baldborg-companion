/**
 * Context-aware quip for reminders: one dry line about the specific reminder,
 * generated at creation time and stored with it. Falls back to the static pool
 * when the model is unavailable or slow.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");

const DEFAULTS = {
  host: "http://127.0.0.1:11434",
  model: "qwen3:4b-instruct-2507-q4_K_M",
  keepAlive: "30m",
};

function config() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULTS, ...(raw.brain ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function clean(text) {
  if (typeof text !== "string") return null;
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)[0];
  if (!line) return null;
  const cleaned = line
    .replace(/^["'«“”]+|["'»“”]+$/g, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 140) return null;
  return cleaned;
}

export async function makeQuip(reminderText, language = "es") {
  const { host, model, keepAlive } = config();
  const english = language === "en";

  const prompt = english
    ? `You are Baldborg, a corporate majordomo with dry humour. Write ONE short witty line (max 18 words) about this reminder: "${reminderText}". Deadpan, like an observation from someone who has been running for decades. No quotes, no explanation, English only. Examples: "Review the report: the document will not review itself, and I have no hands." / "Drink water: your body is a system that complains in writing."`
    : `Eres Baldborg, un mayordomo corporativo con humor seco. Escribe UNA frase breve y ocurrente (máximo 18 palabras) sobre este recordatorio: "${reminderText}". Deadpan, como la observación de alguien que lleva décadas funcionando. Sin comillas, sin explicación, en español. Dirígete al cliente de "usted", nunca lo tutees. Ejemplos: "Revisar el informe: el documento no se revisa solo, y yo no tengo manos." / "Tomar agua: su cuerpo es un sistema que protesta por escrito."`;

  try {
    const response = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(9_000),
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0.95, num_predict: 48, num_ctx: 2048 },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const quip = clean(data.response);
    if (!quip) return null;

    // Reject a quip that is just the reminder restated, but allow it to
    // mention the topic: that is the point.
    const normalisedReminder = reminderText.toLowerCase().replace(/[.!?]+$/, "").trim();
    const normalisedQuip = quip.toLowerCase().replace(/[.!?]+$/, "").trim();
    if (normalisedReminder && normalisedQuip === normalisedReminder) return null;
    if ((quip.match(/[.!?]/g) ?? []).length > 3) return null;

    console.info(`[baldborg] quip: ${quip}`);
    return quip;
  } catch (error) {
    console.warn("[baldborg] quip generation failed:", error.message);
    return null;
  }
}
