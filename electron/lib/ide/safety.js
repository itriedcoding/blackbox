/**
 * Every path that reaches the filesystem goes through here first.
 *
 * The editor is given an absolute root by the folder picker; nothing else may
 * address the disk. A model-generated path is untrusted text, so the same
 * checks apply to it as to a path typed by a user.
 */

import fs from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(message, code = "WORKSPACE") {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export function toPosix(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

/**
 * Trims decoration a model or a user tends to add around a path and rejects
 * anything absolute before it can be joined onto the root.
 */
export function cleanRelativePath(input) {
  let value = String(input ?? "").trim();
  if (!value) throw new WorkspaceError("Empty path.");
  value = value.replace(/^```[a-zA-Z0-9+#-]*/, "");
  value = value.replace(/^["'`]+|["'`]+$/g, "").trim();
  value = toPosix(value);
  if (value.startsWith("/")) throw new WorkspaceError(`"${input}" is an absolute path.`, "ESCAPE");
  if (value.startsWith("~/")) throw new WorkspaceError(`"${input}" is a home-relative path.`, "ESCAPE");
  while (value.startsWith("./")) value = value.slice(2);
  if (!value) throw new WorkspaceError("Empty path.");
  if (value.includes("\0")) throw new WorkspaceError("Path contains a null byte.");
  if (/^[a-zA-Z]:/.test(value)) throw new WorkspaceError(`"${input}" is an absolute Windows path.`);
  if (value.startsWith("//") || value.startsWith("\\\\")) throw new WorkspaceError(`"${input}" is a network path.`);
  if (value.length > 400) throw new WorkspaceError("Path is longer than 400 characters.");
  const segments = value.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new WorkspaceError(`"${input}" tries to leave the open folder.`, "ESCAPE");
    }
  }
  return segments.join("/");
}

/** Absolute path for a relative path, guaranteed to stay inside root. */
export function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(String(root ?? ""));
  if (!resolvedRoot) throw new WorkspaceError("No folder is open.");
  const relative = cleanRelativePath(relativePath);
  const full = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceError(`"${relativePath}" resolves outside the open folder.`, "ESCAPE");
  }
  return full;
}

/** Relative posix path for something already known to live under root. */
export function relativeInside(root, fullPath) {
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(fullPath)));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceError("Path is outside the open folder.", "ESCAPE");
  }
  return toPosix(rel);
}

export async function assertDirectory(dir, label = "folder") {
  let stat;
  try {
    stat = await fs.promises.stat(dir);
  } catch {
    throw new WorkspaceError(`That ${label} no longer exists: ${dir}`);
  }
  if (!stat.isDirectory()) throw new WorkspaceError(`That ${label} is not a directory: ${dir}`);
  return path.resolve(dir);
}
