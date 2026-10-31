/**
 * Long-term facts about the client.
 *
 * Stored separately from the conversation history so `/clean-history` does not
 * erase them. Facts are normalized to a small key-value list, capped to avoid
 * prompt bloat, and never used to store credentials.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".config", "baldborg");
const PROFILE_FILE = join(STATE_DIR, "profile.json");
const MAX_FACTS = 50;
const MAX_RELEVANT = 10;

const SENSITIVE =
  /\b(password|passwd|secret|token|api.?key|tarjeta|credit|ssn|dni|clave)\b/i;

function normaliseText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseKey(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function loadFacts() {
  try {
    const data = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
    return Array.isArray(data.facts) ? data.facts : [];
  } catch {
    return [];
  }
}

function saveFacts(facts) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PROFILE_FILE, JSON.stringify({ facts }, null, 2) + "\n");
  try {
    chmodSync(PROFILE_FILE, 0o600);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
}

/** Parse "/remember key = value" (also accepts a colon). */
export function parseFact(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { error: "Uso: /remember clave = valor" };

  const match = text.match(/^(.{1,40}?)\s*[=:]\s*(.{1,300})$/s);
  if (!match) return { error: "Uso: /remember clave = valor" };

  const key = normaliseKey(match[1]);
  const value = match[2].replace(/\s+/g, " ").trim();
  if (!key) return { error: "La clave no puede estar vacía." };
  if (!value) return { error: "El valor no puede estar vacío." };
  if (SENSITIVE.test(key)) {
    return { error: "No guardo contraseñas, claves ni datos de pago." };
  }
  if (/^[A-Za-z0-9+/=_-]{24,}$/.test(value)) {
    return { error: "Ese valor parece una credencial; no lo guardo." };
  }
  return { key, value };
}

export function rememberFact(key, value) {
  const facts = loadFacts();
  const now = new Date().toISOString();
  const index = facts.findIndex((fact) => fact.key === key);
  if (index >= 0) {
    facts[index] = { ...facts[index], value, updated: now };
  } else {
    if (facts.length >= MAX_FACTS) {
      throw new Error(`la memoria ya tiene ${MAX_FACTS} hechos; borra alguno primero`);
    }
    facts.push({ key, value, created: now, updated: now });
  }
  saveFacts(facts);
  return facts.find((fact) => fact.key === key);
}

export function forgetFact(key) {
  const facts = loadFacts();
  const remaining = facts.filter((fact) => fact.key !== key);
  if (remaining.length === facts.length) return false;
  saveFacts(remaining);
  return true;
}

export function listFacts() {
  return loadFacts().sort((a, b) => a.key.localeCompare(b.key));
}

export function memoryCount() {
  return loadFacts().length;
}

/** Facts relevant to this message, plus recent ones, capped for the prompt. */
export function relevantFacts(text) {
  const facts = loadFacts();
  if (!facts.length) return [];
  if (facts.length <= MAX_RELEVANT) return facts;

  const words = new Set(normaliseText(text).split(" ").filter((word) => word.length >= 3));
  const scored = facts.map((fact) => {
    const haystack = normaliseText(`${fact.key} ${fact.value}`);
    let score = 0;
    for (const word of words) {
      if (haystack.includes(word)) score += 2;
    }
    return { fact, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || String(b.fact.updated).localeCompare(String(a.fact.updated)))
    .slice(0, MAX_RELEVANT)
    .map((entry) => entry.fact);
}

export function memoryBlock(text) {
  const facts = relevantFacts(text);
  if (!facts.length) return "";
  const lines = facts.map((fact) => `- ${fact.key}: ${fact.value}`);
  return (
    "Known facts about the client, stored locally. Use them when relevant, but " +
    "do not recite this list and do not invent facts that are not here. If the " +
    "client contradicts one, use the new information and offer to update it.\n" +
    lines.join("\n")
  );
}
