/**
 * Electron main process for the Delamain companion overlay.
 *
 * Phase 1 responsibilities:
 *  - transparent, frameless, always-on-top window that never steals focus
 *  - passive mode (clicks pass through) vs interactive mode (chat bar + drag)
 *  - control channel over a UNIX socket, driven by Hyprland keybindings
 *
 * Wayland owns window placement and focus, so the compositor (Hyprland) is the
 * authority: position and sizing come from config/hypr/delamain.lua, and focus
 * is handed back with a Hyprland dispatcher instead of win.blur().
 */

import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelChat, getHistory, resetHistory, startChat } from "./brain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The overlay is pixel-exact: Chromium's fractional scale (1.1875 on this
// setup) renders a larger buffer than the Wayland surface and the compositor
// crops it, which cut the bottom of the chat bar. Force CSS px == device px.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

/** Hyprland window class; it comes from package.json "name". */
const WM_CLASS = "delamain-desktop";

/** Passive mode only needs the head; interactive mode adds the chat bar. */
const SIZES = {
  passive: { width: 200, height: 270 },
  interactive: { width: 380, height: 460 },
};
/** Gap between the overlay and the monitor edge, in px. */
const EDGE_MARGIN = 24;

const STATE_DIR = join(homedir(), ".config", "delamain");
const STATE_FILE = join(STATE_DIR, "state.json");
const CONTROL_SOCKET = join(STATE_DIR, "control.sock");

const DEFAULT_STATE = {
  muted: false,
};

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;

let state = loadState();
let mode = "passive";

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
    console.warn("[delamain] could not restore cursor:no_warps");
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
  await hyprDispatch(`hl.dsp.window.move({ x = ${localX}, y = ${localY} })`);
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

/**
 * Resize the surface for the current mode while keeping the head visually
 * still: the horizontal centre and the top edge stay put, and the chat bar
 * grows out of the bottom of the window.
 */
async function applyWindowGeometry(next) {
  const size = SIZES[next] ?? SIZES.passive;
  const client = hyprlandClient();
  const monitor = monitorForClient(client);

  // Passive mode usually starts at the right size; skip the focus dance.
  if (
    mode === "passive" &&
    client?.size?.[0] === size.width &&
    client?.size?.[1] === size.height
  ) {
    return;
  }

  // Ask Chromium too, for compositors that honour client resize requests.
  win?.setSize(size.width, size.height);

  const workspace = activeWorkspaceId();

  // move/resize act on the active window; allow focus just for this.
  await setOverlayFocusable(true);
  await focusOverlay();
  await hyprDispatch(`hl.dsp.window.resize({ x = ${size.width}, y = ${size.height} })`);

  if (client?.at && monitor) {
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const headCenterX = client.at[0] + client.size[0] / 2;
    const globalX = clamp(
      Math.round(headCenterX - size.width / 2),
      monitor.x + EDGE_MARGIN,
      monitor.x + monitor.width - size.width - EDGE_MARGIN,
    );
    const globalY = clamp(
      client.at[1],
      monitor.y + EDGE_MARGIN,
      monitor.y + monitor.height - size.height - EDGE_MARGIN,
    );

    await hyprDispatch(
      `hl.dsp.window.move({ x = ${globalX - monitor.x}, y = ${globalY - monitor.y} })`,
    );
  }

  if (mode === "passive") {
    await setOverlayFocusable(false);
    focusPreviousOnWorkspace(workspace);
  }
}

/* ---------------------------------------------------------------- window -- */

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
    title: "Delamain",
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
  });

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
    console.error(`[delamain] preload failed (${path}):`, error.message);
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

  if (mode === "passive") {
    // Capture the workspace before touching focus: Hyprland may switch away
    // the moment the overlay stops being focusable.
    const workspace = activeWorkspaceId();
    win.setIgnoreMouseEvents(true, { forward: true });
    await setOverlayFocusable(false);
    focusPreviousOnWorkspace(workspace);
  } else {
    win.setIgnoreMouseEvents(false);

    // A pinned window keeps its home workspace; focusing it from another
    // workspace makes Hyprland jump there. Adopt the active workspace first.
    const workspace = activeWorkspaceId();
    const client = hyprlandClient();
    if (client && workspace !== null && client.workspace?.id !== workspace) {
      await hyprDispatch(
        `hl.dsp.window.move({ workspace = "${workspace}", window = "class:${WM_CLASS}" })`,
      );
    }

    await setOverlayFocusable(true);
    await focusOverlay();
  }

  win.webContents.send("mode:changed", mode);
  updateTrayMenu();
  applyWindowGeometry(mode);
}

function toggleMode() {
  applyMode(mode === "passive" ? "interactive" : "passive");
}

function setMuted(muted) {
  saveState({ muted });
  win?.webContents.send("audio:muted", muted);
  updateTrayMenu();
}

/* ------------------------------------------------------------------ tray -- */

function createTray() {
  try {
    const icon = nativeImage.createFromPath(join(__dirname, "tray.png"));
    tray = new Tray(icon);
    tray.setToolTip("Delamain");
    tray.on("click", toggleMode);
    updateTrayMenu();
  } catch (error) {
    console.warn("[delamain] tray unavailable:", error.message);
    tray = null;
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: mode === "passive" ? "Modo interactivo" : "Modo pasivo",
        accelerator: "Super+Alt+D",
        click: toggleMode,
      },
      {
        label: state.muted ? "Activar voz" : "Silenciar",
        accelerator: "Super+Alt+M",
        click: () => setMuted(!state.muted),
      },
      {
        label: "Olvidar conversación",
        click: () => {
          resetHistory();
          win?.webContents.send("brain:event", { type: "reset" });
        },
      },
      { type: "separator" },
      { label: "Salir", click: () => app.quit() },
    ]),
  );
}

/* --------------------------------------------------------------- hotkeys -- */
/* globalShortcut only works under X11; kept as a bonus. Hyprland keybindings
   (config/hypr/delamain.lua) are the primary path on Wayland. */

function registerHotkeys() {
  try {
    globalShortcut.register("Super+Alt+D", toggleMode);
    globalShortcut.register("Super+Alt+M", () => setMuted(!state.muted));
  } catch (error) {
    console.info("[delamain] globalShortcut unavailable (Wayland):", error.message);
  }
}

/* --------------------------------------------------------- control socket -- */

function handleCommand(command) {
  switch (command) {
    case "toggle":
      toggleMode();
      break;
    case "open":
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
          .then((image) => writeFileSync("/tmp/opencode/delamain-capture.png", image.toPNG()))
          .catch((error) => console.warn("[delamain] capture failed:", error.message));
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
      handleCommand(buffer.slice(0, newline).trim());
      connection.end();
    });
    connection.on("error", () => {});
  });

  server.on("error", (error) => console.warn("[delamain] control socket:", error.message));
  server.listen(CONTROL_SOCKET);

  app.on("will-quit", () => {
    server.close();
    rmSync(CONTROL_SOCKET, { force: true });
  });
}

/* --------------------------------------------------------------- ipc ----- */

function registerIpc() {
  ipcMain.handle("app:get-state", () => ({ mode, muted: state.muted }));
  ipcMain.handle("app:set-mode", (_event, next) => {
    applyMode(next === "interactive" ? "interactive" : "passive");
    return mode;
  });
  ipcMain.handle("app:quit", () => app.quit());

  ipcMain.handle("brain:chat", (_event, text) => {
    if (typeof text !== "string" || !text.trim()) return;
    startChat(text.trim(), (event) => win?.webContents.send("brain:event", event));
  });
  ipcMain.handle("brain:cancel", () => cancelChat());
  ipcMain.handle("brain:history", () => getHistory());
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
    createTray();
    startControlServer();
    registerHotkeys();
    registerIpc();

    // Give Hyprland time to map the surface before handing focus back.
    setTimeout(() => applyMode("passive"), 900);

    if (process.env.VITE_DEV_SERVER_URL) {
      win?.webContents.openDevTools({ mode: "detach" });
    }
  });

  app.on("will-quit", () => {
    restoreNoWarps();
    globalShortcut.unregisterAll();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!win) createWindow();
  });
}
