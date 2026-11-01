/**
 * Electron main process for the Baldborg companion overlay.
 *
 * Phase 1 responsibilities:
 *  - transparent, frameless, always-on-top window that never steals focus
 *  - passive mode (clicks pass through) vs interactive mode (chat bar + drag)
 *  - control channel over a UNIX socket, driven by Hyprland keybindings
 *
 * Wayland owns window placement and focus, so the compositor (Hyprland) is the
 * authority: position and sizing come from config/hypr/baldborg.lua, and focus
 * is handed back with a Hyprland dispatcher instead of win.blur().
 */

import "./migrate.js";

import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelChat,
  confirmAction,
  getHistory,
  isBusy,
  resetHistory,
  startChat,
  startTask,
  warmup,
} from "./brain.js";
import {
  beatStatus,
  forceBeat,
  noteInteraction,
  noteLanguage,
  startBeats,
  stopBeats,
} from "./beats.js";
import {
  parseBeatInterval,
  parseCommand,
  parseSilentHours,
  parseToggle,
} from "./commands.js";
import { startEpicWatch, stopEpicWatch } from "./epic.js";
import {
  forgetFact,
  listFacts,
  memoryCount,
  normaliseKey,
  parseFact,
  rememberFact,
} from "./memory.js";
import {
  configSummary,
  AZURE_VOICES,
  setAutoSpeak,
  setAvatarMaterial,
  setAzureVoice,
  setBeatsEnabled,
  setBeatsEvery,
  setSilentHours,
  setUiLanguage,
  setVoiceEffectsPreset,
  setVoiceProvider,
} from "./settings.js";
import {
  abortListening,
  isListening,
  startListening,
  stopListening,
  transcribe,
  warmTranscription,
} from "./stt.js";
import { autoSpeakEnabled, detectLanguage, stopVoice, synthesize, voiceStatus } from "./voice.js";
import {
  loadUserTools,
  resumeReminders,
  setDefaultCity,
  setFavouriteTeam,
  setReminderNotifier,
} from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The overlay is pixel-exact: Chromium's fractional scale (1.1875 on this
// setup) renders a larger buffer than the Wayland surface and the compositor
// crops it, which cut the bottom of the chat bar. Force CSS px == device px.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

/** Hyprland window class; it comes from package.json "name". */
const WM_CLASS = "baldborg-desktop";

/** Passive mode only needs the head; interactive mode adds the chat bar. */
const CONFIG_PATH = join(__dirname, "..", "..", "..", "config", "default.json");

function sessionLocked() {
  const id = process.env.XDG_SESSION_ID;
  if (!id) return null;
  try {
    const out = execFileSync("loginctl", ["show-session", id, "-p", "LockedHint"], {
      timeout: 1500,
    }).toString();
    return out.includes("LockedHint=yes");
  } catch {
    return null;
  }
}

/** Accent colour of the current Omarchy theme (colors.toml). */
function currentThemeAccent() {
  try {
    const slug = execFileSync("omarchy", ["theme", "current"], { timeout: 2000 }).toString().trim();
    if (!slug) return null;

    const candidates = [];
    try {
      candidates.push(execFileSync("omarchy", ["theme", "dir", slug], { timeout: 2000 }).toString().trim());
    } catch {
      /* ignore */
    }
    const home = homedir();
    candidates.push(
      join(home, ".config", "omarchy", "themes", slug),
      join(home, ".config", "omarchy", "themes", slug.toLowerCase()),
      join("/usr/share/omarchy/themes", slug),
      join("/usr/share/omarchy/themes", slug.toLowerCase()),
    );

    for (const dir of candidates) {
      const file = join(dir, "colors.toml");
      if (!existsSync(file)) continue;
      const match = readFileSync(file, "utf8").match(/^accent\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

function avatarMaterial() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")).avatar?.material ?? "normal";
  } catch {
    return "normal";
  }
}

// Closed frame. When the chat opens it grows sideways to SIDE_WIDTH so the
// console can sit next to the head instead of pushing the head down.
const WINDOW_HEIGHT = 460;
const HEAD_BOX = 200;
const CONSOLE_BOX = 340;
const SIDE_GAP = 12;
const SIDE_MARGIN = 8;
const SIDE_WIDTH = SIDE_MARGIN * 2 + HEAD_BOX + SIDE_GAP + CONSOLE_BOX; // 568
const HEAD_CENTER_STACKED = 190;
const HEAD_CENTER_RIGHT = SIDE_MARGIN + HEAD_BOX / 2; // 108
const HEAD_CENTER_LEFT = SIDE_WIDTH - SIDE_MARGIN - HEAD_BOX / 2; // 460
const SIZES = {
  passive: { width: 380, height: WINDOW_HEIGHT },
};
/** Gap between the overlay and the monitor edge, in px. */
const EDGE_MARGIN = 24;

const STATE_DIR = join(homedir(), ".config", "baldborg");
const STATE_FILE = join(STATE_DIR, "state.json");
const CONTROL_SOCKET = join(STATE_DIR, "control.sock");

const DEFAULT_STATE = {
  muted: false,
};

/** @type {BrowserWindow | null} */
let win = null;
let state = loadState();
let mode = "passive";
let chatSide = "stacked";
let headAnchorX = null;
let applyingGeometry = false;
let geometryTimer = null;
let lastMood = "neutral";
let warming = false;

/* ---------------------------------------------------------------- state -- */

function loadState() {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(patch = {}) {
  state = { ...state, ...patch };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ------------------------------------------------------------- hyprland -- */

/** Run a Hyprland Lua dispatcher (0.56+ replaced the old string dispatchers). */
function hyprDispatch(lua) {
  return new Promise((resolve) => {
    execFile("hyprctl", ["dispatch", lua], (error) => resolve(!error));
  });
}

/** Run arbitrary Lua inside Hyprland (needed for config changes at runtime). */
function hyprEval(code) {
  return new Promise((resolve) => {
    execFile("hyprctl", ["eval", code], (error) => resolve(!error));
  });
}

/** Restore the previous cursor:no_warps value on quit. */
let originalNoWarps = null;

function cursorNoWarps() {
  try {
    const out = execFileSync("hyprctl", ["getoption", "cursor:no_warps"], { timeout: 1500 }).toString();
    return out.includes("bool: true");
  } catch {
    return null;
  }
}

/**
 * Hyprland warps the pointer to the centre of a window whenever focus changes,
 * which made the cursor jump while it crossed the overlay (every refocus after
 * a hover did it). Disabling warps while the companion runs keeps the pointer
 * where the user left it; the value is restored on quit.
 */
function enableNoWarps() {
  originalNoWarps = cursorNoWarps();
  if (originalNoWarps === true) return;
  hyprEval("hl.config({ cursor = { no_warps = true } })");
}

function restoreNoWarps() {
  if (originalNoWarps !== false) return;
  // Synchronous: the process exits right after will-quit, an async child would
  // be killed before Hyprland applies the change.
  try {
    execFileSync("hyprctl", ["eval", "hl.config({ cursor = { no_warps = false } })"], {
      timeout: 1500,
    });
  } catch {
    console.warn("[baldborg] could not restore cursor:no_warps");
  }
}

function hyprlandClient() {
  try {
    const clients = JSON.parse(execFileSync("hyprctl", ["clients", "-j"], { timeout: 1500 }).toString());
    return clients.find((client) => client.class === WM_CLASS) ?? null;
  } catch {
    return null;
  }
}

function hyprlandMonitors() {
  try {
    return JSON.parse(execFileSync("hyprctl", ["monitors", "-j"], { timeout: 1500 }).toString());
  } catch {
    return [];
  }
}

/**
 * Hyprland's `clients[].monitor` field does not reliably match the geometry,
 * so the monitor is resolved by hit-testing the window centre instead.
 */
function monitorForClient(client) {
  const monitors = hyprlandMonitors();
  if (!client?.at) return monitors[0] ?? null;
  const centerX = client.at[0] + client.size[0] / 2;
  const centerY = client.at[1] + client.size[1] / 2;
  return (
    monitors.find(
      (monitor) =>
        centerX >= monitor.x &&
        centerX < monitor.x + monitor.width &&
        centerY >= monitor.y &&
        centerY < monitor.y + monitor.height,
    ) ??
    monitors[0] ??
    null
  );
}

/**
 * Hyprland applies the `move` window rule unreliably on this setup, so the
 * app re-checks its own position and asks the compositor to move it when it
 * does not match the expected bottom-right corner.
 */
async function ensurePlacement() {
  if (mode !== "passive") return;
  const client = hyprlandClient();
  if (!client?.at) return;
  const monitor = monitorForClient(client);
  if (!monitor) return;

  const localX = monitor.width - client.size[0] - EDGE_MARGIN;
  const localY = monitor.height - client.size[1] - EDGE_MARGIN;
  const globalX = monitor.x + localX;
  const globalY = monitor.y + localY;

  if (Math.abs(client.at[0] - globalX) < 8 && Math.abs(client.at[1] - globalY) < 8) return;

  const workspace = activeWorkspaceId();
  await setOverlayFocusable(true);
  await focusOverlay();
  await hyprDispatch(`hl.dsp.window.move({ x = ${globalX}, y = ${globalY} })`);
  if (mode === "passive") {
    await setOverlayFocusable(false);
    focusPreviousOnWorkspace(workspace);
  }
}

/** Hyprland's move/resize dispatchers target the active window, so focus first. */
function focusOverlay() {
  return hyprDispatch(`hl.dsp.focus({ window = "class:${WM_CLASS}" })`);
}

function activeWorkspaceId() {
  try {
    return JSON.parse(execFileSync("hyprctl", ["activeworkspace", "-j"], { timeout: 1500 })).id;
  } catch {
    return null;
  }
}

/**
 * Give focus back without ever leaving the current workspace: restoring a
 * window that lives elsewhere made Hyprland flip between workspaces while the
 * pointer sat on the pinned overlay.
 */
function focusPreviousOnWorkspace(workspace = activeWorkspaceId()) {
  let address = null;
  try {
    const clients = JSON.parse(execFileSync("hyprctl", ["clients", "-j"], { timeout: 1500 }).toString());
    const candidates = clients
      .filter(
        (client) =>
          client.class !== WM_CLASS && client.mapped && client.workspace?.id === workspace,
      )
      .sort((a, b) => a.focusHistoryID - b.focusHistoryID);
    address = candidates[0]?.address ?? null;
  } catch {
    address = null;
  }
  if (address) hyprDispatch(`hl.dsp.focus({ window = "address:${address}" })`);
}

/** Screen X of the head centre for the current layout. */
function headCenterForClient(client, side = chatSide) {
  if (!client?.at || !client?.size) return null;
  if (side === "left") return client.at[0] + HEAD_CENTER_LEFT;
  if (side === "right") return client.at[0] + HEAD_CENTER_RIGHT;
  return client.at[0] + client.size[0] / 2;
}

/**
 * The console always opens sideways: left half -> right, right half -> left.
 * The head centre stays fixed, so the window grows towards the free side.
 * There is deliberately no vertical fallback.
 */
function chooseChatSide(headCenterX, monitor) {
  if (!monitor || headCenterX == null) return "right";
  const monitorCenter = monitor.x + monitor.width / 2;
  return headCenterX <= monitorCenter ? "right" : "left";
}

function geometryFor(next, monitor, client) {
  const interactive = next === "interactive";
  const fallbackCenter =
    headAnchorX ?? (client?.at ? client.at[0] + (client.size?.[0] ?? SIZES.passive.width) / 2 : null);
  const center = fallbackCenter ?? (monitor ? monitor.x + monitor.width / 2 : 0);
  const side = interactive ? chooseChatSide(center, monitor) : "stacked";
  const width = interactive ? SIDE_WIDTH : SIZES.passive.width;
  const offset =
    side === "right" ? HEAD_CENTER_RIGHT : side === "left" ? HEAD_CENTER_LEFT : HEAD_CENTER_STACKED;
  const idealX = center - offset;
  const minX = (monitor?.x ?? 0) + EDGE_MARGIN;
  const maxX = (monitor?.x ?? 0) + (monitor?.width ?? width) - width - EDGE_MARGIN;
  const x = Math.max(minX, Math.min(idealX, maxX));
  const y = (monitor?.y ?? 0) + (monitor?.height ?? WINDOW_HEIGHT) - WINDOW_HEIGHT - EDGE_MARGIN;
  return { side, width, height: WINDOW_HEIGHT, x, y, center: x + offset };
}

/**
 * Resize and place the surface. The head keeps its screen position; opening
 * the chat only changes the window width and which side the console uses.
 * Hyprland's move dispatcher takes global coordinates.
 */
async function applyWindowGeometry(next, monitorOverride = null) {
  const client = hyprlandClient();
  const monitor = monitorOverride ?? monitorForClient(client);
  if (!monitor) return chatSide;

  const geometry = geometryFor(next, monitor, client);
  chatSide = geometry.side;
  headAnchorX = geometry.center;
  win?.webContents.send("layout:changed", chatSide);

  const already =
    client?.size?.[0] === geometry.width &&
    client?.size?.[1] === geometry.height &&
    Math.abs(client.at[0] - geometry.x) < 8 &&
    Math.abs(client.at[1] - geometry.y) < 8;
  if (already) return chatSide;

  applyingGeometry = true;
  try {
    // Ask Chromium too, for compositors that honour client resize requests.
    win?.setSize(geometry.width, geometry.height);

    const workspace = activeWorkspaceId();

    // move/resize act on the active window; allow focus just for this.
    await setOverlayFocusable(true);
    await focusOverlay();
    await hyprDispatch(
      `hl.dsp.window.resize({ x = ${geometry.width}, y = ${geometry.height}, window = "class:${WM_CLASS}" })`,
    );

    if (mode === "passive") {
      await setOverlayFocusable(false);
      focusPreviousOnWorkspace(workspace);
    }

    // Target the window explicitly: after focus changes Hyprland can re-home a
    // pinned window to the primary monitor.
    await hyprDispatch(
      `hl.dsp.window.move({ x = ${geometry.x}, y = ${geometry.y}, window = "class:${WM_CLASS}" })`,
    );
  } finally {
    applyingGeometry = false;
  }
  return chatSide;
}

/** Re-pick the side after a drag, but only if the side actually changes. */
async function refreshChatSide() {
  if (mode !== "interactive" || applyingGeometry) return;
  const client = hyprlandClient();
  if (!client?.at) return;
  const monitor = monitorForClient(client);
  const center = headCenterForClient(client, chatSide);
  if (center == null) return;
  headAnchorX = center;
  if (chooseChatSide(center, monitor) !== chatSide) {
    await applyWindowGeometry("interactive", monitor);
  }
}

/** On restart the overlay starts on workspace 1 of the focused output. */
async function resetToDefaultWorkspace() {
  if (!win) return;
  const monitors = hyprlandMonitors();
  const target = monitors.find((monitor) => monitor.focused) ?? monitors[0] ?? null;
  if (target) {
    await hyprDispatch(
      `hl.dsp.window.move({ monitor = ${JSON.stringify(target.name)}, window = "class:${WM_CLASS}", follow = false })`,
    );
  }
  await hyprDispatch(
    `hl.dsp.window.move({ workspace = "1", window = "class:${WM_CLASS}", follow = false })`,
  );
  const client = hyprlandClient();
  const monitor = monitorForClient(client);
  if (monitor) await applyWindowGeometry("passive", monitor);
}

let beatsRunning = false;

function startBeatScheduler() {
  startBeats({
    send: (event) => win?.webContents.send("beat:event", event),
    isMuted: () => state.muted,
    getMode: () => mode,
  });
  startEpicWatch();
  beatsRunning = true;
}

function createWindow() {
  win = new BrowserWindow({
    width: SIZES.passive.width,
    height: SIZES.passive.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    title: "Baldborg",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    win.loadURL(devServer);
  } else {
    win.loadFile(join(__dirname, "..", "dist", "index.html"));
  }

  win.once("ready-to-show", () => {
    win.showInactive();
    applyMode("passive");

    // The compositor owns placement; nudge it if the rule did not take.
    for (const delay of [500, 1500, 3000]) setTimeout(ensurePlacement, delay);
    setTimeout(() => void resetToDefaultWorkspace(), 700);
  });

  // Keep the chat input focused whenever the compositor focuses the window.
  win.on("focus", () => win?.webContents.send("window:focus"));

  // After a drag, flip the console to the side with more room.
  win.on("move", () => {
    if (mode !== "interactive" || applyingGeometry) return;
    if (geometryTimer) clearTimeout(geometryTimer);
    geometryTimer = setTimeout(() => void refreshChatSide(), 300);
  });

  try {
    if (configSummary().beatsEnabled) startBeatScheduler();
  } catch {
    startBeatScheduler();
  }

  win.on("closed", () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Surface renderer logs in the terminal; invaluable while iterating on shaders.
  win.webContents.on("console-message", (...args) => {
    const event = args[0];
    if (event && typeof event.message === "string") {
      console.log(`[renderer:${event.level}] ${event.message}`);
    } else {
      console.log(`[renderer] ${args[2]}`);
    }
  });
  win.webContents.on("preload-error", (_event, path, error) => {
    console.error(`[baldborg] preload failed (${path}):`, error.message);
  });
}

/**
 * Hyprland's follow-mouse focus makes the overlay grab focus whenever the
 * pointer crosses it. In passive mode that must never happen: the window would
 * fight for focus and, because the restore target can live on another
 * workspace, the compositor would flip between workspaces. `no_focus` is set
 * at the compositor level instead of relying on win.blur().
 */
function setOverlayFocusable(focusable) {
  return hyprDispatch(
    `hl.dsp.window.set_prop({ prop = "no_focus", value = "${focusable ? "false" : "true"}", window = "class:${WM_CLASS}" })`,
  );
}

/**
 * passive     -> no focus at all, clicks pass through
 * interactive -> focusable, accepts clicks, shows the chat bar, draggable
 */
async function applyMode(next) {
  mode = next === "interactive" ? "interactive" : "passive";
  if (!win) return;

  // Capture the monitor and the current head position before focus changes:
  // the compositor may re-home a pinned window when focus moves.
  const client = hyprlandClient();
  const monitor = monitorForClient(client);
  const center = headCenterForClient(client, chatSide);
  if (center != null) headAnchorX = center;

  if (mode === "passive") {
    // Capture the workspace before touching focus: Hyprland may switch away
    // the moment the overlay stops being focusable.
    const workspace = activeWorkspaceId();
    win.setIgnoreMouseEvents(true, { forward: true });
    await setOverlayFocusable(false);
    focusPreviousOnWorkspace(workspace);
  } else {
    win.setIgnoreMouseEvents(false);
    await setOverlayFocusable(true);
    await focusOverlay();
    // Make sure the chat input owns the keyboard, even if the window was
    // already focused (no new window:focus event in that case).
    win.webContents.send("window:focus");
  }

  // Resize/position first, then let the renderer swap the layout.
  await applyWindowGeometry(mode, monitor);
  win.webContents.send("mode:changed", mode);
}

function toggleMode() {
  if (win && !win.isVisible()) win.showInactive();
  applyMode(mode === "passive" ? "interactive" : "passive");
}

function setMuted(muted) {
  saveState({ muted });
  win?.webContents.send("audio:muted", muted);
}

/* --------------------------------------------------------------- hotkeys -- */
/* globalShortcut only works under X11; kept as a bonus. Hyprland keybindings
   (config/hypr/baldborg.lua) are the primary path on Wayland. */

function registerHotkeys() {
  try {
    globalShortcut.register("Super+Alt+D", toggleMode);
    globalShortcut.register("Super+Alt+M", () => setMuted(!state.muted));
  } catch (error) {
    console.info("[baldborg] globalShortcut unavailable (Wayland):", error.message);
  }
}

/* --------------------------------------------------------- control socket -- */

/** Single entry point for typed and spoken messages. */
function runChat(text, language) {
  const detected = language ?? detectLanguage(text);
  noteInteraction();
  noteLanguage(detected);
  startChat(
    text,
    (event) => {
      if (event.type === "done" && event.mood) lastMood = event.mood;
      win?.webContents.send("brain:event", event);
    },
    undefined,
    detected,
  );
}

/** Slash commands typed in the chat. They never reach the model. */
function configMessage() {
  try {
    const c = configSummary();
    const b = beatStatus();
    const en = interfaceLanguage() === "en";
    const cadence =
      b.everyMinutes > 0
        ? en ? `every ${b.everyMinutes} min` : `cada ${b.everyMinutes} min`
        : `${b.minMinutes}-${b.maxMinutes} min`;
    const silent =
      b.silentHours[0] === 0 && b.silentHours[1] === 0
        ? en ? "none" : "sin"
        : `${b.silentHours[0]}-${b.silentHours[1]}`;
    return [
      en
        ? `Model: ${c.model} · context ${c.context} · temperature ${c.temperature}`
        : `Modelo: ${c.model} · contexto ${c.context} · temperatura ${c.temperature}`,
      en
        ? `Voice: ${c.voiceProvider} · es ${c.voiceEs} · en ${c.voiceEn} · FX ${c.voiceEffects} · auto ${c.autoSpeak ? "yes" : "no"} · STT ${c.sttModel}`
        : `Voz: ${c.voiceProvider} · es ${c.voiceEs} · en ${c.voiceEn} · FX ${c.voiceEffects} · automática ${c.autoSpeak ? "sí" : "no"} · STT ${c.sttModel}`,
      en
        ? `Beats: ${b.enabled ? "active" : "stopped"} · ${c.beatsLanguage} · ${c.beatsGenerator} · ${cadence} · silent ${silent} · today ${b.count}/${b.dailyCap}`
        : `Beats: ${b.enabled ? "activos" : "detenidos"} · ${c.beatsLanguage} · ${c.beatsGenerator} · ${cadence} · silencio ${silent} · hoy ${b.count}/${b.dailyCap}`,
      en ? `Avatar: ${c.material}` : `Avatar: ${c.material}`,
      en ? `Team: ${c.team}` : `Equipo: ${c.team}`,
      en ? `City: ${c.city}` : `Ciudad: ${c.city}`,
      en
        ? `Tools: ${c.toolsEnabled ? "enabled" : "disabled"}`
        : `Herramientas: ${c.toolsEnabled ? "activas" : "desactivadas"}`,
      en
        ? `Memory: ${memoryCount()} fact${memoryCount() === 1 ? "" : "s"}`
        : `Memoria: ${memoryCount()} hecho${memoryCount() === 1 ? "" : "s"}`,
    ].join("\n");
  } catch (error) {
    return interfaceLanguage() === "en"
      ? `Could not read the configuration: ${error.message}`
      : `No pude leer la configuración: ${error.message}`;
  }
}

function statusMessage() {
  const c = configSummary();
  const b = beatStatus();
  const en = interfaceLanguage() === "en";
  const cadence =
    b.everyMinutes > 0
      ? en ? `every ${b.everyMinutes} min` : `cada ${b.everyMinutes} min`
      : `${b.minMinutes}-${b.maxMinutes} min`;
  const silent =
    b.silentHours[0] === 0 && b.silentHours[1] === 0
      ? en ? "none" : "sin"
      : `${b.silentHours[0]}-${b.silentHours[1]}`;
  const next = b.nextInMinutes == null ? "" : en ? ` · next in ${b.nextInMinutes} min` : ` · próxima en ${b.nextInMinutes} min`;
  const blocked = b.lastBlocked
    ? en
      ? ` · last block: ${localizeBlockReason(b.lastBlocked.reason, true)}`
      : ` · último bloqueo: ${b.lastBlocked.reason}`
    : "";
  const hour = new Date().getHours();
  const silentNow =
    b.silentHours[0] !== b.silentHours[1] &&
    (b.silentHours[0] < b.silentHours[1]
      ? hour >= b.silentHours[0] && hour < b.silentHours[1]
      : hour >= b.silentHours[0] || hour < b.silentHours[1]);
  const paused =
    b.mode === "interactive"
      ? en ? "chat open" : "chat abierto"
      : b.muted
        ? en ? "voice muted" : "voz silenciada"
        : silentNow
          ? en ? "silent hours" : "horas silenciosas"
          : b.count >= b.dailyCap
            ? en ? "daily cap" : "tope diario"
            : null;
  const pause = paused ? (en ? ` · paused: ${paused}` : ` · en pausa: ${paused}`) : "";

  return [
    en
      ? `Mode: ${mode} · ${state.muted ? "muted" : "voice active"} · ${isBusy() ? "busy" : "free"} · microphone ${isListening() ? "active" : "inactive"}`
      : `Modo: ${mode} · ${state.muted ? "silenciado" : "voz activa"} · ${isBusy() ? "ocupado" : "libre"} · micrófono ${isListening() ? "activo" : "inactivo"}`,
    en
      ? `Beats: ${b.running ? "active" : "stopped"} · ${cadence} · silent ${silent} · today ${b.count}/${b.dailyCap}${next}${pause}${blocked}`
      : `Beats: ${b.running ? "activos" : "detenidos"} · ${cadence} · silencio ${silent} · hoy ${b.count}/${b.dailyCap}${next}${pause}${blocked}`,
    en
      ? `Model: ${c.model} · voice ${c.voiceProvider} · STT ${c.sttModel}`
      : `Modelo: ${c.model} · voz ${c.voiceProvider} · STT ${c.sttModel}`,
  ].join("\n");
}

function localizeBlockReason(reason, english) {
  if (!english) return reason;
  return (
    {
      "beats desactivados": "beats disabled",
      "voz silenciada": "voice muted",
      "chat abierto": "chat open",
      "horas silenciosas": "silent hours",
      "sesión bloqueada": "session locked",
      "pantalla completa": "fullscreen",
      "tope diario": "daily cap",
    }[reason] ?? reason
  );
}

function interfaceLanguage() {
  try {
    return configSummary().uiLanguage === "en" ? "en" : "es";
  } catch {
    return "es";
  }
}

function runAppCommand(raw) {
  const { command, argument } = parseCommand(raw);
  const en = interfaceLanguage() === "en";

  switch (command) {
    case "/help":
      return {
        ok: true,
        message: en
          ? [
              "Commands:",
              "/config — show every setting",
              "/status — companion and model status",
              "/mute [on|off] — mute or enable the voice",
              "/voice [on|off] — persistent automatic speech",
              "/voice provider kokoro|azure — TTS provider",
              "/voice fx clean|radio|corrupt — audio effect",
              "/voice es|en <alias> — Azure voice per language",
              "/voice list — available voices",
              "/beats [on|off] — start or stop beats",
              "/beats every <min>|random — fixed or random cadence",
              "/beats silent <start>-<end>|off — silent window",
              "/avatar normal|hologram — avatar material",
              "/language es|en — UI and beat language",
              "/club <team> — favourite football team",
              "/city <city> — default weather city",
              "/remember key = value — store a fact",
              "/memory — long-term memory",
              "/forget-fact key — delete a fact",
              "/translate [es|en] <text> — translate locally",
              "/correct <text> — fix grammar and spelling",
              "/clean-history — wipe the conversation",
              "/help — this list",
            ].join("\n")
          : [
              "Comandos:",
              "/config — ver todos los ajustes",
              "/status — estado del companion y del modelo",
              "/mute [on|off] — silenciar o activar la voz",
              "/voice [on|off] — voz automática persistente",
              "/voice provider kokoro|azure — proveedor de voz",
              "/voice fx clean|radio|corrupt — efecto de audio",
              "/voice es|en <alias> — voz de Azure por idioma",
              "/voice list — voces disponibles",
              "/beats [on|off] — activar o detener los beats",
              "/beats every <min>|random — frecuencia fija o aleatoria",
              "/beats silent <inicio>-<fin>|off — horas sin beats",
              "/avatar normal|hologram — material del avatar",
              "/language es|en — idioma de la UI y los beats",
              "/club <equipo> — cambiar el equipo favorito",
              "/city <ciudad> — cambiar la ciudad del clima",
              "/remember clave = valor — guardar un hecho",
              "/memory — ver la memoria de largo plazo",
              "/forget-fact clave — borrar un hecho",
              "/translate [es|en] <texto> — traducir en local",
              "/correct <texto> — corregir gramática y ortografía",
              "/clean-history — borrar la memoria de la conversación",
              "/help — esta lista",
            ].join("\n"),
      };

    case "/config":
      return { ok: true, message: configMessage() };

    case "/status":
      return { ok: true, message: statusMessage() };

    case "/mute": {
      const next = parseToggle(argument, state.muted);
      if (next === null) return { ok: false, message: en ? "Usage: /mute [on|off]" : "Uso: /mute [on|off]" };
      setMuted(next);
      return {
        ok: true,
        message: en
          ? next ? "Voice muted, sir." : "Voice enabled, sir."
          : next ? "Voz silenciada, señor." : "Voz activada, señor.",
      };
    }

    case "/unmute":
      setMuted(false);
      return { ok: true, message: en ? "Voice enabled, sir." : "Voz activada, señor." };

    case "/voice": {
      const value = argument.toLowerCase();
      const fxMatch = value.match(/^(?:fx|effects?)\s+(clean|radio|corrupt|malvado)$/);
      if (fxMatch) {
        try {
          const preset = setVoiceEffectsPreset(fxMatch[1] === "malvado" ? "corrupt" : fxMatch[1]);
          win?.webContents.send("voice:effects", preset);
          return { ok: true, message: en ? `Voice effect: ${preset}.` : `Efecto de voz: ${preset}.` };
        } catch (error) {
          return { ok: false, message: en ? `Could not change the effect: ${error.message}` : `No pude cambiar el efecto: ${error.message}` };
        }
      }

      if (value === "list" || value === "voices") {
        const lines = en
          ? [`Spanish: ${Object.keys(AZURE_VOICES.es).join(", ")}`, `English: ${Object.keys(AZURE_VOICES.en).join(", ")}`]
          : [`Español: ${Object.keys(AZURE_VOICES.es).join(", ")}`, `Inglés: ${Object.keys(AZURE_VOICES.en).join(", ")}`];
        return { ok: true, message: en ? `Azure voices:\n${lines.join("\n")}` : `Voces de Azure:\n${lines.join("\n")}` };
      }

      const voiceMatch = value.match(/^(es|en)\s+([a-z]+)$/);
      if (voiceMatch) {
        try {
          const chosen = setAzureVoice(voiceMatch[1], voiceMatch[2]);
          return {
            ok: true,
            message: en ? `Voice ${chosen.lang}: ${chosen.voice}.` : `Voz ${chosen.lang}: ${chosen.voice}.`,
          };
        } catch (error) {
          return { ok: false, message: en ? `Could not change the voice: ${error.message}` : `No pude cambiar la voz: ${error.message}` };
        }
      }

      const providerMatch = value.match(/^(?:provider\s+)?(kokoro|azure)$/);
      if (providerMatch) {
        try {
          const provider = setVoiceProvider(providerMatch[1]);
          return { ok: true, message: en ? `Voice provider: ${provider}.` : `Proveedor de voz: ${provider}.` };
        } catch (error) {
          return { ok: false, message: en ? `Could not change the provider: ${error.message}` : `No pude cambiar el proveedor: ${error.message}` };
        }
      }

      const next = parseToggle(argument, autoSpeakEnabled());
      if (next === null) {
        return {
          ok: false,
          message: en
            ? "Usage: /voice [on|off] · /voice provider kokoro|azure"
            : "Uso: /voice [on|off] · /voice provider kokoro|azure",
        };
      }
      setAutoSpeak(next);
      win?.webContents.send("voice:autoSpeak", next);
      return {
        ok: true,
        message: en
          ? next ? "Automatic speech enabled." : "Automatic speech disabled."
          : next ? "Voz automática activada." : "Voz automática desactivada.",
      };
    }

    case "/beats": {
      if (/^silent(\s|$)/i.test(argument)) {
        const silent = parseSilentHours(argument.replace(/^silent\s*/i, ""));
        if (!silent) {
          return { ok: false, message: en ? "Usage: /beats silent 23-8 | /beats silent off" : "Uso: /beats silent 23-8 | /beats silent off" };
        }
        setSilentHours(silent.start, silent.end);
        if (beatsRunning) startBeatScheduler();
        return {
          ok: true,
          message:
            silent.start === 0 && silent.end === 0
              ? en ? "Silent hours disabled." : "Horas silenciosas desactivadas."
              : en
                ? `Silent hours: ${silent.start}:00-${silent.end}:00.`
                : `Horas silenciosas: ${silent.start}:00-${silent.end}:00.`,
        };
      }

      const cadence = parseBeatInterval(argument);
      if (cadence) {
        const minutes = cadence.random ? 0 : cadence.minutes;
        setBeatsEvery(minutes);
        if (beatsRunning) startBeatScheduler();
        return {
          ok: true,
          message: cadence.random
            ? en ? "Beats on a random interval." : "Beats en intervalo aleatorio."
            : en
              ? `Beats every ${minutes} minute${minutes === 1 ? "" : "s"}.`
              : `Beats cada ${minutes} minuto${minutes === 1 ? "" : "s"}.`,
        };
      }

      const next = parseToggle(argument, beatsRunning);
      if (next === null) {
        return {
          ok: false,
          message: en
            ? "Usage: /beats [on|off] · /beats every <min> · /beats random"
            : "Uso: /beats [on|off] · /beats every <min> · /beats random",
        };
      }
      setBeatsEnabled(next);
      if (next && !beatsRunning) startBeatScheduler();
      if (!next && beatsRunning) {
        stopBeats();
        stopEpicWatch();
        beatsRunning = false;
      }
      return {
        ok: true,
        message: en
          ? next ? "Beats enabled." : "Beats stopped."
          : next ? "Beats activados." : "Beats detenidos.",
      };
    }

    case "/avatar": {
      const value = argument.toLowerCase();
      if (!value) return { ok: false, message: en ? "Usage: /avatar normal|hologram" : "Uso: /avatar normal|hologram" };
      try {
        setAvatarMaterial(value);
        win?.webContents.send("avatar:material", value);
        return { ok: true, message: en ? `Avatar material: ${value}.` : `Material del avatar: ${value}.` };
      } catch (error) {
        return {
          ok: false,
          message: en
            ? `Usage: /avatar normal|hologram (${error.message})`
            : `Uso: /avatar normal|hologram (${error.message})`,
        };
      }
    }

    case "/language": {
      const value = argument.toLowerCase();
      if (!["es", "en"].includes(value)) {
        return { ok: false, message: en ? "Usage: /language es|en" : "Uso: /language es|en" };
      }
      const language = setUiLanguage(value);
      win?.webContents.send("language:changed", language);
      return {
        ok: true,
        message: language === "en" ? "Interface and beats language: English." : "Idioma de la interfaz y los beats: español.",
      };
    }

    case "/translate":
      return {
        ok: false,
        message: en
          ? "Usage: /translate [es|en] <text>"
          : "Uso: /translate [es|en] <texto>",
      };

    case "/correct":
      return {
        ok: false,
        message: en ? "Usage: /correct <text>" : "Uso: /correct <texto>",
      };

    case "/clean-history":
    case "/forget":
    case "/reset":
      if (isBusy()) cancelChat();
      resetHistory();
      return {
        ok: true,
        reset: true,
        message: en
          ? "Memory wiped. We start again, without witnesses."
          : "Memoria borrada. Empezamos de nuevo, sin testigos.",
      };

    case "/remember": {
      const parsed = parseFact(argument);
      if (parsed.error) {
        const message = en
          ? parsed.error.includes("Uso")
            ? "Usage: /remember key = value"
            : "I cannot store that value."
          : parsed.error;
        return { ok: false, message };
      }
      try {
        const fact = rememberFact(parsed.key, parsed.value);
        return { ok: true, message: en ? `Remembered: ${fact.key} = ${fact.value}.` : `Recordado: ${fact.key} = ${fact.value}.` };
      } catch (error) {
        return { ok: false, message: en ? `Could not store it: ${error.message}` : `No pude guardarlo: ${error.message}` };
      }
    }

    case "/memory": {
      const facts = listFacts();
      if (!facts.length) {
        return {
          ok: true,
          message: en
            ? "My memory is empty. Use /remember key = value."
            : "Mi memoria está vacía. Use /remember clave = valor.",
        };
      }
      return {
        ok: true,
        message:
          en
            ? `Memory (${facts.length}):\n${facts.map((fact) => `· ${fact.key}: ${fact.value}`).join("\n")}`
            : `Memoria (${facts.length}):\n${facts.map((fact) => `· ${fact.key}: ${fact.value}`).join("\n")}`,
      };
    }

    case "/forget-fact": {
      const key = normaliseKey(argument);
      if (!key) return { ok: false, message: en ? "Usage: /forget-fact <key>" : "Uso: /forget-fact <clave>" };
      return forgetFact(key)
        ? { ok: true, message: en ? `Forgotten: ${key}.` : `Olvidado: ${key}.` }
        : { ok: false, message: en ? `I have no fact with key ${key}.` : `No tengo ningún hecho con la clave ${key}.` };
    }

    case "/club": {
      if (!argument) return { ok: false, message: en ? "Usage: /club <team>" : "Uso: /club <equipo>" };
      try {
        const team = setFavouriteTeam(argument);
        return { ok: true, message: en ? `Favourite team: ${team}.` : `Club favorito: ${team}.` };
      } catch (error) {
        return { ok: false, message: en ? `Could not save the team: ${error.message}` : `No pude guardar el club: ${error.message}` };
      }
    }

    case "/city": {
      if (!argument) return { ok: false, message: en ? "Usage: /city <city>" : "Uso: /city <ciudad>" };
      try {
        const city = setDefaultCity(argument);
        return { ok: true, message: en ? `Default city: ${city}.` : `Ciudad por defecto: ${city}.` };
      } catch (error) {
        return { ok: false, message: en ? `Could not save the city: ${error.message}` : `No pude guardar la ciudad: ${error.message}` };
      }
    }

    default:
      return {
        ok: false,
        message: en
          ? `Unknown command: ${command || "(empty)"}. Type /help for the list.`
          : `Comando desconocido: ${command || "(vacío)"}. Escriba /help para ver la lista.`,
      };
  }
}

function listenNotice(text) {
  win?.webContents.send("beat:event", {
    type: "beat",
    id: "listen-error",
    text,
    mood: "concerned",
    speak: false,
    durationMs: 6000,
  });
}

let listeningBusy = false;

async function beginListening() {
  if (!win || isListening() || listeningBusy) return;
  if (!startListening()) return;
  win.webContents.send("listen:state", { active: true, phase: "recording" });
}

async function endListening() {
  if (!isListening() || listeningBusy) return;
  listeningBusy = true;
  win?.webContents.send("listen:state", { active: true, phase: "transcribing" });

  try {
    const captured = await stopListening();
    if (!captured) {
      listenNotice(
        interfaceLanguage() === "en"
          ? "I heard nothing, sir. The microphone was more honest than usual."
          : "No he oído nada, señor. El micrófono ha sido más honesto que de costumbre.",
      );
      return;
    }

    const result = await transcribe(captured.wav);
    const text = (result?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) {
      listenNotice(
        interfaceLanguage() === "en"
          ? "Silence transcribed, sir. Not a word I can use against you."
          : "Silencio transcrito, señor. Ni una palabra que pueda usar en su contra.",
      );
      return;
    }

    // Talking over an answer: drop the old one before injecting the new
    // message, or its late "cancelled" event would clear the new placeholder.
    if (isBusy()) cancelChat();

    // Open the transcript first so the injected message has somewhere to land.
    await applyMode("interactive");
    win?.webContents.send("brain:event", { type: "voice", text });
    runChat(text, result?.language === "en" ? "en" : "es");
  } catch (error) {
    console.warn("[baldborg] transcription failed:", error.message);
    listenNotice(
      interfaceLanguage() === "en"
        ? "I could not transcribe the audio, sir. The link is to blame, of course."
        : "No he podido transcribir el audio, señor. La culpa es del enlace, por supuesto.",
    );
  } finally {
    listeningBusy = false;
    win?.webContents.send("listen:state", { active: false });
  }
}

function handleCommand(raw) {
  const [command, ...rest] = raw.trim().split(/\s+/);
  const argument = rest.join(" ").trim();

  switch (command) {
    case "toggle":
      toggleMode();
      break;
    case "open":
      win?.showInactive();
      applyMode("interactive");
      break;
    case "close":
      applyMode("passive");
      break;
    case "mute":
      setMuted(!state.muted);
      break;
    case "forget":
      resetHistory();
      win?.webContents.send("brain:event", { type: "reset" });
      break;
    case "speak":
      win?.webContents.send("voice:replay");
      break;
    case "glitch":
      win?.webContents.send("fx:glitch");
      break;
    case "beat":
      void forceBeat();
      break;
    case "listen":
      if (argument === "start") void beginListening();
      else if (argument === "stop") void endListening();
      break;
    case "announce":
      if (argument) {
        win?.webContents.send("beat:event", {
          type: "beat",
          id: "announce",
          text: argument,
          mood: "neutral",
          speak: false,
        });
      }
      break;
    case "language": {
      try {
        const language = setUiLanguage(argument);
        win?.webContents.send("language:changed", language);
        console.info(`[baldborg] language -> ${language}`);
      } catch {
        /* ignore invalid value */
      }
      break;
    }
    case "theme": {
      const accent = currentThemeAccent();
      if (accent) {
        saveState({ accent });
        win?.webContents.send("theme:accent", accent);
        console.info(`[baldborg] accent ${accent}`);
      }
      break;
    }
    case "show":
      win?.showInactive();
      break;
    case "hide":
      win?.hide();
      break;
    case "quit":
      app.quit();
      break;
    case "capture":
      if (win) {
        win.webContents
          .capturePage()
          .then((image) => writeFileSync("/tmp/opencode/baldborg-capture.png", image.toPNG()))
          .catch((error) => console.warn("[baldborg] capture failed:", error.message));
      }
      break;
    default:
      break;
  }
}

function startControlServer() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(CONTROL_SOCKET)) rmSync(CONTROL_SOCKET, { force: true });

  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      const raw = buffer.slice(0, newline).trim();
      if (raw === "beat") {
        // Show the bubble: it only renders in passive mode.
        void (async () => {
          await applyMode("passive");
          const id = await forceBeat();
          connection.end(JSON.stringify({ beat: id }) + "\n");
        })().catch(() => connection.end(JSON.stringify({ beat: null }) + "\n"));
        return;
      }
      if (raw === "status") {
        connection.end(
          JSON.stringify({
            mode,
            muted: state.muted,
            busy: isBusy(),
            warming,
            listening: isListening(),
            mood: lastMood,
            language: configSummary().uiLanguage,
            accent: state.accent ?? null,
          }) + "\n",
        );
        return;
      }

      handleCommand(raw);
      connection.end();
    });
    connection.on("error", () => {});
  });

  server.on("error", (error) => console.warn("[baldborg] control socket:", error.message));
  server.listen(CONTROL_SOCKET);

  app.on("will-quit", () => {
    abortListening();
    server.close();
    rmSync(CONTROL_SOCKET, { force: true });
  });
}

/* --------------------------------------------------------------- ipc ----- */

function registerIpc() {
  ipcMain.handle("app:get-state", () => ({
    mode,
    layout: chatSide,
    muted: state.muted,
    autoSpeak: autoSpeakEnabled(),
    language: (() => {
      try {
        return configSummary().uiLanguage;
      } catch {
        return "es";
      }
    })(),
    effects: (() => {
      try {
        return configSummary().voiceEffects;
      } catch {
        return "radio";
      }
    })(),
    material: avatarMaterial(),
    accent: state.accent ?? currentThemeAccent(),
  }));
  ipcMain.handle("app:set-mode", (_event, next) => {
    applyMode(next === "interactive" ? "interactive" : "passive");
    return mode;
  });
  ipcMain.handle("app:quit", () => app.quit());

  ipcMain.handle("brain:chat", (_event, text) => {
    if (typeof text !== "string" || !text.trim()) return;
    runChat(text.trim());
  });
  ipcMain.handle("brain:task", (_event, kind, text, target) => {
    if (typeof text !== "string" || !text.trim()) return;
    noteInteraction();
    startTask(
      kind === "correct" ? "correct" : "translate",
      text.trim(),
      target === "en" || target === "es" ? target : undefined,
      (event) => win?.webContents.send("brain:event", event),
      interfaceLanguage(),
    );
  });
  ipcMain.handle("brain:cancel", () => cancelChat());
  ipcMain.handle("app:command", (_event, raw) => {
    if (typeof raw !== "string" || !raw.trim()) return { ok: false, message: "" };
    return runAppCommand(raw);
  });
  ipcMain.handle("tools:confirm", (_event, id, accepted) => confirmAction(id, accepted));
  ipcMain.handle("brain:history", () => getHistory());

  ipcMain.handle("voice:speak", async (_event, text) => {
    if (state.muted || typeof text !== "string" || !text.trim()) return null;
    const result = await synthesize(text.trim());
    return result ? { wav: result.wav, lang: result.lang } : null;
  });
  ipcMain.handle("voice:status", () => voiceStatus());
  ipcMain.handle("brain:reset", () => {
    resetHistory();
    return [];
  });
}

/* --------------------------------------------------------------- bootstrap */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", toggleMode);

  app.whenReady().then(() => {
    // Hyprland warps the pointer on focus changes; keep it still.
    enableNoWarps();

    createWindow();
    startControlServer();
    registerHotkeys();
    registerIpc();

    // Give Hyprland time to map the surface before handing focus back.
    setTimeout(() => applyMode("passive"), 900);

    // Dim the avatar while the session is locked.
    let lastLocked = null;
    setInterval(() => {
      const locked = sessionLocked();
      if (locked === null || locked === lastLocked) return;
      lastLocked = locked;
      win?.webContents.send("session:locked", locked);
    }, 10_000);

    void loadUserTools();
    setReminderNotifier((event) => win?.webContents.send("beat:event", event));
    resumeReminders();

    // Warm the model and its prompt cache while the overlay boots, then the
    // speech recogniser, so the first push-to-talk is not slow.
    setTimeout(
      () =>
        void warmup((active) => {
          warming = active;
          win?.webContents.send("brain:warm", active);
        }).finally(() => {
          void warmTranscription().catch((error) =>
            console.info("[baldborg] stt warm-up skipped:", error.message),
          );
        }),
      2_500,
    );

    if (process.env.VITE_DEV_SERVER_URL) {
      win?.webContents.openDevTools({ mode: "detach" });
    }
  });

  app.on("will-quit", () => {
    stopBeats();
    stopEpicWatch();
    beatsRunning = false;
    stopVoice();
    restoreNoWarps();
    globalShortcut.unregisterAll();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!win) createWindow();
  });
}
