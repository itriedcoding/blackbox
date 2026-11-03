/**
 * Folder listing for the explorer.
 *
 * Build and dependency folders are skipped: a Node project with a populated
 * node_modules can hold hundreds of thousands of entries, and rendering that
 * in a tree helps nobody. The limits are reported to the UI rather than
 * silently applied.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { toPosix } from "./safety.js";

export const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".idea",
  ".vscode",
  ".DS_Store",
  "Thumbs.db",
  ".probe",
]);

const MAX_DEPTH = 7;
const MAX_NODES = 6000;

export function isIgnored(name) {
  if (!name) return true;
  if (IGNORED_NAMES.has(name)) return true;
  return false;
}

/**
 * Breadth-first walk with a node budget so a huge folder can never hang the
 * window. Directories keep their children inline; the renderer toggles them.
 */
export async function listTree(root, { maxDepth = MAX_DEPTH, maxNodes = MAX_NODES } = {}) {
  const resolvedRoot = path.resolve(String(root));
  const name = path.basename(resolvedRoot) || resolvedRoot;
  const tree = { name, path: "", type: "dir", children: [] };
  let budget = maxNodes;
  let truncated = false;

  const queue = [{ dir: resolvedRoot, node: tree, depth: 0 }];

  while (queue.length) {
    const { dir, node, depth } = queue.shift();
    if (budget <= 0) {
      truncated = true;
      break;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      node.error = error.code ?? "UNREADABLE";
      continue;
    }

    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    for (const entry of entries) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      if (isIgnored(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.isDirectory() && entry.name !== ".github") continue;

      const full = path.join(dir, entry.name);
      const relative = toPosix(path.relative(resolvedRoot, full));

      if (entry.isDirectory()) {
        const child = { name: entry.name, path: relative, type: "dir", children: [] };
        node.children.push(child);
        budget -= 1;
        if (depth + 1 < maxDepth) queue.push({ dir: full, node: child, depth: depth + 1 });
        else child.collapsed = true;
      } else if (entry.isFile()) {
        let size = 0;
        try {
          const stat = await fs.stat(full);
          size = stat.size;
        } catch {
          size = 0;
        }
        node.children.push({ name: entry.name, path: relative, type: "file", size });
        budget -= 1;
      }
    }
  }

  return { root: resolvedRoot, name, tree, truncated, maxDepth };
}

/** Flat list of file paths, used to give the model an accurate project shape. */
export function flattenFiles(node, limit = 300) {
  const files = [];
  const walk = (current) => {
    if (files.length >= limit) return;
    for (const child of current.children ?? []) {
      if (files.length >= limit) return;
      if (child.type === "dir") walk(child);
      else files.push(child.path);
    }
  };
  walk(node);
  return files;
}
