/**
 * Exercises the AI Gateway client and the key-sealing helpers against a real
 * HTTP server on loopback.
 *
 * Nothing here is a stand-in for the production path: the same fetch, the same
 * SSE parser, the same abort handling. Only the far end is local, which is the
 * only way to test streaming, cancellation and error mapping deterministically.
 */

import http from "node:http";
import { GatewayError, chat, listModels, normalizeBaseUrl, stop } from "../electron/lib/gateway.js";
import { openSecret, redactSettings, sealSecret } from "../electron/lib/secrets.js";

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function sse(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
}

function delta(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization ?? "";

  if (req.method === "GET" && req.url === "/v1/models") {
    if (auth !== "Bearer good-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "zeta/model", object: "model", owned_by: "zeta" },
          { id: "anthropic/claude-x", object: "model", owned_by: "anthropic" },
          { id: "anthropic/claude-x", object: "model", owned_by: "anthropic" },
          { id: "openai/gpt-y", object: "model", owned_by: "openai" },
        ],
      }),
    );
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const model = body.model;

    if (model === "test/rate") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded", code: "rate_limit" } }));
      return;
    }

    if (model === "test/json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "plain json reply" } }], usage: { completion_tokens: 3 } }));
      return;
    }

    sse(res);

    if (model === "test/split") {
      // One event delivered in two HTTP writes: the parser must buffer.
      res.write('data: {"choices":[{"delta":{"cont');
      await new Promise((resolve) => setTimeout(resolve, 25));
      res.write('ent":"split ok"}}]}\n\ndata: [DONE]\n\n');
      res.end();
      return;
    }

    if (model === "test/boom") {
      res.write(delta("partial "));
      res.write(`data: ${JSON.stringify({ error: { message: "provider exploded" } })}\n\n`);
      res.end();
      return;
    }

    if (model === "test/slow") {
      res.write(delta("first "));
      // Keep the socket open until the client aborts.
      req.on("close", () => res.end());
      return;
    }

    res.write(delta("Hello "));
    await new Promise((resolve) => setTimeout(resolve, 15));
    res.write(delta("world."));
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 7 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
console.log(`gateway test server on ${base}\n`);

try {
  await check("normalizeBaseUrl accepts https and strips trailing slashes", () => {
    assertEqual(normalizeBaseUrl("https://ai-gateway.vercel.sh/v1///"), "https://ai-gateway.vercel.sh/v1", "base url");
  });

  await check("normalizeBaseUrl allows a loopback gateway over http", () => {
    assertEqual(normalizeBaseUrl("http://127.0.0.1:8787/v1"), "http://127.0.0.1:8787/v1", "loopback url");
  });

  await check("normalizeBaseUrl refuses plain http to a remote host", () => {
    let threw = false;
    try {
      normalizeBaseUrl("http://example.com/v1");
    } catch (error) {
      threw = error instanceof GatewayError;
    }
    assert(threw, "expected a GatewayError for http://example.com");
  });

  await check("listModels returns a sorted, de-duplicated live list", async () => {
    const result = await listModels({ apiKey: "good-key", baseUrl: base });
    assertEqual(result.models.length, 3, "model count");
    assertEqual(result.models[0].id, "anthropic/claude-x", "first model");
    assertEqual(result.models[2].ownedBy, "zeta", "owner passthrough");
  });

  await check("listModels reports a rejected key with the status and reason", async () => {
    let message = "";
    try {
      await listModels({ apiKey: "bad-key", baseUrl: base });
    } catch (error) {
      message = error.message;
    }
    assert(/401/.test(message), `expected 401 in "${message}"`);
    assert(/Invalid API key/.test(message), "expected the gateway's own message");
  });

  await check("listModels refuses to call out without a key", async () => {
    let message = "";
    try {
      await listModels({ apiKey: "  ", baseUrl: base });
    } catch (error) {
      message = error.message;
    }
    assert(/No AI Gateway key/.test(message), `unexpected: ${message}`);
  });

  await check("chat streams deltas in order and reports the provider's token count", async () => {
    const seen = [];
    const result = await chat({
      apiKey: "good-key",
      baseUrl: base,
      model: "test/stream",
      prompt: "hi",
      onDelta: (piece) => seen.push(piece),
    });
    assertEqual(JSON.stringify(seen), JSON.stringify(["Hello ", "world."]), "delta order");
    assertEqual(result.text, "Hello world.", "full text");
    assertEqual(result.stats.tokens, 7, "usage tokens");
    assertEqual(result.stats.stopped, false, "not stopped");
    assert(result.stats.tokensPerSecond > 0, "tokens per second should be measured");
  });

  await check("chat reassembles an event split across two writes", async () => {
    const result = await chat({ apiKey: "good-key", baseUrl: base, model: "test/split", prompt: "hi" });
    assertEqual(result.text, "split ok", "buffered text");
  });

  await check("chat accepts a non-streaming JSON reply", async () => {
    const result = await chat({ apiKey: "good-key", baseUrl: base, model: "test/json", prompt: "hi" });
    assertEqual(result.text, "plain json reply", "json text");
    assertEqual(result.stats.tokens, 3, "json usage");
  });

  await check("stop() aborts the stream and keeps the partial text", async () => {
    const controller = new AbortController();
    const result = await chat({
      apiKey: "good-key",
      baseUrl: base,
      model: "test/slow",
      prompt: "hi",
      signal: controller.signal,
      onDelta() {
        controller.abort();
      },
    });
    assertEqual(result.stats.stopped, true, "stopped flag");
    assertEqual(result.text, "first ", "partial text kept");
    assertEqual(stop(), false, "nothing left to stop afterwards");
  });

  await check("module-level stop() cancels an in-flight request", async () => {
    const pending = chat({ apiKey: "good-key", baseUrl: base, model: "test/slow", prompt: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEqual(stop(), true, "stop should report that it cancelled something");
    const result = await pending;
    assertEqual(result.stats.stopped, true, "stopped flag");
  });

  await check("an error event mid-stream surfaces instead of being swallowed", async () => {
    let message = "";
    try {
      await chat({ apiKey: "good-key", baseUrl: base, model: "test/boom", prompt: "hi" });
    } catch (error) {
      message = error.message;
    }
    assert(/mid-reply/.test(message) && /provider exploded/.test(message), `unexpected: ${message}`);
  });

  await check("HTTP 429 maps to an actionable rate-limit message", async () => {
    let message = "";
    try {
      await chat({ apiKey: "good-key", baseUrl: base, model: "test/rate", prompt: "hi" });
    } catch (error) {
      message = error.message;
    }
    assert(/429/.test(message), `expected 429 in "${message}"`);
    assert(/Rate limit exceeded/.test(message), "expected the provider message");
  });

  await check("chat refuses an empty model id before any request", async () => {
    let message = "";
    try {
      await chat({ apiKey: "good-key", baseUrl: base, model: "", prompt: "hi" });
    } catch (error) {
      message = error.message;
    }
    assert(/No gateway model/.test(message), `unexpected: ${message}`);
  });

  // ----------------------------------------------------------------- secrets

  const sealedStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (buffer) => Buffer.from(buffer).toString("utf8").replace(/^sealed:/, ""),
  };

  await check("a key sealed with OS encryption round-trips without being stored in the clear", () => {
    const stored = sealSecret("sk-gateway-abcdef123456", sealedStorage);
    assert(stored.gatewayApiKey.startsWith("enc:v1:"), "expected the encrypted form");
    assert(!stored.gatewayApiKey.includes("abcdef123456"), "the raw key must not appear in the stored value");
    assertEqual(stored.gatewayKeyHint, "••••3456", "hint");
    assertEqual(stored.gatewayKeyEncrypted, true, "encrypted flag");
    assertEqual(openSecret(stored.gatewayApiKey, sealedStorage), "sk-gateway-abcdef123456", "round trip");
  });

  await check("without OS encryption the key is still kept out of the renderer, and flagged", () => {
    const noStorage = { isEncryptionAvailable: () => false };
    const stored = sealSecret("sk-plain-999", noStorage);
    assert(stored.gatewayApiKey.startsWith("plain:v1:"), "expected the fallback form");
    assertEqual(stored.gatewayKeyEncrypted, false, "encrypted flag");
    assertEqual(openSecret(stored.gatewayApiKey, noStorage), "sk-plain-999", "round trip");
  });

  await check("a key sealed by another machine cannot be opened here", () => {
    const stored = sealSecret("sk-other-machine-1234", sealedStorage);
    const broken = {
      isEncryptionAvailable: () => true,
      decryptString: () => {
        throw new Error("DPAPI: wrong user");
      },
    };
    assertEqual(openSecret(stored.gatewayApiKey, broken), "", "unreadable key becomes empty");
  });

  await check("redactSettings strips the key and reports whether one is set", () => {
    const redacted = redactSettings({
      provider: "gateway",
      gatewayApiKey: "enc:v1:secret",
      gatewayKeyHint: "••••0001",
      temperature: 0.7,
    });
    assert(!("gatewayApiKey" in redacted), "the key must not survive redaction");
    assertEqual(redacted.gatewayKeySet, true, "key set flag");
    assertEqual(redacted.gatewayKeyHint, "••••0001", "hint survives");
    assertEqual(redacted.provider, "gateway", "other settings survive");
  });
} finally {
  server.close();
}

console.log(`\n${passed}/${passed + failures.length} gateway checks passed`);
if (failures.length) {
  console.error("failures:", failures.map((failure) => failure.name));
  process.exitCode = 1;
}
