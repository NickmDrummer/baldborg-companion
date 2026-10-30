const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("delamain", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  setMode: (mode) => ipcRenderer.invoke("app:set-mode", mode),
  setSize: (width, height) => ipcRenderer.invoke("window:set-size", width, height),
  quit: () => ipcRenderer.invoke("app:quit"),
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
});
