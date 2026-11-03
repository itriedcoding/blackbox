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
  updates: {
    check: () => ipcRenderer.invoke("updates:check"),
    download: (manifest) => ipcRenderer.invoke("updates:download", manifest),
    install: () => ipcRenderer.invoke("updates:install"),
    cancel: () => ipcRenderer.invoke("updates:cancel"),
    onProgress: subscribe("updates:progress"),
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
  site: {
    export: (request) => ipcRenderer.invoke("site:export", request),
    openFolder: (dir) => ipcRenderer.invoke("site:open-folder", dir),
    deploy: (dir) => ipcRenderer.invoke("site:deploy", dir),
    onDeployLog: subscribe("site:deploy-log"),
  },
  api: {
    status: () => ipcRenderer.invoke("api:status"),
    sync: () => ipcRenderer.invoke("api:sync"),
    keys: () => ipcRenderer.invoke("api:keys"),
    createKey: (name) => ipcRenderer.invoke("api:create-key", name),
    revokeKey: (id) => ipcRenderer.invoke("api:revoke-key", id),
  },
  training: {
    env: () => ipcRenderer.invoke("training:env"),
    provision: () => ipcRenderer.invoke("training:provision"),
    pickDataset: () => ipcRenderer.invoke("training:pick-dataset"),
    start: (request) => ipcRenderer.invoke("training:start", request),
    stop: () => ipcRenderer.invoke("training:stop"),
    merge: (request) => ipcRenderer.invoke("training:merge", request),
    onLog: subscribe("training:log"),
    onProgress: subscribe("training:progress"),
  },
  ide: {
    state: () => ipcRenderer.invoke("ide:state"),
    pickFolder: () => ipcRenderer.invoke("ide:pick-folder"),
    openFolder: (dir) => ipcRenderer.invoke("ide:open-folder", dir),
    tree: () => ipcRenderer.invoke("ide:tree"),
    read: (path) => ipcRenderer.invoke("ide:read", path),
    readMany: (request) => ipcRenderer.invoke("ide:read-many", request),
    write: (request) => ipcRenderer.invoke("ide:write", request),
    create: (request) => ipcRenderer.invoke("ide:create", request),
    rename: (request) => ipcRenderer.invoke("ide:rename", request),
    remove: (path) => ipcRenderer.invoke("ide:remove", path),
    language: (path) => ipcRenderer.invoke("ide:language", path),
    reveal: (path) => ipcRenderer.invoke("ide:reveal", path),
    generate: (request) => ipcRenderer.invoke("ide:generate", request),
    apply: (request) => ipcRenderer.invoke("ide:apply", request),
    discard: () => ipcRenderer.invoke("ide:discard"),
    build: (request) => ipcRenderer.invoke("ide:build", request),
    buildStop: () => ipcRenderer.invoke("ide:build-stop"),
    onGenerateDelta: subscribe("codegen:delta"),
    onBuildDelta: subscribe("build:delta"),
    onBuildProgress: subscribe("build:progress"),
    onBuildRound: subscribe("build:round"),
  },
  terminal: {
    start: (request) => ipcRenderer.invoke("term:start", request),
    write: (id, data) => ipcRenderer.invoke("term:write", { id, data }),
    resize: (id) => ipcRenderer.invoke("term:resize", id),
    kill: (id) => ipcRenderer.invoke("term:kill", id),
    list: () => ipcRenderer.invoke("term:list"),
    onData: subscribe("term:data"),
    onExit: subscribe("term:exit"),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    onState: subscribe("window:state"),
  },
});
