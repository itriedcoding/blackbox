/**
 * IPC surface for the three studio features: publishing a site, exposing the
 * local API, and fine-tuning. Kept out of main.js so the window/chat wiring
 * stays readable.
 */

import fs from "node:fs";
import path from "node:path";
import { app, dialog, ipcMain, shell } from "electron";
import * as store from "./store.js";
import * as engine from "./engine.js";
import { ApiKeyStore } from "./apikeys.js";
import { createApiServer } from "./api-server.js";
import { exportSite, deployToVercel, defaultConfig } from "./site-export.js";
import { parseDataset, writeTrainingJsonl } from "./dataset.js";
import {
  detectPython,
  inspectEnvironment,
  provisionEnvironment,
  train,
  stopTraining,
  convertAdapterToGguf,
  mergeAdapterToGguf,
} from "./trainer.js";

export async function registerStudio({ send }) {
  const root = app.getPath("userData");
  const keyStore = new ApiKeyStore(path.join(root, "api-keys.json"));
  const api = createApiServer({
    engine,
    keyStore,
    getConfig: () => {
      const settings = store.readSettings();
      return {
        systemPrompt: settings.systemPrompt,
        requireKey: settings.apiRequireKey,
        rateLimit: settings.apiRateLimit,
      };
    },
  });

  async function syncApi() {
    const settings = store.readSettings();
    if (!settings.apiEnabled) {
      await api.stop();
      return api.status();
    }
    const current = api.status();
    const wantedHost = settings.apiLan ? "0.0.0.0" : "127.0.0.1";
    if (current.running && current.port === settings.apiPort && current.host === wantedHost) return current;
    await api.stop();
    try {
      return await api.start({ port: settings.apiPort, host: wantedHost });
    } catch (error) {
      send("api:error", { message: `Could not start the API on port ${settings.apiPort}: ${error.message}` });
      return api.status();
    }
  }

  ipcMain.handle("api:status", async () => ({ ...api.status(), settings: store.readSettings() }));
  ipcMain.handle("api:sync", () => syncApi());
  ipcMain.handle("api:keys", () => keyStore.list());
  ipcMain.handle("api:create-key", (_event, name) => {
    const created = keyStore.create(name);
    return created;
  });
  ipcMain.handle("api:revoke-key", (_event, id) => keyStore.revoke(id));

  ipcMain.handle("site:export", async (_event, request = {}) => {
    const settings = store.readSettings();
    const title = String(request.title ?? settings.siteTitle ?? "Blackbox").trim() || "Blackbox";
    const outDir = String(request.outDir ?? "").trim() || path.join(root, "sites", title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "site");
    const config = defaultConfig({
      title,
      modelUrl: request.modelUrl ?? settings.siteModelUrl,
      modelName: request.modelName ?? "",
      systemPrompt: request.systemPrompt ?? settings.systemPrompt,
      contextSize: settings.contextSize,
    });
    const result = exportSite({ outDir, config, overwrite: true });
    store.writeSettings({ siteOutDir: result.dir, siteTitle: title, siteModelUrl: config.modelUrl });
    return result;
  });

  ipcMain.handle("site:open-folder", async (_event, dir) => {
    const target = String(dir ?? store.readSettings().siteOutDir ?? "");
    if (!target) return false;
    await shell.openPath(target);
    return true;
  });

  ipcMain.handle("site:deploy", async (_event, dir) => {
    const target = String(dir ?? store.readSettings().siteOutDir ?? "");
    const result = await deployToVercel({
      dir: target,
      onLog: (line) => send("site:deploy-log", { line }),
    });
    return result;
  });

  let datasetCache = null;

  ipcMain.handle("training:env", () => {
    const python = detectPython();
    const settings = store.readSettings();
    const venvPython = path.join(root, "trainer", "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const effective = fs.existsSync(venvPython) ? venvPython : python?.command ?? null;
    const env = inspectEnvironment(effective);
    return { ...env, detected: python, venvPython: fs.existsSync(venvPython) ? venvPython : null, settings };
  });

  ipcMain.handle("training:provision", async () => {
    const python = detectPython();
    if (!python) throw new Error("Install Python 3.9 or newer first (python.org or the Microsoft Store).");
    const venvDir = path.join(root, "trainer", "venv");
    const result = await provisionEnvironment({
      python: python.command,
      venvDir,
      onLog: (line) => send("training:log", { line }),
    });
    return result;
  });

  ipcMain.handle("training:pick-dataset", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a fine-tuning dataset",
      properties: ["openFile"],
      filters: [
        { name: "Dataset", extensions: ["jsonl", "json", "txt", "md"] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    const parsed = parseDataset(file);
    datasetCache = { file, ...parsed };
    return { file, stats: parsed.stats, preview: parsed.examples.slice(0, 3) };
  });

  ipcMain.handle("training:prepare", async () => {
    if (!datasetCache) throw new Error("Choose a dataset first.");
    const dir = path.join(root, "trainer", "runs");
    fs.mkdirSync(dir, { recursive: true });
    const outFile = path.join(dir, `dataset-${Date.now()}.jsonl`);
    const written = writeTrainingJsonl({ examples: datasetCache.examples, outFile });
    return { ...written, format: datasetCache.stats.format, stats: datasetCache.stats };
  });

  ipcMain.handle("training:start", async (_event, request = {}) => {
    if (!datasetCache) throw new Error("Choose a dataset first.");
    const settings = store.readSettings();
    const python = request.python || detectPython()?.command;
    const prepared = writeTrainingJsonl({
      examples: datasetCache.examples,
      outFile: path.join(root, "trainer", "runs", `dataset-${Date.now()}.jsonl`),
    });
    const outDir = path.join(root, "trainer", "adapters", `adapter-${Date.now()}`);
    const result = await train({
      python,
      model: request.baseModel || settings.trainBaseModel,
      data: prepared.file,
      outDir,
      rank: Number(request.rank ?? settings.trainRank),
      alpha: Number(request.alpha ?? settings.trainAlpha),
      lr: Number(request.lr ?? settings.trainLr),
      epochs: Number(request.epochs ?? 1),
      maxSteps: Number(request.maxSteps ?? settings.trainSteps),
      seqLen: Number(request.seqLen ?? settings.trainSeqLen),
      batchSize: Number(request.batchSize ?? settings.trainBatch),
      gradAccum: Number(request.gradAccum ?? settings.trainGradAccum),
      threads: Number(settings.threads ?? 0),
      onLog: (line) => send("training:log", { line }),
      onProgress: (progress) => send("training:progress", progress),
    });
    store.writeSettings({ lastAdapterDir: result.adapterDir });
    return result;
  });

  ipcMain.handle("training:stop", () => stopTraining());

  ipcMain.handle("training:convert", async (_event, request = {}) => {
    const settings = store.readSettings();
    const python = request.python || detectPython()?.command;
    const adapterDir = String(request.adapterDir ?? settings.lastAdapterDir ?? "");
    if (!adapterDir || !fs.existsSync(adapterDir)) throw new Error("Train an adapter first.");
    const gguf = await convertAdapterToGguf({
      python,
      adapterDir,
      baseModelId: request.baseModel || settings.trainBaseModel,
      cacheDir: path.join(root, "trainer"),
      onLog: (line) => send("training:log", { line }),
    });
    return gguf;
  });

  ipcMain.handle("training:merge", async (_event, request = {}) => {
    const settings = store.readSettings();
    const python = request.python || detectPython()?.command;
    const adapterDir = String(request.adapterDir ?? settings.lastAdapterDir ?? "");
    if (!adapterDir || !fs.existsSync(adapterDir)) throw new Error("Train an adapter first.");
    const result = await mergeAdapterToGguf({
      python,
      adapterDir,
      baseModelId: request.baseModel || settings.trainBaseModel,
      cacheDir: path.join(root, "trainer"),
      onLog: (line) => send("training:log", { line }),
    });
    const target = path.join(store.modelsDirectory(settings), `fine-tuned-${Date.now()}.gguf`);
    fs.copyFileSync(result.file, target);
    fs.writeFileSync(`${target}.json`, JSON.stringify({ repo: null, path: path.basename(target), size: fs.statSync(target).size, trainedAt: new Date().toISOString() }, null, 2));
    return { ...result, modelPath: target };
  });

  app.whenReady().then(() => {
    syncApi().catch(() => {});
  });

  return { api, syncApi };
}
