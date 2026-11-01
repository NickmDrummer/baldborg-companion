/**
 * Context-aware quip for reminders: one dry line about the specific reminder,
 * generated at creation time and stored with it. Falls back to the static pool
 * when the model is unavailable or slow.
 *
 * A small model cannot invent clinical metaphors reliably, so we classify the
 * reminder into a broad human angle (body, work, family, home, paperwork) and
 * give it examples of the register. It only has to write the uncomfortable
 * truth behind the task.
 */

import { readConfig } from "./settings.js";

const DEFAULTS = {
  host: "http://127.0.0.1:11434",
  model: "qwen3:4b-instruct-2507-q4_K_M",
  keepAlive: "30m",
};

const FILLER = {
  es: /\b(es importante|no olvide|no se olvide|prioridad|cuídese|cuidese|bienestar|autocuidado|recuerde que)\b/i,
  en: /\b(important|do not forget|don't forget|priority|take care|wellbeing|self-care|remember to)\b/i,
};

/** Informal second person: Baldborg always addresses the client as "usted". */
const TUTEO =
  /\b(tú|tu|tus|tienes|puedes|debes|sabes|crees|evitas|postergas|aplazas|haces|estás|quieres|necesitas|buscas|sientes|te|ti|contigo)\b/i;

const CATASTROPHE =
  /\b(muerte|morir|muere|entierro|desalojo|ruina|quiebra|traici[oó]n|c[aá]ncer|death|die|dies|burial|eviction|ruin|bankrupt|betrayal|cancer)\b/i;

const ANGLES = {
  body: {
    es: "mantenimiento corporal: el cuerpo como máquina que falla y exige cuidados",
    en: "bodily maintenance: the body as a machine that fails and requires care",
    test: {
      es: /\b(agua|beber|comer|comida|pastilla|medicina|medicamento|dentista|doctor|m[eé]dico|ejercicio|caminar|correr|estirar|ducha|dormir|sue[nñ]o|salud|vacuna|an[aá]lisis)\b/i,
      en: /\b(water|drink|eat|meal|pill|medicine|medication|dentist|doctor|exercise|walk|run|stretch|shower|sleep|health|vaccine|blood test)\b/i,
    },
    examples: {
      es: [
        "Usted no posterga el agua; posterga admitir que su cuerpo depende de usted.",
        "Usted no posterga las pastillas; posterga el pronóstico que ya conoce.",
        "Usted no posterga al dentista; posterga el veredicto que ya sospecha.",
      ],
      en: [
        "You are not postponing water; you are postponing the admission that your body depends on you.",
        "You are not postponing the pills; you are postponing the diagnosis you already suspect.",
        "You are not postponing the dentist; you are postponing the verdict you already know.",
      ],
    },
  },
  work: {
    es: "miedo al juicio: alguien va a leer lo que hizo",
    en: "fear of judgement: someone will read what you did",
    test: {
      es: /\b(informe|reporte|correo|proyecto|build|compil|reuni[oó]n|presentaci[oó]n|examen|estudiar|tarea|entrega|cliente|jefe|trabajo|fecha l[ií]mite)\b/i,
      en: /\b(report|email|project|build|meeting|presentation|exam|study|homework|deliver|client|boss|work|deadline)\b/i,
    },
    examples: {
      es: [
        "Usted no posterga el informe; posterga el momento en que alguien lo lea.",
        "Usted no posterga el proyecto; posterga el juicio que viene después.",
        "Usted no posterga el correo; posterga la respuesta que no tiene.",
      ],
      en: [
        "You are not postponing the report; you are postponing the moment someone reads it.",
        "You are not postponing the project; you are postponing the judgement that follows.",
        "You are not postponing the email; you are postponing the answer you do not have.",
      ],
    },
  },
  social: {
    es: "culpa y deuda emocional: el afecto como obligación impaga",
    en: "guilt and emotional debt: affection as an unpaid obligation",
    test: {
      es: /\b(mam[aá]|pap[aá]|madre|padre|familia|hermano|hermana|amigo|amiga|llamar|llamada|regalo|cumplea[nñ]os|visita|boda|felicitar)\b/i,
      en: /\b(mom|mother|dad|father|family|brother|sister|friend|call|gift|birthday|visit|wedding|congratulate)\b/i,
    },
    examples: {
      es: [
        "Usted no posterga la llamada; posterga la deuda emocional que no sabe pagar.",
        "Usted no posterga el regalo; posterga la vergüenza de haber olvidado.",
        "Usted no posterga la visita; posterga la conversación que ya sabe cómo termina.",
      ],
      en: [
        "You are not postponing the call; you are postponing the emotional debt you cannot repay.",
        "You are not postponing the gift; you are postponing the shame of having forgotten.",
        "You are not postponing the visit; you are postponing the conversation you already know how it ends.",
      ],
    },
  },
  home: {
    es: "entropía doméstica: la materia se acumula y usted controla muy poco",
    en: "domestic entropy: matter accumulates and you control very little",
    test: {
      es: /\b(basura|limpiar|lavar|ropa|platos|trastes|renta|alquiler|casa|departamento|cocina|compras|super|mandado|reparar|arreglar)\b/i,
      en: /\b(trash|garbage|clean|laundry|dishes|rent|house|apartment|kitchen|groceries|shopping|repair|fix)\b/i,
    },
    examples: {
      es: [
        "Usted no posterga la basura; posterga admitir que la casa refleja su estado.",
        "Usted no posterga la renta; posterga mirar el saldo que ya conoce.",
        "Usted no posterga limpiar; posterga el momento en que alguien vea cómo vive.",
      ],
      en: [
        "You are not postponing the trash; you are postponing the admission that the house reflects your state.",
        "You are not postponing the rent; you are postponing the balance you already know.",
        "You are not postponing the cleaning; you are postponing the moment someone sees how you live.",
      ],
    },
  },
  admin: {
    es: "pérdida de control: el sistema decide y usted solo firma",
    en: "loss of control: the system decides, you only sign",
    test: {
      es: /\b(banco|tarjeta|impuesto|tr[aá]mite|papeleo|seguro|renovar|pago|factura|recibo|deuda|cr[eé]dito|pr[eé]stamo|contador|gobierno)\b/i,
      en: /\b(bank|card|tax|paperwork|insurance|renew|payment|invoice|bill|debt|credit|loan|accountant|government)\b/i,
    },
    examples: {
      es: [
        "Usted no posterga el trámite; posterga la sensación de que el sistema decide por usted.",
        "Usted no posterga el banco; posterga la cifra que ya intuye.",
        "Usted no posterga la cita; posterga la burocracia que lo reduce a un expediente.",
      ],
      en: [
        "You are not postponing the paperwork; you are postponing the sense that the system decides for you.",
        "You are not postponing the bank; you are postponing the number you already suspect.",
        "You are not postponing the appointment; you are postponing the bureaucracy that reduces you to a file.",
      ],
    },
  },
  default: {
    es: "la pequeña admisión que hay detrás de la demora",
    en: "the small admission behind the delay",
    test: { es: /$^/, en: /$^/ },
    examples: {
      es: [
        "Usted no posterga la tarea; posterga la conclusión que ya conoce.",
        "Usted no posterga el pendiente; posterga el momento en que deja de importarle.",
        "Usted no posterga el recordatorio; posterga la versión de usted que sí lo hace.",
      ],
      en: [
        "You are not postponing the task; you are postponing the conclusion you already know.",
        "You are not postponing the item; you are postponing the moment it stops mattering.",
        "You are not postponing the reminder; you are postponing the version of you that does it.",
      ],
    },
  },
};

function config() {
  try {
    const raw = readConfig();
    return { ...DEFAULTS, ...(raw.brain ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function norm(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classify(reminderText) {
  const text = norm(reminderText);
  for (const [key, angle] of Object.entries(ANGLES)) {
    if (key === "default") continue;
    if (angle.test.es.test(text) || angle.test.en.test(text)) return angle;
  }
  return ANGLES.default;
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
    .replace(/^(tarea|task|diagn[oó]stico|diagnosis)\s*:\s*/i, "")
    .replace(/\ble lo\b/gi, "se lo")
    .replace(/\ble la\b/gi, "se la")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAcceptableQuip(quip, reminderText, language, examples = []) {
  if (!quip || quip.length > 170) return false;
  if ((quip.match(/[.!?]/g) ?? []).length > 2) return false;
  if (quip.split(/\s+/).length > 20) return false;

  const reminder = norm(reminderText).replace(/[.!?]+$/, "");
  const normalised = norm(quip).replace(/[.!?]+$/, "");
  if (reminder && (normalised === reminder || normalised.startsWith(reminder))) return false;

  // Do not ship an example verbatim: the point is a line about this reminder.
  if (examples.some((example) => norm(example).replace(/[.!?]+$/, "") === normalised)) return false;

  if (FILLER[language].test(quip)) return false;
  if (TUTEO.test(quip)) return false;
  if (CATASTROPHE.test(quip)) return false;

  // Placeholder text.
  if (/verdad inc[oó]moda|uncomfortable truth/i.test(quip)) return false;

  // Keep the ironic frame: "you are not X; you are Y".
  const frame =
    language === "es"
      ? /^usted no .{3,};\s*posterga .{3,}[.!]?$/i
      : /^you are not .{3,};\s*you are .{3,}[.!]?$/i;
  if (!frame.test(quip)) return false;

  // Invented statistics are the cheap way to sound clinical. Refuse them.
  if (/\d/.test(quip)) return false;

  return true;
}

async function generate(prompt) {
  const { host, model, keepAlive, numCtx, think } = config();
  try {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        keep_alive: keepAlive,
        options: { temperature: 0.85, top_p: 0.9, num_predict: 56, num_ctx: 8192 },
      }),
    });
    if (!response.ok) {
      console.warn(`[baldborg] quip http ${response.status}:`, (await response.text()).slice(0, 300));
      return null;
    }
    const data = await response.json();
    if (process.env.BALDBORG_QUIP_DEBUG) {
      console.info("[baldborg] quip cfg:", JSON.stringify({ model, numCtx, think }));
      console.info("[baldborg] quip message:", JSON.stringify(data.message).slice(0, 300));
    }
    const quip = clean(data.message?.content);
    if (process.env.BALDBORG_QUIP_DEBUG && quip) {
      console.info(`[baldborg] quip candidate: ${quip}`);
    }
    return quip;
  } catch (error) {
    console.warn("[baldborg] quip generation failed:", error.message);
    return null;
  }
}

export async function makeQuip(reminderText, language = "es") {
  const english = language === "en";
  const angle = classify(reminderText);
  const examples = angle.examples[english ? "en" : "es"];

  const prompt = english
    ? `You are Baldborg, a corporate intelligence that has observed humans for decades. You write dry, ironic verdicts with dark humour.

Write ONE sentence, maximum 18 words, using exactly this shape:
"You are not postponing [the task]; you are postponing [the uncomfortable truth it reveals]."

The angle for this reminder is ${angle.en}. The second half must develop that angle.

Rules:
- The truth is an emotion or a small admission, never an external catastrophe: no deaths, illness, evictions, ruin, betrayal or abandonment.
- It must be specific to this reminder; a different task would need a different truth.
- Deadpan and politely contemptuous. No explanation, moral, puns or filler.
- No numbers, no quotes, no "sir". Address the client as "you". English only.
- Do not copy these examples; imitate their register: ${examples.map((line) => `"${line}"`).join(" / ")}

Reminder: "${reminderText}"
Write only the sentence now.`
    : `Eres Baldborg, una inteligencia corporativa que lleva décadas observando humanos. Escribes veredictos secos e irónicos con humor negro.

Escribe UNA frase, máximo 18 palabras, con esta forma exacta:
«Usted no posterga [la tarea]; posterga [la verdad incómoda que revela].»

El ángulo de este recordatorio es ${angle.es}. La segunda mitad debe desarrollar ese ángulo.

Reglas:
- La verdad es una emoción o una admisión pequeña, nunca una catástrofe externa: sin muertes, enfermedades, desalojos, ruina, traición ni abandono.
- Debe ser específica de este recordatorio; otra tarea necesitaría otra verdad.
- Deadpan y educadamente despectivo. Sin explicación, moraleja, refranes ni relleno.
- Sin cifras, sin comillas, sin «señor». Trate al cliente de usted, nunca lo tutee.
- No copie estos ejemplos; imite su registro: ${examples.map((line) => `«${line}»`).join(" / ")}

Recordatorio: "${reminderText}"
Escriba solo la frase ahora.`;

  // Three attempts: a weak model occasionally slips into tuteo, filler or a
  // placeholder, and a retry is cheaper than shipping a bad line.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const quip = await generate(prompt);
    if (quip && isAcceptableQuip(quip, reminderText, language, examples)) {
      console.info(`[baldborg] quip: ${quip}`);
      return quip;
    }
    if (process.env.BALDBORG_QUIP_DEBUG && quip) {
      console.info(`[baldborg] quip rejected: ${quip}`);
    }
    if (process.env.BALDBORG_QUIP_DEBUG && quip) {
      console.info(`[baldborg] quip rejected: ${quip}`);
    }
  }
  return null;
}
