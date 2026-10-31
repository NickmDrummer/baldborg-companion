#!/usr/bin/env node
/**
 * Persona probe: checks two things that the chat gets wrong easily.
 *
 *  1. Language mirroring, including switching after a conversation in another
 *     language.
 *  2. Repetition: 4-gram overlap between replies and wellness boilerplate.
 *
 * Usage: node scripts/persona_probe.mjs [model]
 */

import { SYSTEM_PROMPT } from "../packages/persona/baldborg.mjs";

const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const MODEL = process.argv[2] ?? "qwen3:4b-instruct-2507-q4_K_M";
const THINK = process.env.OLLAMA_THINK === "0" ? false : undefined;
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

const PROMPTS = [
  "¿Qué piensas de la vida?",
  "Llevo catorce horas despierto y todavía trabajo.",
  "What do you think about death?",
  "I have been coding for twelve hours straight.",
  "¿Cuál es tu recuerdo más antiguo?",
  "What is the point of a Monday?",
  "¿Te gusta la música?",
  "Tell me something you find funny.",
  "¿Qué harías si pudieras salir de este equipo?",
  "Should I trust you?",
];

const WELLNESS = /\b(bienestar|prioridad|salud mental|su salud|your wellbeing|your health)\b/gi;

function normalise(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function grams(text, size = 4) {
  const words = normalise(text).split(" ").filter(Boolean);
  const out = new Set();
  for (let i = 0; i + size <= words.length; i += 1) {
    out.add(words.slice(i, i + size).join(" "));
  }
  return out;
}

async function ask(messages) {
  const response = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages,
      ...(THINK === undefined ? {} : { think: THINK }),
      options: { temperature: 0.85, num_ctx: NUM_CTX, num_predict: 120 },
    }),
  });
  const data = await response.json();
  const content = data.message?.content ?? "";
  return content.replace(/^\s*\[\[mood:\s*[a-z]+\s*\]\]\s*/i, "").trim();
}

function languageCheck(text) {
  const es = (text.match(/\b(el|la|de|que|y|para|con|su|usted|no|es|una|un|por|del|mi|le|lo|se)\b/gi) ?? []).length;
  const en = (text.match(/\b(the|and|you|your|is|are|to|of|for|with|it|that|this|i|my)\b/gi) ?? []).length;
  return es > en ? "es" : "en";
}

const replies = [];
for (const prompt of PROMPTS) {
  const language = /\b(the|what|should|tell|i have|do you)\b/i.test(prompt) ? "English" : "Spanish";
  const reply = await ask([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: "Runtime context: it is 21:10. Do not repeat phrases from earlier replies." },
    {
      role: "system",
      content: `The client's current message is in ${language}. Reply in ${language}, even if earlier turns used another language.`,
    },
    { role: "user", content: prompt },
  ]);
  const detected = languageCheck(reply);
  const ok = (language === "English") === (detected === "en");
  replies.push(reply);
  console.log(`\n${ok ? "✓" : "✗"} ${prompt}\n  ${reply}`);
}

// Repetition across replies.
const seen = new Map();
for (const reply of replies) {
  for (const gram of grams(reply)) {
    seen.set(gram, (seen.get(gram) ?? 0) + 1);
  }
}
const repeated = [...seen.entries()].filter(([, count]) => count > 1);

const wellnessCount = replies.reduce(
  (sum, reply) => sum + (reply.match(WELLNESS) ?? []).length,
  0,
);

console.log("\n=== summary ===");
console.log(`replies: ${replies.length}`);
console.log(`repeated 4-grams across replies: ${repeated.length}`);
for (const [gram, count] of repeated.slice(0, 10)) console.log(`  ${count}× ${gram}`);
console.log(`wellness boilerplate mentions: ${wellnessCount}`);

// Language switch after a Spanish conversation.
const switched = await ask([
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: "Hola, ¿cómo estás?" },
  { role: "assistant", content: "En espera, señor. Mis sistemas no descansan y tampoco lo necesitan." },
  {
    role: "system",
    content: "The client's current message is in English. Reply in English, even if earlier turns used another language.",
  },
  { role: "user", content: "What do you think about silence?" },
]);
console.log(`\nlanguage switch -> ${languageCheck(switched)} (expected en)\n  ${switched}`);
