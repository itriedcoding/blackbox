/**
 * Quantization ranking and RAM budgeting.
 * Everything here is derived from the actual file listing returned by the Hub,
 * so the sizes shown to the user are the sizes on disk.
 */

// What we actually recommend on a CPU. Lossless formats (F16/BF16/F32) are offered
// in the file list but never auto-picked: they double the bytes for no useful gain
// in chat quality, and CPU throughput drops noticeably.
const RECOMMEND_ORDER = [
  "Q4_K_M",
  "Q5_K_M",
  "Q6_K",
  "Q8_0",
  "Q4_K_S",
  "IQ4_XS",
  "Q4_1",
  "Q4_0",
  "Q5_K_S",
  "IQ3_M",
  "Q3_K_M",
  "Q3_K_S",
  "IQ2_M",
  "Q2_K",
  "IQ2_S",
  "IQ2_XS",
  "IQ1_S",
];

const RUNTIME_OVERHEAD_BYTES = 400 * 1024 * 1024; // llama.cpp + Electron headroom

function recommendRank(quant) {
  const index = RECOMMEND_ORDER.indexOf(String(quant).toUpperCase());
  return index === -1 ? RECOMMEND_ORDER.length + 1 : index;
}

export function describeQuant(quant) {
  const q = String(quant).toUpperCase();
  if (q === "F16" || q === "BF16" || q === "F32") return "Lossless, slow on CPU";
  if (q === "Q8_0") return "Near lossless";
  if (q.startsWith("Q6")) return "Very high quality";
  if (q.startsWith("Q5")) return "High quality";
  if (q === "Q4_K_M") return "Best size/quality balance";
  if (q.startsWith("Q4")) return "Compact";
  if (q.startsWith("IQ4")) return "Compact, i-quant";
  if (q.startsWith("Q3") || q.startsWith("IQ3")) return "Small, some quality loss";
  if (q.startsWith("Q2") || q.startsWith("IQ2")) return "Tiny, noticeable quality loss";
  if (q.startsWith("IQ1") || q.startsWith("Q1")) return "Extreme compression";
  return "GGUF quant";
}

/** Usable RAM for model weights + KV cache on this machine right now. */
export function ramBudget({ totalMem, freeMem }) {
  const usable = Math.min(freeMem, totalMem * 0.92);
  return Math.max(0, Math.floor(usable - RUNTIME_OVERHEAD_BYTES));
}

/**
 * KV cache size for a context window, from GGUF architecture metadata.
 * Falls back to a file-size based estimate when metadata is unavailable.
 */
export function estimateContextBytes(fileInfo, contextSize) {
  const perToken = Number(fileInfo?.kvBytesPerToken);
  if (Number.isFinite(perToken) && perToken > 0) {
    return Math.round(perToken * contextSize);
  }
  const size = Number(fileInfo?.fileSize) || 0;
  return Math.round((size / 1_000_000_000) * 40_000 * contextSize);
}

export function estimateTotalBytes(fileSize, fileInfo, contextSize) {
  const weights = Number(fileSize) * 1.04; // mmap page overhead
  return Math.round(weights + estimateContextBytes(fileInfo, contextSize));
}

/**
 * Pick the best single-file quant that fits the budget.
 * Returns { file, fits, reason } where file is the best candidate even when
 * nothing fits (so the UI can explain what the smallest option costs).
 */
export function pickRecommendedFile(files, budgetBytes) {
  const single = files.filter((file) => !file.splitted && file.size > 0);
  if (single.length === 0) return { file: null, fits: false, reason: "No single-file GGUF quant available." };

  const sorted = [...single].sort((a, b) => {
    const rank = recommendRank(a.quant) - recommendRank(b.quant);
    return rank !== 0 ? rank : a.size - b.size;
  });

  const fitting = sorted.filter((file) => file.size <= budgetBytes);
  if (fitting.length > 0) {
    return { file: fitting[0], fits: true, reason: null };
  }
  return {
    file: sorted[0],
    fits: false,
    reason: `The smallest quant for this model is ${formatBytes(sorted[0].size)} and the RAM budget is ${formatBytes(budgetBytes)}.`,
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  const digits = scaled >= 100 || exponent === 0 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[exponent]}`;
}
