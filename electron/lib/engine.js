/**
 * Real llama.cpp inference via node-llama-cpp. CPU-first: if the machine has a
 * supported GPU it is used automatically, but nothing here requires one.
 *
 * One model + one context are kept warm. The chat session is reused between
 * turns so the KV cache stays valid, and rebuilt from history whenever the
 * conversation, system prompt or model changes (or after a stop).
 */

import fs from "node:fs";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { readGgufInfo } from "./gguf.js";
import { estimateTotalBytes, formatBytes } from "./quant.js";

// Reported in Settings so the UI never hardcodes a version that can drift.
export const engineVersion = (() => {
  try {
    const manifest = new URL("../../node_modules/node-llama-cpp/package.json", import.meta.url);
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? null;
  } catch {
    return null;
  }
})();

let llama = null;
let model = null;
let context = null;
let session = null;
let sessionKey = null;
let generation = null;
let current = {
  modelPath: null,
  fileInfo: null,
  contextSize: null,
  threads: null,
  loadProgress: 0,
  loadPhase: null,
  gpu: false,
};

function isAbortError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  const message = String(error.message ?? error);
  return /abort|stop(ed)?|cancel/i.test(message);
}

function friendlyError(error) {
  const message = String(error?.message ?? error);
  if (/InsufficientMemory|out of memory|OutOfMemory|failed to allocate/i.test(message)) {
    return `Not enough memory to load this model. Lower the context size in Settings, or use a smaller quant (Settings → Context). llama.cpp said: ${message}`;
  }
  if (/NoBinaryFound|prebuilt|build/i.test(message)) {
    return `llama.cpp binaries are missing for this platform. Run "npm run preflight" once with the app closed, then start Blackbox again. Details: ${message}`;
  }
  if (/UnsupportedGgufValueType|unknown model architecture|failed to load model/i.test(message)) {
    return `This GGUF file could not be loaded by llama.cpp: ${message}`;
  }
  return message;
}

export function status() {
  return {
    loaded: Boolean(model && context),
    modelPath: current.modelPath,
    modelName: current.modelPath ? current.modelPath.split(/[\\/]/).pop().replace(/\.gguf$/i, "") : null,
    contextSize: context?.contextSize ?? null,
    requestedContextSize: current.contextSize,
    threads: current.threads,
    gpu: llama?.gpu ?? false,
    fileInfo: current.fileInfo
      ? {
          architecture: current.fileInfo.architecture,
          blockCount: current.fileInfo.blockCount,
          contextLength: current.fileInfo.contextLength,
          kvBytesPerToken: current.fileInfo.kvBytesPerToken,
        }
      : null,
    busy: Boolean(generation),
    chatId: session ? sessionKey?.split("::")[0] ?? null : null,
  };
}

export async function initLlama({ gpu = "auto" }) {
  if (llama) return llama;
  llama = await getLlama({
    gpu: gpu === "cpu" ? false : "auto",
    logLevel: "error",
    progressLogs: false,
  });
  return llama;
}

function dropSession() {
  if (session) {
    try {
      // autoDisposeSequence is enabled at construction, so this releases the
      // context sequence back to the pool instead of leaking it.
      session.dispose();
    } catch {
      /* already gone */
    }
  }
  session = null;
  sessionKey = null;
}

async function rebuildContext() {
  if (!model) throw new Error("No model is loaded. Pick a model first.");
  const size = current.contextSize;
  const threads = current.threads;
  if (context) {
    try {
      await context.dispose();
    } catch {
      /* already gone */
    }
    context = null;
  }
  context = await model.createContext({ contextSize: size, threads, failedCreationRemedy: false });
  return context;
}

export async function unload() {
  generation?.abort();
  generation = null;

  dropSession();
  if (context) {
    try {
      await context.dispose();
    } catch {
      /* already gone */
    }
    context = null;
  }
  if (model) {
    try {
      await model.dispose();
    } catch {
      /* already gone */
    }
    model = null;
  }
  current = { ...current, modelPath: null, fileInfo: null, contextSize: null };
  return status();
}

export async function load({ modelPath, contextSize = 4096, threads = 4, gpu = "auto", onProgress = () => {} }) {
  await initLlama({ gpu });

  const fileInfo = readGgufInfo(modelPath);
  const sameModel = current.modelPath === modelPath;

  if (sameModel && context && context.contextSize === contextSize && model) {
    return status();
  }

  await unload();
  onProgress({ phase: "weights", progress: 0, message: "Loading model into memory" });

  model = await llama.loadModel({
    modelPath,
    gpuLayers: "auto",
    onLoadProgress: (progress) => onProgress({ phase: "weights", progress }),
  });
  current.modelPath = modelPath;
  current.fileInfo = fileInfo;

  onProgress({ phase: "context", progress: 0, message: `Allocating ${contextSize} token context` });
  try {
    context = await model.createContext({
      contextSize,
      threads,
      failedCreationRemedy: false,
    });
  } catch (error) {
    const budget = estimateTotalBytes(fileInfo.fileSize, fileInfo, contextSize);
    await unload();
    throw new Error(
      `${friendlyError(error)}\n\nThis request needed roughly ${formatBytes(budget)} (weights + KV cache). ` +
        `Model file: ${formatBytes(fileInfo.fileSize)}.`,
    );
  }

  current.contextSize = contextSize;
  current.threads = threads;
  onProgress({ phase: "ready", progress: 1, message: "Model ready" });
  return status();
}

function buildHistory(systemPrompt, history) {
  const items = [];
  for (const message of history ?? []) {
    if (!message || typeof message.content !== "string" || !message.content.trim()) continue;
    if (message.role === "user") items.push({ type: "user", text: message.content });
    else if (message.role === "assistant") items.push({ type: "model", response: [message.content] });
  }
  return items;
}

async function ensureSession({ chatId, systemPrompt, history }) {
  const key = `${chatId}::${model?.filePath ?? ""}::${systemPrompt ?? ""}`;
  if (session && sessionKey === key) return session;

  dropSession();

  // Defensive: if the sequence pool is exhausted (for example after a hard abort),
  // rebuild the context rather than failing the user's message.
  if (!context || context.disposed || context.sequencesLeft < 1) {
    await rebuildContext();
  }

  session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: systemPrompt && systemPrompt.trim() ? systemPrompt : undefined,
    autoDisposeSequence: true,
  });

  const historyItems = buildHistory(systemPrompt, history);
  if (historyItems.length > 0) {
    session.setChatHistory(historyItems);
  }
  sessionKey = key;
  return session;
}

export async function chat({
  chatId,
  systemPrompt,
  history,
  prompt,
  temperature = 0.8,
  topP = 0.9,
  topK = 40,
  maxTokens = 512,
  onDelta = () => {},
}) {
  if (!model || !context) throw new Error("No model is loaded. Pick a model first.");
  if (generation) throw new Error("A response is already being generated.");
  if (!prompt || !String(prompt).trim()) throw new Error("Empty prompt.");

  const activeSession = await ensureSession({ chatId, systemPrompt, history });
  const controller = new AbortController();
  generation = controller;

  let text = "";
  let tokens = 0;
  const startedAt = performance.now();
  let firstTokenAt = null;

  try {
    const result = await activeSession.prompt(String(prompt), {
      maxTokens: Math.max(1, Number(maxTokens) || 512),
      temperature: Number(temperature),
      topP: Number(topP),
      topK: Number(topK),
      signal: controller.signal,
      onTextChunk(chunk) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        text += chunk;
        onDelta(chunk);
      },
      onToken() {
        tokens += 1;
      },
    });

    const finishedAt = performance.now();
    const elapsedMs = finishedAt - startedAt;
    const generationMs = firstTokenAt ? finishedAt - firstTokenAt : elapsedMs;

    return {
      text: typeof result === "string" && result.length >= text.length ? result : text,
      stats: {
        tokens,
        elapsedMs: Math.round(elapsedMs),
        tokensPerSecond: generationMs > 0 ? Number(((tokens / generationMs) * 1000).toFixed(2)) : null,
        stopped: false,
      },
    };
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      // The session's KV state is now mid-turn; rebuild it from UI history next time.
      sessionKey = null;
      const elapsedMs = performance.now() - startedAt;
      return {
        text,
        stats: {
          tokens,
          elapsedMs: Math.round(elapsedMs),
          tokensPerSecond: elapsedMs > 0 ? Number(((tokens / elapsedMs) * 1000).toFixed(2)) : null,
          stopped: true,
        },
      };
    }
    sessionKey = null;
    throw new Error(friendlyError(error));
  } finally {
    if (generation === controller) generation = null;
  }
}

export function stop() {
  if (!generation) return false;
  generation.abort();
  return true;
}

export async function disposeAll() {
  await unload();
  if (llama) {
    try {
      await llama.dispose();
    } catch {
      /* noop */
    }
    llama = null;
  }
}
