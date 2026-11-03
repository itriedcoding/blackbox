/**
 * Dataset preparation for fine-tuning.
 *
 * Accepts the two formats people actually have:
 *   - JSONL with {"messages":[...]}, {"prompt","completion"}, {"instruction","output"}
 *   - plain text (.txt / .md), split into blank-line-separated passages
 *
 * Normalisation is explicit: every example becomes {messages:[{role,content}]},
 * and plain text becomes a completion-only example flagged with `format:"text"`.
 * Invalid lines are reported with their line number instead of being dropped
 * silently.
 */

import fs from "node:fs";
import path from "node:path";

const ROLES = new Set(["system", "user", "assistant"]);

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") return null;
    if (!ROLES.has(message.role)) return null;
    if (typeof message.content !== "string" || !message.content.trim()) return null;
    out.push({ role: message.role, content: message.content });
  }
  if (!out.some((message) => message.role === "assistant")) return null;
  return out;
}

function fromJsonObject(value) {
  if (value && typeof value === "object") {
    if (Array.isArray(value.messages)) return normalizeMessages(value.messages);
    if (typeof value.prompt === "string" && typeof value.completion === "string") {
      return normalizeMessages([
        { role: "user", content: value.prompt },
        { role: "assistant", content: value.completion },
      ]);
    }
    if (typeof value.instruction === "string" && typeof value.output === "string") {
      const prompt = value.input ? `${value.instruction}\n\n${value.input}` : value.instruction;
      return normalizeMessages([
        { role: "user", content: prompt },
        { role: "assistant", content: value.output },
      ]);
    }
  }
  return null;
}

export function approxTokens(text) {
  return Math.max(1, Math.round(String(text).length / 4));
}

export function parseDataset(file) {
  const text = fs.readFileSync(String(file), "utf8");
  const lower = path.extname(String(file)).toLowerCase();
  const examples = [];
  const problems = [];

  if (lower === ".jsonl" || lower === ".json") {
    const lines = text.split(/\r?\n/);
    let sawJson = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        problems.push({ line: index + 1, reason: `invalid JSON: ${error.message}` });
        return;
      }
      sawJson = true;
      const messages = Array.isArray(parsed) ? normalizeMessages(parsed) : fromJsonObject(parsed);
      if (!messages) {
        problems.push({ line: index + 1, reason: "no usable messages/prompt+completion" });
        return;
      }
      examples.push({ messages, format: "chat" });
    });
    if (!sawJson && text.trim()) {
      throw new Error("That file is not JSONL: every line must be a JSON object.");
    }
  } else {
    const blocks = text
      .split(/\r?\n\s*\r?\n/)
      .map((block) => block.trim())
      .filter((block) => block.length >= 24);
    blocks.forEach((block, index) => {
      examples.push({ text: block, format: "text" });
    });
    if (blocks.length === 0) {
      problems.push({ line: 1, reason: "no passages of at least 24 characters" });
    }
  }

  const formats = new Set(examples.map((example) => example.format));
  if (formats.size > 1) {
    throw new Error("Do not mix chat and plain-text examples in one dataset. Split them into two files.");
  }

  const stats = {
    count: examples.length,
    format: formats.values().next().value ?? "chat",
    characters: examples.reduce(
      (sum, example) => sum + (example.text?.length ?? example.messages.reduce((inner, message) => inner + message.content.length, 0)),
      0,
    ),
    approxTokens: examples.reduce(
      (sum, example) =>
        sum +
        (example.text
          ? approxTokens(example.text)
          : example.messages.reduce((inner, message) => inner + approxTokens(message.content), 0)),
      0,
    ),
    problems,
  };
  return { examples, stats };
}

/** Write a normalised JSONL file for the Python trainer. */
export function writeTrainingJsonl({ examples, outFile }) {
  const lines = examples.map((example) =>
    JSON.stringify(example.format === "text" ? { text: example.text } : { messages: example.messages }),
  );
  fs.mkdirSync(path.dirname(String(outFile)), { recursive: true });
  fs.writeFileSync(String(outFile), `${lines.join("\n")}\n`, "utf8");
  return { file: String(outFile), lines: lines.length, bytes: fs.statSync(String(outFile)).size };
}
