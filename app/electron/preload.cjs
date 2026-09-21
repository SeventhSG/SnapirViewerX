/** The only bridge between the page and the machine. Nothing else is exposed. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snapir", {
  pickScan: () => ipcRenderer.invoke("pick-scan"),
  readFile: (p) => ipcRenderer.invoke("read-file", p),
  saveFile: (opts) => ipcRenderer.invoke("save-file", opts),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  pathExists: (p) => ipcRenderer.invoke("path-exists", p),
  setTheme: (dark) => ipcRenderer.invoke("set-theme", dark),
  storeGet: (name) => ipcRenderer.invoke("store-get", name),
  storeSet: (name, value) => ipcRenderer.invoke("store-set", name, value),
  appInfo: () => ipcRenderer.invoke("app-info"),
  takeQueuedOpen: () => ipcRenderer.invoke("take-queued-open"),
  /** A .svxp or .ply double-clicked in the shell while the app was running. */
  onOpenFile: (fn) => {
    const handler = (_e, file) => fn(file);
    ipcRenderer.on("open-file", handler);
    return () => ipcRenderer.off("open-file", handler);
  },
});
