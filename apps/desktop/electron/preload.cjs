const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("delamain", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  setMode: (mode) => ipcRenderer.invoke("app:set-mode", mode),
  quit: () => ipcRenderer.invoke("app:quit"),

  sendMessage: (text) => ipcRenderer.invoke("brain:chat", text),
  cancelChat: () => ipcRenderer.invoke("brain:cancel"),
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
  onBrainEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("brain:event", listener);
    return () => ipcRenderer.removeListener("brain:event", listener);
  },
});
