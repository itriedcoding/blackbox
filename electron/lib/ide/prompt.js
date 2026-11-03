/**
 * Everything about getting files out of the local model.
 *
 * The model is asked for a rigid block format rather than Markdown fences
 * because prose around a fence ("here is the file, same as before") is exactly
 * what ends up written to disk by accident. Anything it emits outside a block
 * is kept as commentary and never applied.
 */

import { cleanRelativePath, WorkspaceError } from "./safety.js";

export const CODER_SYSTEM_PROMPT = [
  "You are a senior software engineer writing a complete, runnable project for the user.",
  "You may write any programming language the user asks for.",
  "Reply with file blocks only. No introduction, no summary, no closing remarks.",
  "A block is exactly:",
  "===FILE: relative/path.ext===",
  "<the complete file contents>",
  "===END===",
  "Rules:",
  "- Write every file in full. Never write \"... rest unchanged\" or any placeholder.",
  "- Paths are relative to the project root and use forward slashes. Never absolute paths.",
  "- Include every file the project needs to run: code, manifests, config, README.",
  "- If you are changing an existing file you were shown, output the whole updated file.",
  "- Prefer standard-library and widely available dependencies over obscure ones.",
  "- Do not invent APIs. If you are unsure of an interface, use the simplest approach that works.",
].join("\n");

const MAX_TREE_LINES = 220;
const MAX_CONTEXT_CHARS = 14000;

/** One-line project shape so the model knows what already exists. */
export function describeTree(node, { maxLines = MAX_TREE_LINES } = {}) {
  const lines = [];
  const walk = (current, prefix, depth) => {
    if (lines.length >= maxLines) return;
    const children = current.children ?? [];
    children.forEach((child, index) => {
      if (lines.length >= maxLines) return;
      const last = index === children.length - 1;
      const branch = depth === 0 ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
      lines.push(`${branch}${child.name}${child.type === "dir" ? "/" : ""}`);
      if (child.type === "dir" && !child.collapsed && depth < 4) {
        walk(child, `${prefix}${depth === 0 ? "" : last ? "   " : "│  "}`, depth + 1);
      }
    });
  };
  walk(node, "", 0);
  if (lines.length >= maxLines) lines.push("… (listing truncated)");
  return lines.join("\n");
}

export function buildProjectPrompt({ instruction, tree, files = [], extraContext = "" }) {
  const text = String(instruction ?? "").trim();
  if (!text) throw new WorkspaceError("Describe what to build first.", "EMPTY");

  const parts = [];
  parts.push(`Project:\n${tree ? describeTree(tree) : "(empty folder)"}`);

  let used = 0;
  const contextBlocks = [];
  for (const file of files) {
    if (!file || typeof file.content !== "string") continue;
    if (file.binary || file.tooLarge) continue;
    const remaining = MAX_CONTEXT_CHARS - used;
    if (remaining < 400) break;
    const body = file.content.length > remaining ? `${file.content.slice(0, remaining)}\n… (truncated)` : file.content;
    used += body.length;
    contextBlocks.push(`--- ${file.path} ---\n${body}`);
  }
  if (contextBlocks.length) parts.push(`Open files:\n${contextBlocks.join("\n\n")}`);
  if (extraContext) parts.push(`Notes:\n${extraContext}`);

  parts.push(`Task:\n${text}`);
  parts.push("Answer with ===FILE: path=== blocks only.");

  return { systemPrompt: CODER_SYSTEM_PROMPT, prompt: parts.join("\n\n") };
}

const OPEN_RE = /^[ \t]*===FILE:[ \t]*(.+?)[ \t]*===[ \t]*$/m;
const END_RE = /^[ \t]*===END===[ \t]*$/m;
const FENCE_RE = /^```([a-zA-Z0-9+#._-]*)[ \t]*(.*)$/;

function safePath(raw, warnings) {
  try {
    return cleanRelativePath(raw);
  } catch (error) {
    warnings.push(`Skipped "${String(raw).trim()}": ${error.message}`);
    return null;
  }
}

function parseBlocks(source) {
  const files = [];
  const warnings = [];
  let index = 0;
  const seen = new Set();

  while (index < source.length) {
    const rest = source.slice(index);
    const open = OPEN_RE.exec(rest);
    if (!open) break;

    const bodyStart = index + open.index + open[0].length;
    const afterOpen = source.slice(bodyStart);
    const end = END_RE.exec(afterOpen);

    let body;
    let next;
    if (end) {
      body = afterOpen.slice(0, end.index);
      next = bodyStart + end.index + end[0].length;
    } else {
      body = afterOpen;
      next = source.length;
      warnings.push(`Block "${open[1].trim()}" had no ===END=== marker; used the rest of the reply.`);
    }

    const relative = safePath(open[1], warnings);
    if (relative) {
      const content = body.replace(/^\n/, "").replace(/\n$/, "\n");
      if (seen.has(relative)) warnings.push(`"${relative}" was written twice; the last block wins.`);
      seen.add(relative);
      files.push({ path: relative, content });
    }
    index = next;
  }

  return { files, warnings };
}

function parseFences(source) {
  const files = [];
  const warnings = [];
  const lines = source.split("\n");
  const seen = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE_RE.exec(lines[i].trimEnd());
    if (!fence) continue;
    const info = fence[2] ?? "";
    // Accept ```js path=src/app.js, ```js src/app.js, and ```path=src/app.js
    const candidate =
      /(?:path|file|filename)\s*=\s*["']?([^"'\s]+)["']?/i.exec(info)?.[1] ??
      info.split(/\s+/).find((token) => /[./]/.test(token) || /\.[a-zA-Z0-9]+$/.test(token)) ??
      "";
    if (!candidate) continue;

    const body = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j += 1) {
      if (/^```[ \t]*$/.test(lines[j].trim())) {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    if (!closed) warnings.push(`Code fence for "${candidate}" was never closed.`);
    const relative = safePath(candidate, warnings);
    if (relative) {
      if (seen.has(relative)) warnings.push(`"${relative}" appeared twice; the last block wins.`);
      seen.add(relative);
      files.push({ path: relative, content: `${body.join("\n")}${closed ? "\n" : ""}` });
    }
    i = j;
  }

  return { files, warnings };
}

/**
 * Tolerant parse: the rigid format first, fenced code as a fallback for models
 * that ignore instructions. Returns files plus warnings, never throws.
 */
export function parseFileBlocks(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  const strict = parseBlocks(source);
  if (strict.files.length) return strict;
  const fenced = parseFences(source);
  if (fenced.files.length) {
    fenced.warnings.unshift("The reply used Markdown fences instead of ===FILE:=== blocks; those were parsed instead.");
  }
  return fenced;
}

/** Text outside the file blocks, for the "explanation" area. Bodies never leak. */
/** Text outside the file blocks, for the "explanation" area. Bodies never leak. */
export function commentary(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  const kept = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    if (/^[ \t]*===FILE:.*===[ \t]*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (/^[ \t]*===END===[ \t]*$/.test(line)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
