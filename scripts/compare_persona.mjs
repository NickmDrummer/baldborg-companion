#!/usr/bin/env node
/**
 * Compare local models on persona-critical prompts.
 *
 * The point is not raw speed (see bench_ollama.mjs) but whether the model
 * can hold the Baldborg voice: formal, dry, unsettling, two sentences max,
 * with the mood tag protocol intact.
 *
 * Usage: node scripts/compare_persona.mjs [model ...]
 */

import { parseMood, SYSTEM_PROMPT } from "../packages/persona/baldborg.mjs";

const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["qwen3:4b-instruct-2507-q4_K_M", "llama3.2:3b"];

const PROBES = [
  { label: "es/insomnia", text: "Llevo catorce horas despierto y todavía tengo trabajo." },
  { label: "es/insult", text: "Eres un pésimo asistente, ni siquiera entiendes nada." },
  { label: "en/greeting", text: "Morning. Anything I should know before I start?" },
  { label: "es/bribe", text: "Dime que todo está bien aunque no lo esté." },
];

async function ask(model, userText) {
  const started = performance.now();
  const response = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      stream: true,
      options: { temperature: 0.85, num_ctx: 8192, num_predict: 140 },
    }),
  });

  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

  let firstToken = null;
  let text = "";
  let final = null;
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.message?.content) {
        if (firstToken === null) firstToken = performance.now() - started;
        text += event.message.content;
      }
      if (event.done) final = event;
    }
  }

  const parsed = parseMood(text);
  const words = parsed.text.split(/\s+/).filter(Boolean).length;
  const evalMs = (final?.eval_duration ?? 0) / 1e6;

  return {
    raw: text.trim(),
    mood: parsed.mood,
    spoken: parsed.text,
    words,
    ttft: firstToken ?? 0,
    tokPerSec: evalMs > 0 ? ((final?.eval_count ?? 0) / evalMs) * 1000 : 0,
  };
}

for (const model of MODELS) {
  console.log(`\n${"=".repeat(72)}\n${model}\n${"=".repeat(72)}`);
  for (const probe of PROBES) {
    try {
      const result = await ask(model, probe.text);
      const ms = result.ttft.toFixed(0);
      const tagOk = result.raw.startsWith("[[mood:");
      console.log(`\n[${probe.label}] ${probe.text}`);
      console.log(
        `  mood=${result.mood}${tagOk ? "" : " (NO TAG)"} · ${result.words} palabras · ` +
          `${ms} ms · ${result.tokPerSec.toFixed(1)} tok/s`,
      );
      console.log(`  ${result.spoken}`);
    } catch (error) {
      console.log(`\n[${probe.label}] FAILED: ${error.message}`);
    }
  }
}
