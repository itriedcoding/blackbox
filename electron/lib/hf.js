/**
 * Hugging Face Hub API client (runs in the Electron main process).
 *
 * Endpoints used, all documented in https://huggingface.co/.well-known/openapi.md:
 *   GET /api/models?search=...&filter=gguf&sort=downloads   -> model search
 *   GET /api/models/{repo}?blobs=true                       -> repo metadata (gated flag, tags)
 *   GET /api/models/{repo}/tree/{rev}?recursive=true        -> file listing with real sizes
 *   GET /{repo}/resolve/{rev}/{path}                        -> file bytes (302/307 -> CDN)
 */

const BASE = "https://huggingface.co";
const USER_AGENT = "Blackbox/1.0 (local desktop client)";
const REQUEST_TIMEOUT_MS = 20000;

function headersFor(token) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function describeStatus(status) {
  switch (status) {
    case 401:
    case 404:
      return "Repository not found. Check the ID, or add a Hugging Face token in Settings if it is private or gated.";
    case 403:
      return "Access to this repository is gated. Accept its terms on huggingface.co and add an access token in Settings.";
    case 429:
      return "Hugging Face is rate limiting this machine. Wait a minute, or add an access token in Settings.";
    default:
      return `Hugging Face returned HTTP ${status}.`;
  }
}

async function fetchJson(path, { token, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Hugging Face request timed out.")), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${BASE}${path}`, {
      headers: headersFor(token),
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      const error = new Error(describeStatus(response.status));
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(signal?.aborted ? "Request cancelled." : "Hugging Face request timed out.");
    }
    if (error instanceof TypeError) {
      throw new Error("Could not reach huggingface.co. Check the internet connection.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

const QUANT_PATTERN =
  /(IQ\d+_[A-Z]+|Q\d+_K_[SML]|Q\d+_K|Q\d+_\d+_\d+|Q\d+_\d+|Q\d+_0|Q\d+|BF16|F16|F32)/i;

export function quantFromFilename(filename) {
  const base = filename.split("/").pop() ?? filename;
  const withoutExt = base.replace(/\.gguf$/i, "");
  const match = withoutExt.match(QUANT_PATTERN);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

export function shardIndex(filename) {
  const match = filename.match(/-(\d{5})-of-(\d{5})\.gguf$/i);
  return match ? { index: Number(match[1]), total: Number(match[2]) } : null;
}

/** Trim a user supplied string into a Hub repo id ("owner/name"). */
export function normalizeRepoId(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value) return null;

  value = value.replace(/^https?:\/\/(www\.)?huggingface\.co\//i, "");
  value = value.replace(/^(datasets|spaces|models)\//i, "");
  value = value.split(/[?#]/)[0];
  value = value.replace(/^\/*/, "").replace(/\/+$/, "");

  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

const UNCENSORED_HINTS = /(abliterat|uncensor|unfiltered|heretic|dolphin|nsfw|lexi|amoral|de-censor)/i;

export async function searchModels({ query = "", token, limit = 30, uncensoredOnly = false } = {}) {
  const params = new URLSearchParams({
    filter: "gguf",
    sort: "downloads",
    direction: "-1",
    limit: String(Math.min(Math.max(limit, 1), 60)),
    full: "true",
  });
  const trimmed = String(query).trim();
  if (trimmed) params.set("search", trimmed);

  const results = await fetchJson(`/api/models?${params.toString()}`, { token });
  if (!Array.isArray(results)) return [];

  const mapped = results.map((model) => ({
    id: model.id ?? model.modelId,
    author: model.author ?? (model.id ?? "").split("/")[0],
    downloads: model.downloads ?? 0,
    likes: model.likes ?? 0,
    lastModified: model.lastModified ?? null,
    gated: Boolean(model.gated),
    tags: Array.isArray(model.tags) ? model.tags.slice(0, 12) : [],
    uncensored:
      UNCENSORED_HINTS.test(model.id ?? "") ||
      (Array.isArray(model.tags) && model.tags.some((tag) => UNCENSORED_HINTS.test(tag))),
  }));

  return uncensoredOnly ? mapped.filter((model) => model.uncensored) : mapped;
}

export async function getRepoInfo(repoId, { token } = {}) {
  const id = normalizeRepoId(repoId);
  if (!id) throw new Error("Enter a repository ID like owner/model-name.");
  const model = await fetchJson(`/api/models/${id}?blobs=true`, { token });
  return {
    id: model.id ?? id,
    author: model.author ?? id.split("/")[0],
    downloads: model.downloads ?? 0,
    likes: model.likes ?? 0,
    gated: Boolean(model.gated),
    tags: Array.isArray(model.tags) ? model.tags : [],
    pipelineTag: model.pipeline_tag ?? null,
    lastModified: model.lastModified ?? null,
  };
}

/**
 * List every .gguf file in a repo with its real byte size from the Hub tree API.
 * Vision projectors (mmproj) are excluded; they are not chat weights.
 */
export async function listGgufFiles(repoId, { token } = {}) {
  const id = normalizeRepoId(repoId);
  if (!id) throw new Error("Enter a repository ID like owner/model-name.");

  const tree = await fetchJson(`/api/models/${id}/tree/main?recursive=true`, { token });
  if (!Array.isArray(tree)) throw new Error("Hugging Face returned an unexpected file listing.");

  const files = tree
    .filter((entry) => entry.type === "file" && /\.gguf$/i.test(entry.path))
    .filter((entry) => !/mmproj/i.test(entry.path))
    .map((entry) => {
      const shard = shardIndex(entry.path);
      return {
        path: entry.path,
        filename: entry.path.split("/").pop(),
        size: Number(entry.size ?? entry.lfs?.size ?? 0),
        quant: quantFromFilename(entry.path),
        shard,
        splitted: Boolean(shard) && shard.total > 1,
      };
    })
    .sort((a, b) => a.size - b.size);

  if (files.length === 0) {
    throw new Error("That repository has no GGUF files. Pick a repo ending in -GGUF.");
  }
  return files;
}

export function resolveUrl(repoId, filePath, revision = "main") {
  const id = normalizeRepoId(repoId);
  const encoded = String(filePath)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${BASE}/${id}/resolve/${revision}/${encoded}?download=true`;
}
