const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("baldborg", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  setMode: (mode) => ipcRenderer.invoke("app:set-mode", mode),
  quit: () => ipcRenderer.invoke("app:quit"),

  speak: (text) => ipcRenderer.invoke("voice:speak", text),
  voiceStatus: () => ipcRenderer.invoke("voice:status"),
  sendMessage: (text) => ipcRenderer.invoke("brain:chat", text),
  cancelChat: () => ipcRenderer.invoke("brain:cancel"),
  confirmTool: (id, accepted) => ipcRenderer.invoke("tools:confirm", id, accepted),
  getHistory: () => ipcRenderer.invoke("brain:history"),
  resetMemory: () => ipcRenderer.invoke("brain:reset"),
  runCommand: (text) => ipcRenderer.invoke("app:command", text),

  onModeChanged: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on("mode:changed", listener);
    return () => ipcRenderer.removeListener("mode:changed", listener);
  },
  onAutoSpeak: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("voice:autoSpeak", listener);
    return () => ipcRenderer.removeListener("voice:autoSpeak", listener);
  },
  onMaterial: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("avatar:material", listener);
    return () => ipcRenderer.removeListener("avatar:material", listener);
  },
  onLanguage: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("language:changed", listener);
    return () => ipcRenderer.removeListener("language:changed", listener);
  },
  onEffects: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("voice:effects", listener);
    return () => ipcRenderer.removeListener("voice:effects", listener);
  },
  onMutedChanged: (callback) => {
    const listener = (_event, muted) => callback(muted);
    ipcRenderer.on("audio:muted", listener);
    return () => ipcRenderer.removeListener("audio:muted", listener);
  },
  onLocked: (callback) => {
    const listener = (_event, locked) => callback(locked);
    ipcRenderer.on("session:locked", listener);
    return () => ipcRenderer.removeListener("session:locked", listener);
  },
  onWarm: (callback) => {
    const listener = (_event, active) => callback(active);
    ipcRenderer.on("brain:warm", listener);
    return () => ipcRenderer.removeListener("brain:warm", listener);
  },
  onAccent: (callback) => {
    const listener = (_event, color) => callback(color);
    ipcRenderer.on("theme:accent", listener);
    return () => ipcRenderer.removeListener("theme:accent", listener);
  },
  onWindowFocus: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("window:focus", listener);
    return () => ipcRenderer.removeListener("window:focus", listener);
  },
  onListenState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("listen:state", listener);
    return () => ipcRenderer.removeListener("listen:state", listener);
  },
  onBeat: (callback) => {
    const listener = (_event, beat) => callback(beat);
    ipcRenderer.on("beat:event", listener);
    return () => ipcRenderer.removeListener("beat:event", listener);
  },
  onGlitch: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("fx:glitch", listener);
    return () => ipcRenderer.removeListener("fx:glitch", listener);
  },
  onVoiceReplay: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("voice:replay", listener);
    return () => ipcRenderer.removeListener("voice:replay", listener);
  },
  onBrainEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("brain:event", listener);
    return () => ipcRenderer.removeListener("brain:event", listener);
  },
});
