#!/usr/bin/env node
/**
 * Benchmark local Ollama models for the Baldborg companion.
 *
 * Measures cold load, time to first token and generation speed with a
 * short in-character prompt, because those three decide whether the
 * avatar can answer without feeling laggy.
 *
 * Usage: node scripts/bench_ollama.mjs [model ...]
 */

const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["qwen3:4b-instruct-2507", "llama3.2:3b"];

const SYSTEM = [
  "You are Baldborg, a formally polite corporate AI assistant.",
  "Answer in 1-2 short sentences, in the language of the user.",
  "Never mention being a language model.",
].join(" ");

const CASES = [
  {
    name: "es-MX",
    prompt: "Llevo catorce horas despierto y todavía tengo trabajo. ¿Qué opinas?",
  },
  {
    name: "en",
    prompt: "I have been awake for fourteen hours and still have work left. Thoughts?",
  },
];

async function chat(model, messages) {
  const started = performance.now();
  const response = await fetch(`${HOST}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: { temperature: 0.8, num_ctx: 8192, num_predict: 180 },
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`${model}: HTTP ${response.status} ${await response.text()}`);
  }

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

  const total = performance.now() - started;
  const evalCount = final?.eval_count ?? 0;
  const evalMs = (final?.eval_duration ?? 0) / 1e6;

  return {
    ttft: firstToken ?? total,
    total,
    tokens: evalCount,
    tokPerSec: evalMs > 0 ? (evalCount / evalMs) * 1000 : 0,
    loadMs: (final?.load_duration ?? 0) / 1e6,
    text: text.trim().replace(/\s+/g, " "),
  };
}

function bar(value, limit = 30) {
  const filled = Math.min(limit, Math.round((value / limit) * limit));
  return `${"█".repeat(filled)}${"░".repeat(limit - filled)}`;
}

for (const model of MODELS) {
  console.log(`\n=== ${model} ===`);
  for (const testCase of CASES) {
    try {
      const result = await chat(model, [
        { role: "system", content: SYSTEM },
        { role: "user", content: testCase.prompt },
      ]);
      console.log(
        [
          `[${testCase.name}]`,
          `first token ${result.ttft.toFixed(0)} ms`,
          `total ${(result.total / 1000).toFixed(1)} s`,
          `${result.tokPerSec.toFixed(1)} tok/s`,
          result.loadMs > 50 ? `load ${(result.loadMs / 1000).toFixed(1)} s` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      console.log(`  ${bar(result.tokPerSec)}`);
      console.log(`  "${result.text}"`);
    } catch (error) {
      console.log(`[${testCase.name}] FAILED: ${error.message}`);
    }
  }
}
