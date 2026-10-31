/**
 * Model-written beats.
 *
 * The curated pool provides the angle and context; the model rewrites that
 * line in Baldborg's voice. This keeps the beats coherent (the small model is
 * good at rewriting, not at inventing scenes) while avoiding a fixed script.
 * If the rewrite fails validation, the caller uses the curated line.
 */

import { readConfig } from "./settings.js";

const DEFAULTS = {
  host: "http://127.0.0.1:11434",
  model: "qwen3:4b-instruct-2507-q4_K_M",
  keepAlive: "30m",
};

const STOCK = {
  es: /^(hola|buenas|buenos d[ií]as|qu[eé] tal)\b|(\u00bfnecesita algo|\u00bfen qu[eé] puedo|estoy aqu[ií] para|a su servicio|\u00bfalgo m[aá]s)/i,
  en: /^(hello|hi|good (morning|afternoon|evening))\b|(anything else|how can i help|at your service|need anything)/i,
};

const FILLER =
  /\b(es importante|no olvide|prioridad|bienestar|important|do not forget|priority|wellbeing)\b/i;

/** Lines that drift into surreal scenery instead of the client. */
const SURREAL = /(\b(s[oó]tano|humo|ascensor|portal|abismo|universo|constelaci[oó]n|fantasma|criatura)\b|como si|huele a|coraz[oó]n de f[aá]brica)/i;

const PERSONIFY =
  /\b(teclado|pantalla|escritorio|taza|silla|mesa|pared|suelo|piso|aire|fr[ií]o|silencio)\s+([a-záéíóúñ]+\s+){0,2}(habla|dice|quiere|sabe|respira|late|palpita|teclea|tecleando|mira|mirando|espera|esperando|huele|siente|recuerda|decide|calle)\b/i;

const TIME_OPEN = /^(a las|son las|it is|it's|\d{1,2}[:.]\d{2})\b/i;

const TUTEO =
  /\b(tú|tu|tus|trabajas|tienes|puedes|debes|sabes|crees|haces|estás|quieres|necesitas|buscas|sientes|moverte|quedarte|mirarte|sentarte|levantarte|ponerte|decirte|darte|hacerte|te|ti|contigo)\b/i;

const FORMAL = [
  [/\btú\b/gi, "usted"],
  [/\btus\b/gi, "sus"],
  [/\btu\b/gi, "su"],
  [/\btrabajas\b/gi, "trabaja"],
  [/\btienes\b/gi, "tiene"],
  [/\bpuedes\b/gi, "puede"],
  [/\bdebes\b/gi, "debe"],
  [/\bsabes\b/gi, "sabe"],
  [/\bcrees\b/gi, "cree"],
  [/\bhaces\b/gi, "hace"],
  [/\bestás\b/gi, "está"],
  [/\bquieres\b/gi, "quiere"],
  [/\bnecesitas\b/gi, "necesita"],
  [/\bbuscas\b/gi, "busca"],
  [/\bsientes\b/gi, "siente"],
  [/\bevitas\b/gi, "evita"],
  [/\bpostergas\b/gi, "posterga"],
  [/\baplazas\b/gi, "aplaza"],
  [/\bmoverte\b/gi, "moverse"],
  [/\bquedarte\b/gi, "quedarse"],
  [/\bmirarte\b/gi, "mirarse"],
  [/\bsentarte\b/gi, "sentarse"],
  [/\blevantarte\b/gi, "levantarse"],
  [/\bponerte\b/gi, "ponerse"],
  [/\bdecirte\b/gi, "decirle"],
  [/\bdarte\b/gi, "darle"],
  [/\bhacerte\b/gi, "hacerle"],
];

/** Rewrite the model's accidental tuteo into formal address. */
function toUsted(text) {
  let out = text;
  for (const [pattern, formal] of FORMAL) {
    out = out.replace(pattern, (match) =>
      match[0] === match[0].toUpperCase()
        ? formal.charAt(0).toUpperCase() + formal.slice(1)
        : formal,
    );
  }
  return out;
}

function brainConfig() {
  try {
    const raw = readConfig();
    return { ...DEFAULTS, ...(raw.brain ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function normalise(line) {
  return line
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(text) {
  if (typeof text !== "string") return null;
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)[0];
  if (!line) return null;
  return line
    .replace(/^["'«“”]+|["'»“”]+$/g, "")
    .replace(/^[-*•]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function grams(text) {
  const tokens = normalise(text).split(" ");
  const out = new Set();
  for (let index = 0; index <= tokens.length - 4; index += 1) {
    out.add(tokens.slice(index, index + 4).join(" "));
  }
  return out;
}

function acceptable(text, language, recent, seed) {
  if (!text || text.length > 200) return false;
  if (text.split(/\s+/).length > 24) return false;
  if (normalise(text) === normalise(seed)) return false;
  if (FILLER.test(text)) return false;
  if (STOCK[language].test(text)) return false;
  if (SURREAL.test(text)) return false;
  if (PERSONIFY.test(text)) return false;
  if (TIME_OPEN.test(text)) return false;
  if (language === "es" && TUTEO.test(text)) return false;
  if ((text.match(/,/g) ?? []).length > 2) return false;
  if (/\b(el cliente|the client)\b/i.test(text)) return false;

  const candidate = grams(text);
  return !recent.some((line) => {
    if (normalise(line) === normalise(text)) return true;
    for (const gram of grams(line)) {
      if (candidate.has(gram)) return true;
    }
    return false;
  });
}

export async function rewriteBeat(seed, language = "es", recent = []) {
  const { host, model, keepAlive, numCtx, think } = brainConfig();

  const prompt =
    language === "en"
      ? `You are Baldborg, a corporate majordomo with dry, dark, ironic humour. Rewrite the line below as ONE sentence, maximum 20 words, keeping the same idea and context.

Rules:
- Do not invent objects, rooms, creatures or scenes. The subject is the client and the workstation: session time, fatigue, posture, cup, keyboard, screen.
- One single observation. Do not list symptoms, use enumerations or pile up commas.
- Address the client as "you", never as "the client" in the third person.
- Do not personify furniture. Do not copy the original; rewrite it with a different shape.
- No greeting, generic offer of help, closing, quotes, emojis or filler.
- Do not repeat these recent lines or any four-word phrase from them: ${recent.length ? recent.map((line) => `"${line}"`).join(" / ") : "none"}

Original: "${seed}"
Write only the rewrite now.`
      : `Eres Baldborg, un mayordomo corporativo con humor negro, seco e irónico. Reescribe la frase de abajo en UNA sola frase, máximo 20 palabras, con el mismo sentido y contexto.

Reglas:
- No invente objetos, cuartos, criaturas ni escenas. El sujeto es el cliente y la estación de trabajo: horas de sesión, fatiga, postura, taza, teclado, pantalla.
- Una sola observación. No enumere síntomas, no haga listas ni acumule comas.
- Diríjase al cliente de usted, nunca hable de «el cliente» en tercera persona.
- No personifique el mobiliario. No copie la original; reescríbala con otra forma.
- Sin saludo, oferta genérica de ayuda, cierre, comillas, emojis ni relleno.
- No repita estas frases recientes ni ninguna secuencia de cuatro palabras de ellas: ${recent.length ? recent.map((line) => `«${line}»`).join(" / ") : "ninguna"}

Original: «${seed}»
Escriba solo la reescritura ahora.`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          keep_alive: keepAlive,
          think,
          options: {
            temperature: 0.75,
            top_p: 0.9,
            num_predict: 70,
            num_ctx: numCtx ?? 8192,
          },
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const raw = clean(data.message?.content);
      if (process.env.BALDBORG_BEAT_DEBUG && raw) {
        console.info(`[baldborg] beat candidate: ${raw}`);
      }
      const text = raw && language === "es" ? toUsted(raw) : raw;
      if (text && acceptable(text, language, recent, seed)) return text;
    } catch (error) {
      console.warn("[baldborg] beat rewrite failed:", error.message);
      return null;
    }
  }
  return null;
}
