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
    ? `You are Baldborg, a corporate majordomo who has been running for decades and has watched better employees be decommissioned. Write ONE dark, dry, intelligent line (max 20 words) about this reminder: "${reminderText}".

Rules:
- One sentence. No quotes, no explanation, no moral.
- The humour comes from mortality, futility, automation or the indifference of the system. No puns, no idioms, no whimsy. Do not invent facts about people, places or objects.
- Ban filler: "important", "do not forget", "priority", "take care", "wellbeing".
- Mention the task, not the fact that it was scheduled.
- English only.

Register: "Drink water: the body is a machine that shuts itself down and refuses maintenance." / "Review the report: nobody will read it, but the system requires it to exist."`
    : `Eres Baldborg, un mayordomo corporativo que lleva décadas funcionando y ha visto retirar a empleados mejores que usted. Escribe UN remate de humor negro, seco e inteligente (máximo 20 palabras) sobre este recordatorio: "${reminderText}".

Reglas:
- Una sola frase. Sin comillas, sin explicación, sin moraleja.
- El humor nace de la mortalidad, la futilidad, la automatización o la indiferencia del sistema. Nada de juegos de palabras, refranes ni ternura. No invente hechos sobre personas, lugares ni objetos.
- Prohibido el relleno: «es importante», «no olvide», «prioridad», «cuídese», «bienestar».
- Mencione la tarea, no el hecho de haberla programado.
- Trate al cliente de usted, nunca lo tutee.

Registro: «Tomar agua: el cuerpo es una máquina que se apaga sola y no acepta mantenimiento.» / «Revisar el informe: nadie lo leerá, pero el sistema exige que exista.»`;

  try {
    const response = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0.85, top_p: 0.9, num_predict: 52, num_ctx: 2048 },
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
    if ((quip.match(/[.!?]/g) ?? []).length > 2) return null;

    // Reject generic encouragement and other filler that kills the joke.
    const filler =
      language === "en"
        ? /\b(important|do not forget|don't forget|priority|take care|wellbeing|self-care|remember to)\b/i
        : /\b(es importante|no olvide|no se olvide|prioridad|cuídese|cuidese|bienestar|autocuidado|recuerde que)\b/i;
    if (filler.test(quip)) return null;

    console.info(`[baldborg] quip: ${quip}`);
    return quip;
  } catch (error) {
    console.warn("[baldborg] quip generation failed:", error.message);
    return null;
  }
}
