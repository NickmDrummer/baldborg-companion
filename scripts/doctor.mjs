#!/usr/bin/env node
/**
 * Baldborg doctor: read-only health check.
 *
 * Verifies the pieces that broke in the past (Ollama backend, model presence,
 * voice sidecar, STT, microphone, control socket and Hyprland integration) and
 * prints an actionable summary. It never starts, loads or modifies anything.
 *
 * Usage: bin/baldborg doctor
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, statfsSync } from "node:fs";
import { connect } from "node:net";
import { freemem, homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig } from "../apps/desktop/electron/settings.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(REPO_ROOT, "config", "default.json");
const USER_CONFIG_PATH = join(homedir(), ".config", "baldborg", "config.json");
const STATE_DIR = join(homedir(), ".config", "baldborg");
const CONTROL_SOCKET = join(STATE_DIR, "control.sock");
const VOICE_FILE = join(STATE_DIR, "voice.json");

const colors = process.stdout.isTTY
  ? {
      green: (text) => `\x1b[32m${text}\x1b[0m`,
      yellow: (text) => `\x1b[33m${text}\x1b[0m`,
      red: (text) => `\x1b[31m${text}\x1b[0m`,
      dim: (text) => `\x1b[2m${text}\x1b[0m`,
      bold: (text) => `\x1b[1m${text}\x1b[0m`,
    }
  : {
      green: (text) => text,
      yellow: (text) => text,
      red: (text) => text,
      dim: (text) => text,
      bold: (text) => text,
    };

let okCount = 0;
let warnCount = 0;
let failCount = 0;

function ok(label, detail = "") {
  okCount += 1;
  console.log(`${colors.green("✓")} ${label}${detail ? colors.dim(` · ${detail}`) : ""}`);
}

function warn(label, detail = "") {
  warnCount += 1;
  console.log(`${colors.yellow("!")} ${label}${detail ? colors.dim(` · ${detail}`) : ""}`);
}

function fail(label, detail = "") {
  failCount += 1;
  console.log(`${colors.red("✗")} ${label}${detail ? colors.dim(` · ${detail}`) : ""}`);
}

function run(command, args = [], timeout = 4_000) {
  try {
    return execFileSync(command, args, {
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

async function fetchJson(url, timeout = 2_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function byteSize(value) {
  const number = Number(value);
  if (!number) return null;
  return `${(number / 1024 ** 3).toFixed(1)} GB`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function querySocket(command, timeout = 1_500) {
  return new Promise((resolve) => {
    const socket = connect(CONTROL_SOCKET);
    let data = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish(data.trim() || null);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

async function main() {
  console.log(`\n${colors.bold("Baldborg doctor")}\n`);

  /* ------------------------------------------------------------- config -- */
  let config;
  try {
    config = readConfig();
  } catch (error) {
    console.warn(error.message);
  }
  if (!config) {
    fail("Configuración ilegible", `${CONFIG_PATH} + ${USER_CONFIG_PATH}`);
  } else {
    ok("Configuración válida");
    const model = config.brain?.model;
    const ctx = config.brain?.numCtx;
    if (model) ok("Modelo configurado", `${model} · contexto ${ctx ?? "?"}`);
    else fail("Falta brain.model en la configuración");

    if (config.tools?.team?.name) ok("Equipo configurado", config.tools.team.name);
    if (config.tools?.weather?.defaultCity) ok("Ciudad configurada", config.tools.weather.defaultCity);
  }

  /* ------------------------------------------------------------- ollama -- */
  const host = config?.brain?.host ?? "http://127.0.0.1:11434";
  const version = await fetchJson(`${host}/api/version`);
  if (!version) {
    fail("Ollama no responde", host);
    console.log(colors.dim("  Inícialo con: systemctl --user start ollama"));
  } else {
    ok("Ollama activo", `v${version.version}`);
    const tags = await fetchJson(`${host}/api/tags`);
    const models = (tags?.models ?? []).map((entry) => entry.name);
    const model = config?.brain?.model;
    if (model && models.includes(model)) ok("Modelo instalado", model);
    else if (model) fail("Modelo no instalado", `ollama pull ${model}`);

    const ps = run("ollama", ["ps"]);
    const line = ps
      ?.split("\n")
      .find((entry) => entry.trim().startsWith(model ?? "\u0000"));
    if (line) {
      const gpu = /(\d+)%\s+GPU/i.test(line);
      const cpu = /(\d+)%\s+CPU/i.test(line);
      const mixed = /CPU\/GPU|GPU\/CPU/i.test(line);
      if (gpu && !mixed && !cpu) {
        const size = line.match(/([\d.]+)\s+GB/)?.[1];
        ok("Modelo en GPU", `${size ? `${size} GB VRAM` : "100% GPU"}`);
      } else if (mixed) {
        warn("Modelo con offload parcial", "parte del modelo está en CPU");
      } else {
        fail(
          "Ollama está usando CPU",
          "instala ollama-vulkan/rocm/cuda y reinicia el servicio",
        );
      }
    } else {
      const backend = existsSync("/usr/lib/ollama/vulkan/libggml-vulkan.so")
        ? "Vulkan"
        : run("pacman", ["-Q", "ollama-rocm"])
          ? "ROCm"
          : run("pacman", ["-Q", "ollama-cuda"])
            ? "CUDA"
            : null;
      if (backend) {
        ok("Backend GPU instalado", `${backend}; el modelo se cargará al usarlo`);
      } else {
        warn("No detecté backend GPU", "Ollama podría caer a CPU");
      }
    }
  }

  /* ---------------------------------------------------------------- gpu -- */
  const gpuName = run("lspci", ["-nn"]); // cheap presence check for lspci
  if (gpuName !== null) {
    const line = gpuName
      .split("\n")
      .find((entry) => /VGA|3D|Display/i.test(entry));
    if (line) {
      const name =
        line.match(/\[((?:Radeon|GeForce|Intel|Arc)[^\]]*)\]/)?.[1] ??
        line.split(/\[[0-9a-f]{4}:[0-9a-f]{4}\]/)[0].split(": ").pop()?.trim();
      ok("GPU detectada", name || "tarjeta gráfica");
    }
  }
  const vramPath = ["/sys/class/drm/card0/device/mem_info_vram_total", "/sys/class/drm/card1/device/mem_info_vram_total"].find(
    (path) => existsSync(path),
  );
  if (vramPath) {
    const vram = byteSize(readFileSync(vramPath, "utf8"));
    if (vram) ok("VRAM detectada", vram);
  }

  /* --------------------------------------------------------------- voice -- */
  const provider = config?.voice?.provider ?? "kokoro";
  ok("Proveedor de voz", provider);
  ok("Efecto de voz", config?.voice?.effects?.preset ?? "device");

  let azureFile = null;
  if (existsSync(VOICE_FILE)) {
    azureFile = readJson(VOICE_FILE);
    const mode = statSync(VOICE_FILE).mode & 0o777;
    if (mode & 0o077) {
      warn("voice.json es legible por otros", "chmod 600 ~/.config/baldborg/voice.json");
    }
  }
  const azureKey = process.env.AZURE_SPEECH_KEY ?? azureFile?.azureKey;
  const azureRegion = process.env.AZURE_SPEECH_REGION ?? azureFile?.azureRegion;
  if (provider === "azure") {
    if (azureKey && azureRegion) {
      ok("Azure configurado", `región ${azureRegion}`);
      ok(
        "Voces Azure",
        `es ${config?.voice?.azure?.es?.voice ?? "?"} · en ${config?.voice?.azure?.en?.voice ?? "?"}`,
      );
    } else {
      warn("Azure sin clave o región", "se usará Kokoro como respaldo");
    }
  } else if (azureKey && azureRegion) {
    ok("Azure disponible pero inactivo", `región ${azureRegion}`);
  }

  const health = await fetchJson("http://127.0.0.1:8765/health", 1_500);
  if (health) {
    ok("Sidecar de voz activo", health.stt ? `STT ${health.stt}` : "STT se cargará al dictar");
  } else {
    warn("Sidecar de voz apagado", "se inicia al primer uso");
  }

  const sttModel = config?.voice?.stt?.model ?? "small";
  const sttCache = join(
    homedir(),
    ".cache",
    "huggingface",
    "hub",
    `models--Systran--faster-whisper-${sttModel}`,
  );
  if (existsSync(sttCache)) ok("Modelo STT descargado", sttModel);
  else warn("Modelo STT no descargado", "se bajará al primer dictado");

  /* ---------------------------------------------------------- microphone -- */
  const source = run("pactl", ["get-default-source"]);
  const sources = run("pactl", ["list", "short", "sources"]);
  if (source && sources?.includes(source)) {
    ok("Micrófono por defecto", source);
  } else {
    warn("No pude leer el micrófono por defecto", "revisa pactl / PipeWire");
  }
  if (existsSync("/usr/bin/pw-record")) ok("Captura disponible", "pw-record");
  else fail("Falta pw-record", "instala pipewire-tools");

  /* ------------------------------------------------------------- app/socket */
  if (existsSync(CONTROL_SOCKET)) {
    const raw = await querySocket("status");
    const status = raw ? (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })() : null;
    if (status) {
      ok(
        "Overlay activo",
        `${status.mode ?? "?"} · ${status.muted ? "silenciado" : "voz activa"} · ` +
          `${status.listening ? "escuchando" : "micrófono inactivo"}`,
      );
    } else {
      warn("Socket presente pero sin respuesta", "reinicia la app con bin/baldborg quit y bin/baldborg start");
    }
  } else {
    warn("Overlay no está corriendo", "arráncalo con bin/baldborg-start");
  }

  /* -------------------------------------------------------------- hyprland */
  const lua = join(homedir(), ".config", "hypr", "baldborg.lua");
  if (existsSync(lua) && readFileSync(lua, "utf8").includes("SUPER + SHIFT + V")) {
    ok("Atajos de Hyprland instalados", "incluye push-to-talk");
  } else {
    warn("Faltan los atajos de Hyprland", "ejecuta scripts/install-hyprland.sh");
  }
  if (run("hyprctl", ["version"])) ok("Hyprland responde");
  else warn("No pude consultar Hyprland");

  /* ------------------------------------------------------------- resources */
  try {
    const stats = statfsSync("/home");
    const free = (stats.bavail * stats.bsize) / 1024 ** 3;
    if (free < 5) warn("Poco espacio en disco", `${free.toFixed(1)} GB libres`);
    else ok("Espacio en disco", `${free.toFixed(1)} GB libres`);
  } catch {
    /* ignore */
  }
  const freeRam = freemem() / 1024 ** 3;
  const totalRam = totalmem() / 1024 ** 3;
  if (freeRam < 1) warn("Poca RAM libre", `${freeRam.toFixed(1)} / ${totalRam.toFixed(1)} GB`);
  else ok("Memoria del sistema", `${freeRam.toFixed(1)} / ${totalRam.toFixed(1)} GB libres`);

  console.log(
    `\n${colors.bold("Resumen:")} ${okCount} ok · ${warnCount} avisos · ${failCount} errores\n`,
  );
  process.exit(failCount > 0 ? 1 : 0);
}

await main();
