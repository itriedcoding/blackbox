/**
 * The build loop: keep asking the local model for the next batch of files until
 * the project is complete, instead of stopping after one reply.
 *
 * Completion is decided from evidence, not vibes:
 *   - the model writes an explicit ===DONE=== marker, or
 *   - a round produces no file that differs from what is already on disk, or
 *   - the round/byte budget is exhausted.
 *
 * Every write still goes through the caller's root-checked writer.
 */

import { CODER_SYSTEM_PROMPT, describeTree, parseFileBlocks } from "./prompt.js";

export const DEFAULT_MAX_ROUNDS = 8;
export const MAX_TOTAL_BYTES = 6_000_000;
const MAX_CONTEXT_CHARS = 9000;

export const BUILD_SYSTEM_PROMPT = [
  CODER_SYSTEM_PROMPT,
  "You are building the project across several rounds.",
  "Each round you receive the files that already exist, with their contents.",
  "Write only what is still missing or must change. Never repeat a file unchanged.",
  "If the project is complete and runnable, reply with exactly ===DONE=== and nothing else.",
  "If it is not complete, reply with the next ===FILE: path=== blocks and no ===DONE=== marker.",
].join("\n");

export function completionSignal(text) {
  return /^[ \t]*===DONE===[ \t]*$/m.test(String(text ?? ""));
}

/** Prompt for one round, carrying the work done so far. */
export function roundPrompt({ instruction, tree, written, round, maxRounds, maxContextChars = MAX_CONTEXT_CHARS }) {
  const files = [...written.entries()];
  const parts = [`Task:\n${instruction}`];
  parts.push(`Project so far:\n${tree ? describeTree(tree) : "(empty folder)"}`);

  if (files.length) {
    const listing = files.map(([file]) => `- ${file}`).join("\n");
    parts.push(`Files already written (${files.length}):\n${listing}`);

    const blocks = [];
    let used = 0;
    for (let index = files.length - 1; index >= 0 && used < maxContextChars; index -= 1) {
      const [file, content] = files[index];
      const room = maxContextChars - used;
      if (room < 300) break;
      const body = content.length > room ? `${content.slice(0, room)}\n… (truncated)` : content;
      used += body.length;
      blocks.unshift(`--- ${file} ---\n${body}`);
    }
    if (blocks.length) parts.push(`Most recent file contents:\n${blocks.join("\n\n")}`);
  }

  parts.push(
    [
      `Round ${round} of at most ${maxRounds}.`,
      files.length ? "Continue the build. Output only files that are missing or changed." : "Write the project now.",
      "Finish with ===DONE=== on its own line when the project is complete and runnable.",
    ].join("\n"),
  );

  return { systemPrompt: BUILD_SYSTEM_PROMPT, prompt: parts.join("\n\n") };
}

/** Files in a parsed reply whose content is not already what we wrote. */
export function changedFiles(files, written) {
  return (files ?? []).filter((file) => written.get(file.path) !== file.content);
}

/**
 * Drives the loop.
 *
 * `provider` is the only thing that talks to a model; everything else is
 * deterministic, which is what the loop tests exercise.
 */
export async function runBuild({
  instruction,
  tree,
  provider,
  writeFile,
  shouldStop = () => false,
  onProgress = () => {},
  onRound = () => {},
  maxRounds = DEFAULT_MAX_ROUNDS,
  maxTotalBytes = MAX_TOTAL_BYTES,
}) {
  const written = new Map();
  const failures = [];
  const rounds = [];
  let totalBytes = 0;
  let stopped = false;

  const finish = (reason) => {
    const summary = {
      reason,
      rounds: rounds.length,
      files: [...written.keys()],
      totalBytes,
      failures,
      stopped,
    };
    onProgress({ ...summary, done: true });
    return {
      written: [...written.entries()].map(([path, content]) => ({ path, bytes: Buffer.byteLength(content) })),
      files: [...written.keys()],
      rounds,
      failures,
      stopped,
      reason,
      totalBytes,
    };
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    if (shouldStop()) {
      stopped = true;
      return finish("stopped");
    }

    const { systemPrompt, prompt } = roundPrompt({ instruction, tree, written, round, maxRounds });
    let text = "";
    try {
      text = String(await provider({ systemPrompt, prompt, round }));
    } catch (error) {
      failures.push({ path: "(round)", message: error.message });
      if (shouldStop()) {
        stopped = true;
        return finish("stopped");
      }
      return finish("error");
    }

    if (shouldStop()) {
      stopped = true;
      return finish("stopped");
    }

    const parsed = parseFileBlocks(text);
    const pending = changedFiles(parsed.files, written);
    const done = completionSignal(text);

    onRound({ round, files: pending.map((file) => file.path), done, returned: parsed.files.length });

    if (!pending.length) {
      return finish(done ? "done" : round === 1 ? "no-files" : "converged");
    }

    for (const file of pending) {
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (totalBytes + bytes > maxTotalBytes) {
        failures.push({ path: file.path, message: `Byte budget of ${maxTotalBytes} reached; stopped writing.` });
        return finish("budget");
      }
      try {
        await writeFile(file.path, file.content);
        written.set(file.path, file.content);
        totalBytes += bytes;
      } catch (error) {
        failures.push({ path: file.path, message: error.message });
      }
    }

    rounds.push({ round, written: pending.map((file) => file.path), done });
    onProgress({ round, maxRounds, files: [...written.keys()], totalBytes, done: false });

    if (done) return finish("done");
  }

  return finish("max-rounds");
}
