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

const __dirname = dirname(fileURLToPath(import.meta.url));

// The overlay is pixel-exact: Chromium's fractional scale (1.1875 on this
// setup) renders a larger buffer than the Wayland surface and the compositor
// crops it, which cut the bottom of the chat bar. Force CSS px == device px.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

/** Hyprland window class; it comes from package.json "name". */
const WM_CLASS = "delamain-desktop";

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
/** Address of the window that had focus before we opened the chat bar. */
let previousFocus = null;

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

function activeWindowAddress() {
  try {
    const active = JSON.parse(execFileSync("hyprctl", ["activewindow", "-j"], { timeout: 1500 }));
    if (!active?.address || active.class === WM_CLASS) return null;
    return active.address;
  } catch {
    return null;
  }
}

function focusWindow(address) {
  if (!address) return;
  hyprDispatch(`hl.dsp.focus({ window = "address:${address}" })`).then((ok) => {
    if (!ok) console.warn("[delamain] could not restore focus to", address);
  });
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
 * Hyprland applies the `move` window rule unreliably on this setup, so the
 * app re-checks its own position and asks the compositor to move it when it
 * does not match the expected bottom-right corner.
 */
function ensurePlacement() {
  const client = hyprlandClient();
  if (!client?.at) return;
  const monitor = hyprlandMonitors().find((entry) => entry.id === client.monitor);
  if (!monitor) return;

  const localX = monitor.width - 380 - 24;
  const localY = monitor.height - 300 - 24;
  const globalX = monitor.x + localX;
  const globalY = monitor.y + localY;

  if (Math.abs(client.at[0] - globalX) < 8 && Math.abs(client.at[1] - globalY) < 8) return;
  hyprDispatch(`hl.dsp.window.move({ x = ${localX}, y = ${localY} })`);
}

/* ---------------------------------------------------------------- window -- */

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
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

  // If Hyprland focuses us while passive, give focus back immediately.
  win.on("focus", () => {
    if (mode === "passive" && previousFocus) {
      setTimeout(() => focusWindow(previousFocus), 80);
    }
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
 * passive     -> clicks pass through, focus returns to the previous window
 * interactive -> accepts clicks, shows the chat bar, draggable
 */
function applyMode(next) {
  mode = next === "interactive" ? "interactive" : "passive";
  if (!win) return;

  if (mode === "passive") {
    win.setIgnoreMouseEvents(true, { forward: true });
    focusWindow(previousFocus);
  } else {
    previousFocus = activeWindowAddress() ?? previousFocus;
    win.setIgnoreMouseEvents(false);
    hyprDispatch(`hl.dsp.focus({ window = "class:${WM_CLASS}" })`);
  }

  win.webContents.send("mode:changed", mode);
  updateTrayMenu();
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
}

/* --------------------------------------------------------------- bootstrap */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", toggleMode);

  app.whenReady().then(() => {
    // Captured before our window exists, so it is the real previous focus.
    previousFocus = activeWindowAddress();

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

  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!win) createWindow();
  });
}
