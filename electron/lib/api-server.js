/**
 * Local, OpenAI-compatible HTTP server backed by the same llama.cpp engine the
 * chat window uses. Nothing is forwarded anywhere: requests are answered by the
 * model loaded on this machine.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream: true or false)
 *
 * Auth: `Authorization: Bearer bb_...` when requireKey is on.
 */

import http from "node:http";
import crypto from "node:crypto";

const MAX_BODY = 8 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, type = "invalid_request_error", code = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const type = error instanceof HttpError ? error.type : "server_error";
  const code = error instanceof HttpError ? error.code : null;
  sendJson(res, status, { error: { message: String(error.message ?? error), type, code, param: null } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Request body is too large.", "invalid_request_error", "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "Body is not valid JSON.", "invalid_request_error", "invalid_json"));
      }
    });
    req.on("error", (error) => reject(new HttpError(400, error.message)));
  });
}

/** Convert OpenAI chat messages into the engine's prompt + history shape. */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, "'messages' must be a non-empty array.", "invalid_request_error", "messages_required");
  }
  const cleaned = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (!["system", "user", "assistant"].includes(role)) {
      throw new HttpError(400, `Unsupported role: ${String(role)}`, "invalid_request_error", "bad_role");
    }
    let content = message.content;
    if (Array.isArray(content)) {
      content = content
        .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (typeof content !== "string") content = content == null ? "" : String(content);
    cleaned.push({ role, content });
  }
  const systemMessage = cleaned.find((message) => message.role === "system");
  const conversation = cleaned.filter((message) => message.role !== "system");
  const last = conversation[conversation.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    throw new HttpError(400, "The last message must be a non-empty user message.", "invalid_request_error", "user_message_required");
  }
  return {
    systemPrompt: systemMessage?.content ?? null,
    history: conversation.slice(0, -1),
    prompt: last.content,
  };
}

function modelIdFor(status) {
  if (!status?.modelName) return "blackbox-local";
  return status.modelName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "blackbox-local";
}

function rateLimiter(limitPerMinute) {
  const hits = new Map();
  return (id) => {
    const now = Date.now();
    const windowStart = now - 60_000;
    const list = (hits.get(id) ?? []).filter((at) => at > windowStart);
    if (list.length >= limitPerMinute) {
      hits.set(id, list);
      const retryAfter = Math.max(1, Math.ceil((list[0] + 60_000 - now) / 1000));
      return { allowed: false, retryAfter };
    }
    list.push(now);
    hits.set(id, list);
    return { allowed: true, remaining: Math.max(0, limitPerMinute - list.length) };
  };
}

export function createApiServer({ engine, keyStore, getConfig }) {
  let server = null;
  let bound = { host: null, port: null };
  const startedAt = Date.now();
  const limit = (id) => rateLimiter(getConfig().rateLimit ?? 60)(id);

  function authenticate(req) {
    const config = getConfig();
    if (!config.requireKey) return { id: "anonymous", name: "anonymous" };
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "Missing API key. Send 'Authorization: Bearer <key>'.", "authentication_error", "missing_key");
    const record = keyStore.verify(token);
    if (!record) throw new HttpError(401, "Invalid API key.", "authentication_error", "invalid_key");
    return record;
  }

  async function chat(body, res, identity) {
    const status = engine.status();
    if (!status.loaded) throw new HttpError(503, "No model is loaded in Blackbox. Load a model first.", "server_error", "no_model");
    if (status.busy) throw new HttpError(429, "The model is busy with another generation. Retry shortly.", "rate_limit_error", "model_busy");

    const { systemPrompt, history, prompt } = normalizeMessages(body.messages);
    const config = getConfig();
    const wantsStream = Boolean(body.stream);
    const maxTokens = Math.min(4096, Math.max(1, Math.round(Number(body.max_tokens ?? body.max_completion_tokens ?? 512) || 512)));
    const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.8;
    const topP = Number.isFinite(Number(body.top_p)) ? Number(body.top_p) : 0.9;
    const topK = Number.isFinite(Number(body.top_k)) ? Number(body.top_k) : 40;
    const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || modelIdFor(status);

    if (!wantsStream) {
      const result = await engine.chat({
        chatId: `api-${crypto.randomUUID()}`,
        systemPrompt: systemPrompt ?? config.systemPrompt,
        history,
        prompt,
        temperature,
        topP,
        topK,
        maxTokens,
      });
      keyStore.recordUse?.(identity.id);
      return sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: null,
          completion_tokens: result.stats?.tokens ?? null,
          total_tokens: result.stats?.tokens ?? null,
        },
      });
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });

    const write = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    write({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    try {
      const result = await engine.chat({
        chatId: `api-${crypto.randomUUID()}`,
        systemPrompt: systemPrompt ?? config.systemPrompt,
        history,
        prompt,
        temperature,
        topP,
        topK,
        maxTokens,
        onDelta: (text) => {
          if (closed) return;
          write({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        },
      });
      keyStore.recordUse?.(identity.id);
      write({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: result.stats?.stopped ? "length" : "stop" }],
        usage: { completion_tokens: result.stats?.tokens ?? null, total_tokens: result.stats?.tokens ?? null },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      if (!res.headersSent) return sendError(res, error);
      if (!closed) {
        write({ error: { message: String(error.message ?? error), type: "server_error" } });
        res.end();
      }
    }
  }

  const handler = async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-max-age": "600",
        });
        return res.end();
      }

      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        const status = engine.status();
        return sendJson(res, 200, {
          status: "ok",
          model: status.modelName,
          loaded: status.loaded,
          busy: status.busy,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        });
      }

      const identity = authenticate(req);
      const verdict = limit(identity.id);
      if (!verdict.allowed) {
        return sendJson(res, 429, { error: { message: "Rate limit exceeded.", type: "rate_limit_error", code: "rate_limited" } }, { "retry-after": String(verdict.retryAfter) });
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const status = engine.status();
        const id = modelIdFor(status);
        return sendJson(res, 200, {
          object: "list",
          data: [{ id, object: "model", created: Math.floor(startedAt / 1000), owned_by: "blackbox" }],
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readBody(req);
        return await chat(body, res, identity);
      }

      throw new HttpError(404, `Unknown route: ${req.method} ${url.pathname}`, "invalid_request_error", "unknown_route");
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else res.end();
    }
  };

  return {
    async start({ port = 8765, host = "127.0.0.1" } = {}) {
      if (server) return this.status();
      server = http.createServer(handler);
      server.keepAliveTimeout = 5_000;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      bound = { host, port: server.address().port };
      return this.status();
    },
    async stop() {
      if (!server) return false;
      const current = server;
      server = null;
      await new Promise((resolve) => current.close(() => resolve()));
      bound = { host: null, port: null };
      return true;
    },
    status() {
      return {
        running: Boolean(server),
        host: bound.host,
        port: bound.port,
        urls: bound.port
          ? [
              `http://127.0.0.1:${bound.port}/v1`,
              ...(bound.host === "0.0.0.0" ? [`http://<this machine's LAN IP>:${bound.port}/v1`] : []),
            ]
          : [],
      };
    },
  };
}
