const { contextBridge, ipcRenderer } = require("electron");

const args = process.argv.filter((value) => value.startsWith("--embuddies-"));
const subscriptions = new Map();
let sequence = 0;
ipcRenderer.on("embuddies:runtime-event", (_event, id, detail) =>
  subscriptions.get(id)?.(detail),
);

contextBridge.exposeInMainWorld("EMBUDDIES_DESKTOP", {
  args,
  request: async (request, onEvent) => {
    const id = String(++sequence);
    if (onEvent) subscriptions.set(id, onEvent);
    try {
      return await ipcRenderer.invoke("embuddies:runtime", request, id);
    } finally {
      subscriptions.delete(id);
    }
  },
  runtimeStatus: () => ipcRenderer.invoke("embuddies:runtime-status"),
  retryRuntime: () => ipcRenderer.invoke("embuddies:runtime-retry"),
  exportDiagnostics: () => ipcRenderer.invoke("embuddies:diagnostics"),
  onHostState: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("embuddies:host-state", listener);
    return () => ipcRenderer.removeListener("embuddies:host-state", listener);
  },
  invoke: (method, values = []) =>
    ipcRenderer.invoke("embuddies:host", method, values),
  onEvent: (callback) => {
    const listener = (_event, name, detail) => callback(name, detail);
    ipcRenderer.on("embuddies:event", listener);
    return () => ipcRenderer.removeListener("embuddies:event", listener);
  },
});
