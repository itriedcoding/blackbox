const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("blackbox", {
  system: {
    info: () => ipcRenderer.invoke("system:info"),
    openModelsFolder: () => ipcRenderer.invoke("system:open-models-folder"),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
  catalog: {
    list: () => ipcRenderer.invoke("catalog:list"),
  },
  hf: {
    search: (request) => ipcRenderer.invoke("hf:search", request),
    files: (request) => ipcRenderer.invoke("hf:files", request),
  },
  downloads: {
    start: (request) => ipcRenderer.invoke("downloads:start", request),
    cancel: (id) => ipcRenderer.invoke("downloads:cancel", id),
    list: () => ipcRenderer.invoke("downloads:list"),
    onProgress: subscribe("downloads:progress"),
    onComplete: subscribe("downloads:complete"),
  },
  models: {
    local: () => ipcRenderer.invoke("models:local"),
    fit: (request) => ipcRenderer.invoke("models:fit", request),
    remove: (path) => ipcRenderer.invoke("models:delete", path),
    reveal: (path) => ipcRenderer.invoke("models:reveal", path),
    import: () => ipcRenderer.invoke("models:import"),
  },
  engine: {
    status: () => ipcRenderer.invoke("engine:status"),
    load: (request) => ipcRenderer.invoke("engine:load", request),
    unload: () => ipcRenderer.invoke("engine:unload"),
    stop: () => ipcRenderer.invoke("engine:stop"),
    onProgress: subscribe("engine:progress"),
  },
  chat: {
    start: (request) => ipcRenderer.invoke("chat:start", request),
    stop: () => ipcRenderer.invoke("chat:stop"),
    onDelta: subscribe("chat:delta"),
  },
  chats: {
    list: () => ipcRenderer.invoke("chats:list"),
    get: (id) => ipcRenderer.invoke("chats:get", id),
    save: (chat) => ipcRenderer.invoke("chats:save", chat),
    remove: (id) => ipcRenderer.invoke("chats:delete", id),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    onState: subscribe("window:state"),
  },
});
