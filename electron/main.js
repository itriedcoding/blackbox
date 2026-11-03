import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";

import * as store from "./lib/store.js";
import * as hf from "./lib/hf.js";
import * as engine from "./lib/engine.js";
import { systemInfo, threadOptions } from "./lib/system.js";
import { CURATED_MODELS } from "./lib/catalog.js";
import { DownloadManager } from "./lib/downloads.js";
import {
  describeQuant,
  estimateTotalBytes,
  formatBytes,
  pickRecommendedFile,
  ramBudget,
} from "./lib/quant.js";
import { readGgufInfo } from "./lib/gguf.js";
import { registerStudio } from "./lib/studio-ipc.js";
import { registerIde } from "./lib/ide-ipc.js";
import * as updates from "./lib/updates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes("--dev");

let mainWindow = null;

const ggufCache = new Map(); // path -> { mtimeMs, info }
const catalogCache = { at: 0, key: null, value: null };

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function memoryPicture() {
  const { totalMem, freeMem } = systemInfo();
  return { totalMem, freeMem, budget: ramBudget({ totalMem, freeMem }) };
}

function readGgufCached(filePath) {
  const stat = fs.statSync(filePath);
  const hit = ggufCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.info;
  const info = readGgufInfo(filePath);
  ggufCache.set(filePath, { mtimeMs: stat.mtimeMs, info });
  return info;
}

function scanLocalModels() {
  const settings = store.readSettings();
  const root = store.modelsDirectory(settings);
  const found = [];

  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && /\.gguf$/i.test(entry.name)) {
        const stat = fs.statSync(full);
        let sidecar = null;
        try {
          sidecar = JSON.parse(fs.readFileSync(`${full}.json`, "utf8"));
        } catch {
          sidecar = null;
        }
        let info = null;
        try {
          info = readGgufCached(full);
        } catch {
          info = null;
        }
        found.push({
          path: full,
          filename: entry.name,
          relative: path.relative(root, full),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          repo: sidecar?.repo ?? null,
          repoFile: sidecar?.path ?? null,
          quant: sidecar?.path ? hf.quantFromFilename(sidecar.path) : hf.quantFromFilename(entry.name),
          architecture: info?.architecture ?? null,
          blockCount: info?.blockCount ?? null,
          contextLength: info?.contextLength ?? null,
          kvBytesPerToken: info?.kvBytesPerToken ?? null,
        });
      }
    }
  };

  walk(root);
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

const downloads = new DownloadManager({
  onProgress: (payload) => send("downloads:progress", payload),
  onComplete: (payload) => {
    ggufCache.delete(payload.target);
    send("downloads:complete", payload);
  },
});

async function buildCatalog() {
  const settings = store.readSettings();
  const memory = memoryPicture();
  const key = `${settings.hfToken ? "t" : "a"}:${Math.round(memory.budget / (64 * 1024 * 1024))}`;
  if (catalogCache.value && catalogCache.key === key && Date.now() - catalogCache.at < 10 * 60 * 1000) {
    return catalogCache.value;
  }

  const entries = await Promise.all(
    CURATED_MODELS.map(async (model) => {
      try {
        const files = await hf.listGgufFiles(model.repo, { token: settings.hfToken || undefined });
        const recommended = pickRecommendedFile(files, memory.budget);
        return {
          ...model,
          available: true,
          files,
          recommendedQuant: recommended.file?.quant ?? null,
          recommendedSize: recommended.file?.size ?? null,
          fits: recommended.fits,
          fitNote: recommended.reason,
          error: null,
        };
      } catch (error) {
        return {
          ...model,
          available: false,
          files: [],
          recommendedQuant: null,
          recommendedSize: null,
          fits: false,
          fitNote: null,
          error: error.message,
        };
      }
    }),
  );

  const value = { entries, memory, generatedAt: new Date().toISOString() };
  catalogCache.value = value;
  catalogCache.key = key;
  catalogCache.at = Date.now();
  return value;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: "#070707",
    title: "Blackbox",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  const emitState = () => send("window:state", { maximized: mainWindow?.isMaximized() ?? false });
  mainWindow.on("maximize", emitState);
  mainWindow.on("unmaximize", emitState);
  mainWindow.on("enter-full-screen", emitState);
  mainWindow.on("leave-full-screen", emitState);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    if (target.protocol !== "file:") event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------- IPC: system

ipcMain.handle("system:info", () => {
  const settings = store.readSettings();
  return {
    ...systemInfo(),
    version: app.getVersion(),
    memory: memoryPicture(),
    threadOptions: threadOptions(),
    engineVersion: engine.engineVersion,
    settings,
    defaultSettings: store.DEFAULT_SETTINGS,
    paths: { models: store.modelsDirectory(settings), root: store.paths.root },
    platform: process.platform,
  };
});

ipcMain.handle("system:open-models-folder", async () => {
  const dir = store.modelsDirectory();
  await shell.openPath(dir);
  return dir;
});

ipcMain.handle("app:open-external", async (_event, url) => {
  if (typeof url === "string" && /^https:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// --------------------------------------------------------------- IPC: updates

let updateDownload = null;
let updateReady = null;

ipcMain.handle("updates:check", async () => updates.checkForUpdate({ currentVersion: app.getVersion() }));

ipcMain.handle("updates:download", async (event, manifest) => {
  if (updateDownload) throw new Error("An update is already downloading.");
  const verified = updates.normalizeManifest(manifest);
  const destination = path.join(app.getPath("temp"), `Blackbox-update-${verified.version}.exe`);
  const controller = new AbortController();
  updateDownload = controller;
  updateReady = null;

  try {
    const result = await updates.downloadUpdate({
      manifest: verified,
      destination,
      signal: controller.signal,
      onProgress: (payload) => {
        if (!event.sender.isDestroyed()) event.sender.send("updates:progress", { version: verified.version, ...payload });
      },
    });
    updateReady = { ...result, version: verified.version };
    return { version: verified.version, path: result.path, bytes: result.bytes, sha256: result.sha256 };
  } finally {
    updateDownload = null;
  }
});

ipcMain.handle("updates:cancel", () => {
  if (!updateDownload) return false;
  updateDownload.abort();
  return true;
});

/**
 * Installs the verified download. The running app holds its own .exe open, so a
 * detached PowerShell waits for this process to exit, runs the NSIS installer in
 * silent mode, then starts the new build. Nothing else is downloaded and the
 * installer path is the one this process wrote and hashed, never one the window
 * supplied.
 */
ipcMain.handle("updates:install", async () => {
  if (process.platform !== "win32") throw new Error("In-app updates install the Windows build only.");
  if (!app.isPackaged) throw new Error("Updates install only in the packaged app, not in a development run.");
  if (!updateReady) throw new Error("No verified update is waiting. Check for updates first.");

  const digest = await updates.sha256File(updateReady.path);
  if (digest !== updateReady.sha256) {
    updateReady = null;
    throw new Error("The downloaded installer changed on disk after it was verified, so it will not be run.");
  }

  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    "Start-Sleep -Milliseconds 700",
    `Start-Process -FilePath ${quote(updateReady.path)} -ArgumentList '/S' -Wait`,
    `Start-Process -FilePath ${quote(process.execPath)}`,
  ].join("; ");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  setTimeout(() => app.quit(), 300);
  return { installing: true, version: updateReady.version };
});

// -------------------------------------------------------------- IPC: settings

ipcMain.handle("settings:get", () => store.readSettings());

ipcMain.handle("settings:set", (_event, patch) => {
  const allowed = {};
  const incoming = patch ?? {};
  for (const key of Object.keys(store.DEFAULT_SETTINGS)) {
    if (key in incoming) allowed[key] = incoming[key];
  }
  if (allowed.threads !== undefined) {
    allowed.threads = Math.min(32, Math.max(1, Math.round(Number(allowed.threads) || 4)));
  }
  if (allowed.contextSize !== undefined) {
    const size = Math.round(Number(allowed.contextSize) || 4096);
    allowed.contextSize = Math.min(32768, Math.max(512, size));
  }
  if (allowed.maxTokens !== undefined) {
    allowed.maxTokens = Math.min(4096, Math.max(16, Math.round(Number(allowed.maxTokens) || 512)));
  }
  if (allowed.temperature !== undefined) {
    allowed.temperature = Math.min(2, Math.max(0, Number(allowed.temperature)));
  }
  if (allowed.topP !== undefined) {
    allowed.topP = Math.min(1, Math.max(0.05, Number(allowed.topP)));
  }
  if (allowed.hfToken !== undefined) {
    allowed.hfToken = String(allowed.hfToken ?? "").trim();
  }
  const next = store.writeSettings(allowed);
  catalogCache.at = 0;
  return next;
});

// ------------------------------------------------------------ IPC: Hugging Face

ipcMain.handle("catalog:list", () => buildCatalog());

ipcMain.handle("hf:search", async (_event, request = {}) => {
  const settings = store.readSettings();
  const token = String(request.token ?? settings.hfToken ?? "").trim() || undefined;
  const results = await hf.searchModels({
    query: request.query ?? "",
    token,
    limit: request.limit ?? 30,
    uncensoredOnly: Boolean(request.uncensoredOnly),
  });
  return { results };
});

ipcMain.handle("hf:files", async (_event, request = {}) => {
  const settings = store.readSettings();
  const token = String(request.token ?? settings.hfToken ?? "").trim() || undefined;
  const repo = hf.normalizeRepoId(request.repo);
  if (!repo) throw new Error("Enter a repository ID like owner/model-name.");
  const info = await hf.getRepoInfo(repo, { token });
  const files = await hf.listGgufFiles(repo, { token });
  const memory = memoryPicture();
  const recommended = pickRecommendedFile(files, memory.budget);
  return {
    repo: info,
    files: files.map((file) => ({
      ...file,
      quality: describeQuant(file.quant),
      estimate: null,
    })),
    recommendedPath: recommended.file?.path ?? null,
    fits: recommended.fits,
    fitNote: recommended.reason,
    memory,
  };
});

function requireToken(override) {
  const settings = store.readSettings();
  return String(override ?? settings.hfToken ?? "").trim() || undefined;
}

// -------------------------------------------------------------- IPC: downloads

ipcMain.handle("downloads:start", async (_event, request = {}) => {
  const settings = store.readSettings();
  const repo = hf.normalizeRepoId(request.repo);
  if (!repo) throw new Error("Invalid repository id.");
  const info = await downloads.start({
    repo,
    path: request.path,
    size: request.size,
    token: requireToken(request.token),
    modelsDir: store.modelsDirectory(settings),
  });
  return info;
});

ipcMain.handle("downloads:cancel", (_event, id) => downloads.cancel(id));

ipcMain.handle("downloads:list", () => downloads.list());

// ----------------------------------------------------------------- IPC: models

ipcMain.handle("models:local", () => scanLocalModels());

ipcMain.handle("models:fit", (_event, request = {}) => {
  const settings = store.readSettings();
  const contextSize = Number(request.contextSize ?? settings.contextSize);
  const memory = memoryPicture();
  const info = readGgufCached(request.path);
  const estimated = estimateTotalBytes(info.fileSize, info, contextSize);
  return {
    estimated,
    budget: memory.budget,
    fits: estimated <= memory.budget,
    fileSize: info.fileSize,
    kvBytesPerToken: info.kvBytesPerToken,
    architecture: info.architecture,
    contextLength: info.contextLength,
    blockCount: info.blockCount,
    estimatedKv: estimated - info.fileSize * 1.04,
    message:
      estimated <= memory.budget
        ? `Needs ~${formatBytes(estimated)} of the ${formatBytes(memory.budget)} available for model + context.`
        : `Needs ~${formatBytes(estimated)} but only ${formatBytes(memory.budget)} is available. Lower the context size or pick a smaller quant.`,
  };
});

ipcMain.handle("models:delete", async (_event, target) => {
  const settings = store.readSettings();
  const root = path.resolve(store.modelsDirectory(settings));
  const file = path.resolve(String(target));
  if (!file.startsWith(root + path.sep) || !/\.gguf$/i.test(file)) {
    throw new Error("Refusing to delete a file outside the model folder.");
  }
  if (engine.status().modelPath === file) await engine.unload();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.json`, { force: true });
  ggufCache.delete(file);
  return true;
});

ipcMain.handle("models:reveal", async (_event, target) => {
  shell.showItemInFolder(String(target));
  return true;
});

ipcMain.handle("models:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Add a GGUF model",
    properties: ["openFile"],
    filters: [{ name: "GGUF model", extensions: ["gguf"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const source = result.filePaths[0];
  const settings = store.readSettings();
  const root = store.modelsDirectory(settings);
  const target = path.join(root, path.basename(source));

  if (path.resolve(source) !== path.resolve(target)) {
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(
    `${target}.json`,
    JSON.stringify({ repo: null, path: path.basename(source), size: fs.statSync(target).size, importedAt: new Date().toISOString() }, null, 2),
  );
  ggufCache.delete(target);
  return target;
});

// ----------------------------------------------------------------- IPC: engine

ipcMain.handle("engine:status", () => engine.status());

ipcMain.handle("engine:load", async (_event, request = {}) => {
  const settings = store.readSettings();
  const modelPath = String(request.modelPath ?? "");
  if (!fs.existsSync(modelPath)) throw new Error("Model file no longer exists. Download it again.");
  const contextSize = Number(request.contextSize ?? settings.contextSize);
  const threads = Number(request.threads ?? settings.threads);
  const gpu = request.gpu ?? settings.gpu;

  if (!request.force) {
    const memory = memoryPicture();
    const info = readGgufCached(modelPath);
    const estimated = estimateTotalBytes(info.fileSize, info, contextSize);
    if (estimated > memory.budget) {
      return {
        blocked: true,
        estimated,
        budget: memory.budget,
        message: `This model plus a ${contextSize}-token context needs about ${formatBytes(estimated)}, but only ${formatBytes(memory.budget)} is available. Lower the context window or choose a smaller quant.`,
      };
    }
  }

  const result = await engine.load({
    modelPath,
    contextSize,
    threads,
    gpu,
    onProgress: (payload) => send("engine:progress", payload),
  });
  store.writeSettings({ activeModelPath: modelPath });
  return { blocked: false, status: result };
});

ipcMain.handle("engine:unload", async () => engine.unload());

ipcMain.handle("engine:stop", () => engine.stop());

// ------------------------------------------------------------------- IPC: chat

ipcMain.handle("chat:start", async (event, request = {}) => {
  try {
    const settings = store.readSettings();
    const result = await engine.chat({
      chatId: request.chatId,
      systemPrompt: request.systemPrompt ?? settings.systemPrompt,
      history: request.history ?? [],
      prompt: request.prompt,
      temperature: request.temperature ?? settings.temperature,
      topP: request.topP ?? settings.topP,
      topK: request.topK ?? 40,
      maxTokens: request.maxTokens ?? settings.maxTokens,
      onDelta: (chunk) => {
        if (!event.sender.isDestroyed()) event.sender.send("chat:delta", { chatId: request.chatId, text: chunk });
      },
    });
    return result;
  } catch (error) {
    throw new Error(error.message);
  }
});

ipcMain.handle("chat:stop", () => engine.stop());

// ------------------------------------------------------------------ IPC: chats

ipcMain.handle("chats:list", () => store.listChats());
ipcMain.handle("chats:get", (_event, id) => store.getChat(id));
ipcMain.handle("chats:save", (_event, chat) => {
  const saved = store.saveChat(chat);
  return { id: saved.id, updatedAt: saved.updatedAt, title: saved.title, messageCount: saved.messages.length };
});
ipcMain.handle("chats:delete", (_event, id) => store.deleteChat(id));

// --------------------------------------------------------------- IPC: window

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
  return true;
});

ipcMain.handle("window:maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
  return true;
});

// --------------------------------------------------------------- app lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    store.initStorage();
    createWindow();
    registerStudio({ send }).catch((error) => {
      console.error("Studio features failed to start:", error);
    });
    registerIde({ send, getWindow: () => mainWindow }).catch((error) => {
      console.error("Code workspace failed to start:", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", async () => {
    await engine.disposeAll().catch(() => {});
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", async () => {
    await engine.disposeAll().catch(() => {});
  });
}
