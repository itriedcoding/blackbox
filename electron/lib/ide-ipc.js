/**
 * IPC for the code workspace: folder access, file editing, the shell, and
 * model-generated projects.
 *
 * Generated files never reach disk from the model's text directly. A reply is
 * parsed into a plan, the plan is held in memory, and files are written only
 * when the renderer asks for specific paths from that plan.
 */

import fs from "node:fs";
import path from "node:path";
import { app, dialog, ipcMain, shell } from "electron";
import * as store from "./store.js";
import * as engine from "./engine.js";
import { flattenFiles, listTree } from "./ide/tree.js";
import { ConflictError, createEntry, deleteEntry, readTextFile, renameEntry, statEntry, writeTextFile } from "./ide/files.js";
import { languageCount, languageFor } from "./ide/languages.js";
import { buildProjectPrompt, commentary, parseFileBlocks } from "./ide/prompt.js";
import { assertDirectory, resolveInside } from "./ide/safety.js";
import { ShellManager } from "./ide/shell.js";

const MAX_PLAN_FILES = 40;
const MAX_PLAN_BYTES = 2_000_000;

export async function registerIde({ send, getWindow }) {
  const state = { root: null };
  let plan = null;

  const shells = new ShellManager({
    onData: (payload) => send("term:data", payload),
    onExit: (payload) => send("term:exit", payload),
  });

  const settingsAtStart = store.readSettings();
  if (settingsAtStart.workspaceRoot && fs.existsSync(settingsAtStart.workspaceRoot)) {
    state.root = settingsAtStart.workspaceRoot;
  }

  function requireRoot() {
    if (!state.root) throw new Error("Open a folder first.");
    return state.root;
  }

  async function adoptRoot(dir) {
    const resolved = await assertDirectory(dir, "folder");
    state.root = resolved;
    const settings = store.readSettings();
    const recent = [resolved, ...(Array.isArray(settings.recentWorkspaces) ? settings.recentWorkspaces : [])]
      .filter((entry, index, list) => typeof entry === "string" && list.indexOf(entry) === index)
      .slice(0, 8);
    store.writeSettings({ workspaceRoot: resolved, recentWorkspaces: recent });
    return { root: resolved, recent };
  }

  ipcMain.handle("ide:state", () => {
    const settings = store.readSettings();
    if (!state.root && settings.workspaceRoot && fs.existsSync(settings.workspaceRoot)) {
      state.root = settings.workspaceRoot;
    }
    return {
      root: state.root,
      recent: settings.recentWorkspaces ?? [],
      model: engine.status(),
      languages: languageCount(),
      shells: shells.list(),
    };
  });

  ipcMain.handle("ide:pick-folder", async () => {
    const window = getWindow?.();
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return adoptRoot(result.filePaths[0]);
  });

  ipcMain.handle("ide:open-folder", async (_event, dir) => {
    if (!dir) return null;
    return adoptRoot(String(dir));
  });

  ipcMain.handle("ide:tree", async () => {
    const root = requireRoot();
    const listing = await listTree(root);
    return {
      root,
      name: listing.name,
      tree: listing.tree,
      truncated: listing.truncated,
      fileCount: flattenFiles(listing.tree, 100000).length,
    };
  });

  ipcMain.handle("ide:read", async (_event, relativePath) => {
    const root = requireRoot();
    return readTextFile(root, relativePath);
  });

  ipcMain.handle("ide:write", async (_event, request = {}) => {
    const root = requireRoot();
    return writeTextFile(root, request.path, request.content, { expectedMtimeMs: request.expectedMtimeMs ?? null });
  });

  ipcMain.handle("ide:create", async (_event, request = {}) => {
    const root = requireRoot();
    return createEntry(root, request.path, request.type === "dir" ? "dir" : "file");
  });

  ipcMain.handle("ide:rename", async (_event, request = {}) => {
    const root = requireRoot();
    return renameEntry(root, request.from, request.to);
  });

  ipcMain.handle("ide:remove", async (_event, relativePath) => {
    const root = requireRoot();
    const full = resolveInside(root, relativePath);
    const info = await statEntry(root, relativePath);
    if (!info) throw new Error(`"${relativePath}" no longer exists.`);
    // Hiding a file the user wanted gone but wants back is the safer default.
    try {
      await shell.trashItem(full);
      return { path: relativePath, type: info.isDirectory ? "dir" : "file", trashed: true };
    } catch {
      const removed = await deleteEntry(root, relativePath);
      return { ...removed, trashed: false };
    }
  });

  ipcMain.handle("ide:language", (_event, relativePath) => languageFor(relativePath));

  ipcMain.handle("ide:reveal", async (_event, relativePath) => {
    const root = requireRoot();
    shell.showItemInFolder(resolveInside(root, relativePath));
    return true;
  });

  ipcMain.handle("term:start", (_event, request = {}) => {
    const cwd = request.cwd ? path.resolve(String(request.cwd)) : state.root ?? app.getPath("home");
    return shells.start({ cwd });
  });

  ipcMain.handle("term:write", (_event, request = {}) => shells.write(request.id, request.data ?? ""));

  ipcMain.handle("term:resize", (_event, id) => shells.resize(id));

  ipcMain.handle("term:kill", (_event, id) => shells.kill(id));

  ipcMain.handle("term:list", () => shells.list());

  ipcMain.handle("ide:generate", async (event, request = {}) => {
    const root = requireRoot();
    const instruction = String(request.instruction ?? "").trim();
    if (!instruction) throw new Error("Describe what to build first.");

    const settings = store.readSettings();
    const listing = await listTree(root);

    const requested = Array.isArray(request.files) ? request.files.slice(0, 6) : [];
    const open = [];
    for (const relativePath of requested) {
      try {
        open.push(await readTextFile(root, relativePath));
      } catch {
        /* a file that vanished mid-request is simply not sent as context */
      }
    }

    const { systemPrompt, prompt } = buildProjectPrompt({
      instruction,
      tree: listing.tree,
      files: open,
      extraContext: String(request.context ?? ""),
    });

    plan = null;
    const result = await engine.chat({
      chatId: `code-${Date.now()}`,
      systemPrompt,
      prompt,
      temperature: Number(request.temperature ?? settings.codeTemperature ?? 0.25),
      topP: 0.95,
      topK: 40,
      maxTokens: Math.max(256, Math.min(4096, Number(request.maxTokens ?? settings.codeMaxTokens ?? 1200))),
      onDelta: (chunk) => {
        if (!event.sender.isDestroyed()) event.sender.send("codegen:delta", { text: chunk });
      },
    });

    const parsed = parseFileBlocks(result.text);
    if (!parsed.files.length) {
      return {
        id: null,
        plan: [],
        warnings: [
          ...parsed.warnings,
          "The model did not return any ===FILE: path=== blocks, so there is nothing to write. Raise the token limit or make the request more concrete.",
        ],
        commentary: commentary(result.text),
        stats: result.stats,
        text: result.text,
      };
    }

    const accepted = [];
    const warnings = [...parsed.warnings];
    let totalBytes = 0;

    for (const file of parsed.files) {
      if (accepted.length >= MAX_PLAN_FILES) {
        warnings.push(`Only the first ${MAX_PLAN_FILES} files are kept.`);
        break;
      }
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (totalBytes + bytes > MAX_PLAN_BYTES) {
        warnings.push(`Stopped at ${(MAX_PLAN_BYTES / 1_000_000).toFixed(0)} MB of generated content.`);
        break;
      }
      let action = "create";
      try {
        const existing = await statEntry(root, file.path);
        if (existing) action = "overwrite";
      } catch {
        action = "invalid";
      }
      totalBytes += bytes;
      accepted.push({ ...file, bytes, action });
    }

    plan = { id: `plan-${Date.now()}`, root, files: accepted, createdAt: Date.now() };

    return {
      id: plan.id,
      plan: accepted.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        action: file.action,
        preview: file.content.slice(0, 600),
      })),
      warningFileCount: parsed.files.length,
      totalBytes,
      warnings,
      commentary: commentary(result.text).slice(0, 4000),
      stats: result.stats,
      text: result.text,
    };
  });

  ipcMain.handle("ide:apply", async (_event, request = {}) => {
    const root = requireRoot();
    if (!plan || plan.id !== request.id) throw new Error("That plan expired. Generate again.");
    if (plan.root !== root) throw new Error("The open folder changed. Generate again.");

    const wanted = Array.isArray(request.paths) && request.paths.length ? new Set(request.paths) : null;
    const written = [];
    const failed = [];

    for (const file of plan.files) {
      if (wanted && !wanted.has(file.path)) continue;
      try {
        written.push(await writeTextFile(root, file.path, file.content, {}));
      } catch (error) {
        failed.push({ path: file.path, message: error.message, code: error.code ?? null });
      }
    }

    plan = null;
    return { written, failed, root };
  });

  ipcMain.handle("ide:discard", () => {
    plan = null;
    return true;
  });

  ipcMain.handle("ide:read-many", async (_event, request = {}) => {
    const root = requireRoot();
    const results = [];
    for (const relativePath of (request.paths ?? []).slice(0, 20)) {
      try {
        results.push(await readTextFile(root, relativePath));
      } catch (error) {
        results.push({ path: relativePath, error: error.message });
      }
    }
    return results;
  });

  app.on("before-quit", () => {
    shells.disposeAll();
  });

  return { shells, get root() { return state.root; } };
}

export { ConflictError };
