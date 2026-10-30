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

  onModeChanged: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on("mode:changed", listener);
    return () => ipcRenderer.removeListener("mode:changed", listener);
  },
  onMutedChanged: (callback) => {
    const listener = (_event, muted) => callback(muted);
    ipcRenderer.on("audio:muted", listener);
    return () => ipcRenderer.removeListener("audio:muted", listener);
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
