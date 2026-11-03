/**
 * Vercel AI Gateway client.
 *
 * The gateway speaks the OpenAI Chat Completions API, so this is a small,
 * dependency-free HTTPS client: a real model list, real SSE streaming, real
 * cancellation. It runs only in the main process, which is what keeps the API
 * key out of the renderer entirely.
 *
 * Verified against:
 *   GET  {base}/models
 *   POST {base}/chat/completions   (stream: true)
 * with `Authorization: Bearer <key>`, base https://ai-gateway.vercel.sh/v1
 */

export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";

const LIST_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 180_000;

export class GatewayError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
  }
}

let active = null;

export function busy() {
  return Boolean(active);
}

/** Aborts the streaming request in flight, if any. */
export function stop() {
  if (!active) return false;
  active.abort();
  return true;
}

function loopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * A gateway URL has to be https, with one exception: a gateway you host
 * yourself on this machine. Trailing slashes are stripped so paths join cleanly.
 */
export function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname))) {
    throw new GatewayError("The gateway URL must start with https://.");
  }
  if (url.search || url.hash) {
    throw new GatewayError("The gateway URL must not include a query string or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function requireKey(apiKey) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    throw new GatewayError("No AI Gateway key is saved. Add one in Settings → Model source.");
  }
  return key;
}

function errorDetail(body) {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    /* not JSON: fall through to the raw text */
  }
  return String(body).replace(/\s+/g, " ").trim().slice(0, 300);
}

function statusMessage(status, body, context) {
  const detail = errorDetail(body);
  const suffix = detail ? ` Gateway said: ${detail}` : "";
  if (status === 401) {
    return new GatewayError(`The AI Gateway rejected this key (401 Unauthorized). Check that it is an AI Gateway key and still active.${suffix}`, { status });
  }
  if (status === 402) {
    return new GatewayError(`This key has no available credit on the AI Gateway (402 Payment Required).${suffix}`, { status });
  }
  if (status === 403) {
    return new GatewayError(`This key is not allowed to ${context} (403 Forbidden).${suffix}`, { status });
  }
  if (status === 404) {
    return new GatewayError(`The gateway has no such model for this key (404). Refresh the model list and pick one that is listed.${suffix}`, { status });
  }
  if (status === 429) {
    return new GatewayError(`The gateway is rate limiting this key (429). Wait a moment and send again.${suffix}`, { status });
  }
  if (status >= 500) {
    return new GatewayError(`The AI Gateway returned ${status}. That is a server-side failure, not something this app can fix.${suffix}`, { status });
  }
  return new GatewayError(`The AI Gateway refused the request (${status}).${suffix}`, { status });
}

function timeoutController(ms, external) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  const forward = () => controller.abort(external?.reason ?? new Error("aborted"));
  if (external) {
    if (external.aborted) forward();
    else external.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener("abort", forward);
    },
  };
}

/** Live model list for the saved key. Doubles as the key check: /models needs auth. */
export async function listModels({ apiKey, baseUrl, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const key = requireKey(apiKey);
  const base = normalizeBaseUrl(baseUrl);
  const guard = timeoutController(timeoutMs, null);

  let response;
  try {
    response = await fetch(`${base}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: guard.signal,
    });
  } catch (error) {
    if (guard.signal.aborted) throw new GatewayError(`The gateway did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    throw new GatewayError(`Could not reach ${base}. Check your connection or proxy. (${error.message})`);
  } finally {
    guard.dispose();
  }

  const body = await response.text();
  if (!response.ok) throw statusMessage(response.status, body, "list models");

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GatewayError("The gateway returned a model list that is not JSON.");
  }

  const rows = Array.isArray(parsed?.data) ? parsed.data : [];
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, ownedBy: typeof row?.owned_by === "string" ? row.owned_by : null });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { baseUrl: base, models };
}

/**
 * Streams one completion. Returns the same shape in spirit as the local engine:
 * the text, timing, and the provider's own token count when it reports one.
 */
export async function chat({
  apiKey,
  baseUrl,
  model,
  systemPrompt,
  history,
  prompt,
  temperature = 0.8,
  topP = 0.9,
  maxTokens = 512,
  signal,
  onDelta = () => {},
}) {
  const key = requireKey(apiKey);
  const base = normalizeBaseUrl(baseUrl);
  const modelId = String(model ?? "").trim();
  if (!modelId) throw new GatewayError("No gateway model is selected. Refresh the list in Settings → Model source and pick one.");
  if (!String(prompt ?? "").trim()) throw new GatewayError("Empty prompt.");
  if (active) throw new GatewayError("A response is already being generated.");

  const messages = [];
  if (String(systemPrompt ?? "").trim()) messages.push({ role: "system", content: String(systemPrompt) });
  for (const message of history ?? []) {
    if (!message || typeof message.content !== "string" || !message.content.trim()) continue;
    if (message.role === "user" || message.role === "assistant") {
      messages.push({ role: message.role, content: message.content });
    }
  }
  messages.push({ role: "user", content: String(prompt) });

  const controller = new AbortController();
  active = controller;
  const guard = timeoutController(CHAT_TIMEOUT_MS, signal ?? controller.signal);
  const stopSignal = signal ?? controller.signal;

  const startedAt = performance.now();
  let firstAt = null;
  let text = "";
  let chunks = 0;
  let usageTokens = null;

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: Number(temperature),
        top_p: Number(topP),
        max_tokens: Math.max(1, Math.round(Number(maxTokens) || 512)),
      }),
      signal: guard.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw statusMessage(response.status, body, "generate");
    }

    const contentType = String(response.headers.get("content-type") ?? "");
    if (!response.body || /json/i.test(contentType)) {
      const body = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* handled below */
      }
      if (parsed?.error) throw statusMessage(400, body, "generate");
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content === "string" && content) {
        text = content;
        onDelta(content);
      }
      const tokens = Number(parsed?.usage?.completion_tokens);
      usageTokens = Number.isFinite(tokens) ? tokens : null;
      const elapsedMs = performance.now() - startedAt;
      return {
        text,
        stats: {
          tokens: usageTokens,
          chunks: 1,
          elapsedMs: Math.round(elapsedMs),
          tokensPerSecond: usageTokens && elapsedMs > 0 ? Number(((usageTokens / elapsedMs) * 1000).toFixed(2)) : null,
          stopped: false,
        },
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          finished = true;
          break;
        }

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          // A malformed event is a provider bug, not a reason to discard the reply.
          continue;
        }
        if (event?.error) {
          throw new GatewayError(`The model returned an error mid-reply: ${event.error.message ?? JSON.stringify(event.error)}`);
        }
        const delta = event?.choices?.[0]?.delta;
        const piece = typeof delta?.content === "string" ? delta.content : "";
        if (piece) {
          if (firstAt === null) firstAt = performance.now();
          chunks += 1;
          text += piece;
          onDelta(piece);
        }
        const tokens = Number(event?.usage?.completion_tokens);
        if (Number.isFinite(tokens) && tokens > 0) usageTokens = tokens;
      }
    }
    await reader.cancel().catch(() => {});

    const finishedAt = performance.now();
    const elapsedMs = finishedAt - startedAt;
    const generationMs = firstAt ? finishedAt - firstAt : elapsedMs;
    return {
      text,
      stats: {
        tokens: usageTokens,
        chunks,
        elapsedMs: Math.round(elapsedMs),
        tokensPerSecond: usageTokens && generationMs > 0 ? Number(((usageTokens / generationMs) * 1000).toFixed(2)) : null,
        stopped: false,
      },
    };
  } catch (error) {
    if (stopSignal.aborted || controller.signal.aborted) {
      const elapsedMs = performance.now() - startedAt;
      return {
        text,
        stats: {
          tokens: usageTokens,
          chunks,
          elapsedMs: Math.round(elapsedMs),
          tokensPerSecond: null,
          stopped: true,
        },
      };
    }
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(`The connection to the gateway failed: ${error.message}`);
  } finally {
    guard.dispose();
    if (active === controller) active = null;
  }
}
