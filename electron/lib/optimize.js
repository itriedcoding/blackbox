/**
 * Turns a memory picture and a model's own GGUF metadata into the settings that
 * actually fit this machine. Pure functions only — no Electron, no disk — so
 * scripts/verify-perf.mjs can exercise every branch without a window.
 */

import { estimateTotalBytes, formatBytes } from "./quant.js";

// Largest first: the recommendation takes the biggest window that still fits.
export const CONTEXT_CHOICES = [8192, 4096, 2048, 1024];

// Weights + KV may not eat the whole budget: the rest of Windows, the Electron
// renderer and llama.cpp's own scratch buffers still need room.
export const HEADROOM = 0.8;

/** Threads that keep one core for the UI, never more than the machine has. */
export function recommendThreads(cores) {
  const count = Math.max(1, Math.round(Number(cores) || 4));
  return Math.max(2, Math.min(8, count - 1));
}

/**
 * @param {object} input
 * @param {number} input.budget    bytes a model may use (already net of runtime overhead)
 * @param {number} input.fileSize  GGUF file size in bytes, 0 when no model is chosen
 * @param {object} input.fileInfo  output of readGgufInfo (kvBytesPerToken, contextLength)
 * @param {number} input.cores     logical cores
 * @param {boolean} input.gpuDetected  llama.cpp reported a usable GPU backend
 */
export function recommendSettings({ budget, fileSize, fileInfo, cores, gpuDetected = false } = {}) {
  const threads = recommendThreads(cores);
  const gpu = gpuDetected ? "auto" : "cpu";
  const available = Math.max(0, Number(budget) || 0);
  const weights = Math.max(0, Number(fileSize) || 0);

  if (!weights) {
    return {
      threads,
      gpu,
      contextSize: 4096,
      fits: true,
      estimate: null,
      weights: 0,
      kv: 0,
      budget: available,
      headroomBytes: available,
      nativeContext: null,
      reason:
        `No model chosen yet, so this is the safe default: ${threads} threads, a 4096-token context, ` +
        `${gpu === "auto" ? "GPU when llama.cpp finds one" : "CPU only"}. Load a model and optimize again to size the window to that file.`,
    };
  }

  // Never ask for more context than the model was trained with.
  const nativeContext = Math.max(0, Number(fileInfo?.contextLength) || 0);
  const ceiling = nativeContext > 0 ? Math.min(8192, nativeContext) : 8192;
  const choices = CONTEXT_CHOICES.filter((choice) => choice <= ceiling);
  const usable = available * HEADROOM;

  let chosen = null;
  for (const choice of choices) {
    if (estimateTotalBytes(weights, fileInfo, choice) <= usable) {
      chosen = choice;
      break;
    }
  }

  const smallest = choices.length ? choices[choices.length - 1] : 1024;
  const contextSize = chosen ?? smallest;
  const estimate = estimateTotalBytes(weights, fileInfo, contextSize);
  const weightBytes = Math.round(weights * 1.04);
  const kv = Math.max(0, estimate - weightBytes);
  const fits = chosen !== null;
  const headroomBytes = Math.max(0, available - estimate);

  const reason = fits
    ? `${formatBytes(estimate)} of the ${formatBytes(available)} budget: ${formatBytes(weights)} of weights plus ` +
      `${formatBytes(kv)} of KV cache at ${contextSize} tokens, leaving ${formatBytes(headroomBytes)} free for the rest of Windows.`
    : `This model needs ${formatBytes(estimate)} even at a ${contextSize}-token context, which is more than the ` +
      `${formatBytes(available)} budget. Close other apps, lower the context to the minimum, or use a smaller quant.`;

  return {
    threads,
    gpu,
    contextSize,
    fits,
    estimate,
    weights: weightBytes,
    kv,
    budget: available,
    headroomBytes,
    nativeContext: nativeContext || null,
    reason,
  };
}

/** Human list of what an optimize click actually changed, for the confirmation toast. */
export function describeChanges(current = {}, next = {}) {
  const changes = [];
  if (Number(current.threads) !== Number(next.threads)) changes.push(`threads ${current.threads} → ${next.threads}`);
  if (Number(current.contextSize) !== Number(next.contextSize)) {
    changes.push(`context ${current.contextSize} → ${next.contextSize} tokens`);
  }
  if (String(current.gpu) !== String(next.gpu)) changes.push(`acceleration ${current.gpu} → ${next.gpu}`);
  return changes;
}
