/**
 * Reading and writing files inside the open folder.
 *
 * Writes carry the modification time the editor loaded, so a file that changed
 * on disk (a formatter, a git operation, a terminal command) is reported as a
 * conflict instead of being silently overwritten.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { languageFor } from "./languages.js";
import { cleanRelativePath, resolveInside, WorkspaceError } from "./safety.js";

const MAX_EDITOR_BYTES = 2_000_000;

export class ConflictError extends WorkspaceError {
  constructor(message, details = {}) {
    super(message, "CONFLICT");
    this.name = "ConflictError";
    Object.assign(this, details);
  }
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export async function statEntry(root, relativePath) {
  const full = resolveInside(root, relativePath);
  try {
    const stat = await fs.stat(full);
    return { path: cleanRelativePath(relativePath), size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() };
  } catch {
    return null;
  }
}

export async function readTextFile(root, relativePath, { maxBytes = MAX_EDITOR_BYTES } = {}) {
  const relative = cleanRelativePath(relativePath);
  const full = resolveInside(root, relative);
  const stat = await fs.stat(full).catch(() => null);
  if (!stat) throw new WorkspaceError(`File not found: ${relative}`, "MISSING");
  if (stat.isDirectory()) throw new WorkspaceError(`"${relative}" is a folder.`, "IS_DIRECTORY");
  const language = languageFor(relative);

  if (stat.size > maxBytes) {
    return {
      path: relative,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      language,
      content: "",
      tooLarge: true,
      message: `This file is ${(stat.size / 1_048_576).toFixed(1)} MB. The editor opens files up to ${(maxBytes / 1_048_576).toFixed(1)} MB.`,
    };
  }

  const buffer = await fs.readFile(full);
  if (looksBinary(buffer)) {
    return {
      path: relative,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      language,
      content: "",
      binary: true,
      message: "Binary file. It is not opened as text; the terminal or an external app is the right tool.",
    };
  }

  return {
    path: relative,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    language,
    content: buffer.toString("utf8"),
    binary: false,
    tooLarge: false,
  };
}

export async function writeTextFile(root, relativePath, content, { expectedMtimeMs = null } = {}) {
  const relative = cleanRelativePath(relativePath);
  const full = resolveInside(root, relative);
  const text = String(content ?? "");

  let currentMtime = null;
  try {
    const stat = await fs.stat(full);
    if (stat.isDirectory()) throw new WorkspaceError(`"${relative}" is a folder.`, "IS_DIRECTORY");
    currentMtime = stat.mtimeMs;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    currentMtime = null;
  }

  if (expectedMtimeMs !== null && currentMtime !== null && Math.abs(currentMtime - expectedMtimeMs) > 1) {
    throw new ConflictError(`"${relative}" changed on disk since it was opened.`, {
      path: relative,
      diskMtimeMs: currentMtime,
    });
  }

  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, "utf8");
  const stat = await fs.stat(full);
  return { path: relative, size: stat.size, mtimeMs: stat.mtimeMs, language: languageFor(relative) };
}

export async function createEntry(root, relativePath, type = "file") {
  const relative = cleanRelativePath(relativePath);
  const full = resolveInside(root, relative);
  const exists = await fs.stat(full).catch(() => null);
  if (exists) throw new WorkspaceError(`"${relative}" already exists.`, "EXISTS");
  if (type === "dir") {
    await fs.mkdir(full, { recursive: true });
    return { path: relative, type: "dir" };
  }
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, "", "utf8");
  return { path: relative, type: "file" };
}

export async function renameEntry(root, from, to) {
  const relativeFrom = cleanRelativePath(from);
  const relativeTo = cleanRelativePath(to);
  const fullFrom = resolveInside(root, relativeFrom);
  const fullTo = resolveInside(root, relativeTo);
  const exists = await fs.stat(fullFrom).catch(() => null);
  if (!exists) throw new WorkspaceError(`"${relativeFrom}" no longer exists.`, "MISSING");
  if (await fs.stat(fullTo).catch(() => null)) throw new WorkspaceError(`"${relativeTo}" already exists.`, "EXISTS");
  await fs.mkdir(path.dirname(fullTo), { recursive: true });
  await fs.rename(fullFrom, fullTo);
  return { from: relativeFrom, to: relativeTo };
}

export async function deleteEntry(root, relativePath) {
  const relative = cleanRelativePath(relativePath);
  const full = resolveInside(root, relative);
  const exists = await fs.stat(full).catch(() => null);
  if (!exists) throw new WorkspaceError(`"${relative}" no longer exists.`, "MISSING");
  // A model-supplied path must never be able to wipe the workspace root: the
  // path cleaner already drops "..", and the root itself is not a file.
  if (relative.replace(/\/+$/, "") === "") throw new WorkspaceError("Refusing to delete the whole folder.", "ESCAPE");
  await fs.rm(full, { recursive: exists.isDirectory(), force: true });
  return { path: relative, type: exists.isDirectory() ? "dir" : "file" };
}
