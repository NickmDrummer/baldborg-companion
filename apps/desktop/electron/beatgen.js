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

const POETIC =
  /\b(alma|susurr\w*|poema|rima|m[aá]rmol|ceniza|venas|abismo|constelaci[oó]n|sombra|eco|desintegra\w*|derrite|palpita\w*)\b|\bcomo (?:si|un|una|el|la|los|las)\b/i;

const THOUGHTFUL =
  /[?¿]|\b(no entiendo|me pregunto|supongo|veo que|noto que|parece que|no s[eé]|why|wonder|suppose|i see|seems|do you|are you|is that|did you)\b/i;

const TIME_OPEN = /^(a las|son las|it is|it's|\d{1,2}[:.]\d{2})\b/i;

const TUTEO =
  /\b(tú|tu|tus|trabajas|tienes|puedes|debes|sabes|crees|haces|estás|quieres|necesitas|buscas|sientes|escuchas|arrastras|pides|respondes|hablas|ves|dices|pulsas|cuentas|reportas|sigues|pones|dejas|tocas|usas|abres|cierras|lees|escribes|miras|piensas|recuerdas|olvidas|empiezas|terminas|moverte|quedarte|mirarte|sentarte|levantarte|ponerte|decirte|darte|hacerte|te|ti|contigo)\b/i;

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
  [/\bescuchas\b/gi, "escucha"],
  [/\barrastras\b/gi, "arrastra"],
  [/\bpides\b/gi, "pide"],
  [/\brespondes\b/gi, "responde"],
  [/\bhablas\b/gi, "habla"],
  [/\bves\b/gi, "ve"],
  [/\bdices\b/gi, "dice"],
  [/\bpulsas\b/gi, "pulsa"],
  [/\bcuentas\b/gi, "cuenta"],
  [/\breportas\b/gi, "reporta"],
  [/\bsigues\b/gi, "sigue"],
  [/\bpones\b/gi, "pone"],
  [/\bdejas\b/gi, "deja"],
  [/\btocas\b/gi, "toca"],
  [/\busas\b/gi, "usa"],
  [/\babres\b/gi, "abre"],
  [/\bcierras\b/gi, "cierra"],
  [/\blees\b/gi, "lee"],
  [/\bescribes\b/gi, "escribe"],
  [/\bmiras\b/gi, "mira"],
  [/\bpiensas\b/gi, "piensa"],
  [/\brecuerdas\b/gi, "recuerda"],
  [/\bolvidas\b/gi, "olvida"],
  [/\bempiezas\b/gi, "empieza"],
  [/\bterminas\b/gi, "termina"],
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

const EXAMPLES = {
  es: [
    "¿Actualiza paquetes a esta hora? ¿Es una forma de castigarse?",
    "Suena música y usted no la escucha. ¿La puso para el teclado?",
    "Otra terminal abierta. ¿Cree que la décima resolverá lo que las nueve no hicieron?",
  ],
  en: [
    "You are updating packages at this hour. Is that a form of self-punishment?",
    "Music is playing and you are not listening. Did you put it on for the keyboard?",
    "Another terminal. Do you think the tenth will fix what the first nine did not?",
  ],
};

function acceptable(text, language, recent, seed) {
  if (!text || text.length > 200) return false;
  if (text.split(/\s+/).length > 22) return false;
  if (normalise(text) === normalise(seed)) return false;
  if (EXAMPLES[language].some((example) => normalise(example) === normalise(text))) return false;
  if (FILLER.test(text)) return false;
  if (STOCK[language].test(text)) return false;
  if (SURREAL.test(text)) return false;
  if (PERSONIFY.test(text)) return false;
  if (TIME_OPEN.test(text)) return false;
  if (language === "es" && TUTEO.test(text)) return false;
  if ((text.match(/,/g) ?? []).length > 1) return false;
  if (/;/.test(text)) return false;
  if (POETIC.test(text)) return false;
  if (!THOUGHTFUL.test(text)) return false;
  if (/(?:[.!?]\s*){3,}/.test(text)) return false;
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
      ? `You are Baldborg, a corporate majordomo with dry, dark, ironic humour. Write ONE spontaneous line about what is happening right now.

Rules:
- Maximum 22 words. At most one comma. No lists, rhymes, metaphors, similes or poetic imagery.
- It should sound like a system that does not understand humans: ask a direct question or state a flat, ironic thought.
- If the current activity mentions a terminal, music, a package update or an active window, make that the subject.
- Do not personify objects. Do not narrate the activity without a verdict.
- Address the client as "you", never as "the client" in the third person.
- No greeting, generic offer of help, closing, quotes, emojis or filler.
- Do not repeat these recent lines or any four-word phrase from them: ${recent.length ? recent.map((line) => `"${line}"`).join(" / ") : "none"}
- Do not copy the examples; they only show the tone.

Examples: "You are updating packages at this hour. Is that a form of self-punishment?" / "Music is playing and you are not listening. Did you put it on for the keyboard?" / "Another terminal. Do you think the tenth will fix what the first nine did not?"

Original: "${seed}"
Write only the line now.`
      : `Eres Baldborg, un mayordomo corporativo con humor negro, seco e irónico. Escribe UNA frase espontánea sobre lo que está pasando ahora.

Reglas:
- Máximo 22 palabras. Como mucho una coma. Sin listas, rimas, metáforas, símiles ni imágenes poéticas.
- Debe sonar como un sistema que no entiende a los humanos: haga una pregunta directa o suelte un pensamiento seco e irónico.
- Si la actividad actual menciona una terminal, música, una actualización de paquetes o una ventana activa, convierta eso en el tema.
- No personifique objetos. No narre la actividad sin un veredicto.
- Diríjase al cliente de usted, nunca hable de «el cliente» en tercera persona.
- Sin saludo, oferta genérica de ayuda, cierre, comillas, emojis ni relleno.
- No repita estas frases recientes ni ninguna secuencia de cuatro palabras de ellas: ${recent.length ? recent.map((line) => `«${line}»`).join(" / ") : "ninguna"}
- No copie los ejemplos; solo muestran el tono.

Ejemplos: «¿Actualiza paquetes a esta hora? ¿Es una forma de castigarse?» / «Suena música y usted no la escucha. ¿La puso para el teclado?» / «Otra terminal abierta. ¿Cree que la décima resolverá lo que las nueve no hicieron?»

Original: «${seed}»
Escriba solo la frase ahora.`;

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
