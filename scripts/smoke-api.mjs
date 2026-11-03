/**
 * End-to-end check of the local API: real llama.cpp generation served over HTTP.
 * Uses a tiny GGUF so it runs anywhere; the server code is the one that ships.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../electron/lib/engine.js";
import { ApiKeyStore } from "../electron/lib/apikeys.js";
import { createApiServer } from "../electron/lib/api-server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const modelPath = process.argv[2] ?? path.join(root, ".probe/tiny.gguf");
if (!fs.existsSync(modelPath)) {
  console.error(`Missing model: ${modelPath}`);
  process.exit(1);
}

let checks = 0;
let failures = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

await engine.load({ modelPath, contextSize: 256, threads: 2 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-api-"));
const keyStore = new ApiKeyStore(path.join(dir, "keys.json"));
const api = createApiServer({
  engine,
  keyStore,
  getConfig: () => ({ systemPrompt: "Answer briefly.", requireKey: true, rateLimit: 50 }),
});
const status = await api.start({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${status.port}`;
const created = keyStore.create("test key");
const auth = { authorization: `Bearer ${created.key}`, "content-type": "application/json" };

const health = await fetch(`${base}/health`);
const healthBody = await health.json();
check("health responds", health.ok && healthBody.status === "ok");
check("health reports the model", Boolean(healthBody.model), JSON.stringify(healthBody));

const unauth = await fetch(`${base}/v1/models`);
check("models requires a key", unauth.status === 401);
const bad = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer bb_wrong" } });
check("rejects an invalid key", bad.status === 401);

const models = await fetch(`${base}/v1/models`, { headers: auth });
const modelList = await models.json();
check("models lists one model", models.ok && modelList.data.length === 1, JSON.stringify(modelList).slice(0, 120));

const reply = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ messages: [{ role: "user", content: "Say hello." }], max_tokens: 12, temperature: 0.2 }),
});
const replyBody = await reply.json();
const content = replyBody?.choices?.[0]?.message?.content ?? "";
check("non-stream completion returns content", reply.ok && content.length > 0, JSON.stringify(replyBody).slice(0, 200));
check("non-stream response has usage", typeof replyBody?.usage?.completion_tokens === "number");

const stream = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ messages: [{ role: "user", content: "Count: one," }], max_tokens: 12, stream: true }),
});
const text = await stream.text();
const deltas = text
  .split("\n")
  .filter((line) => line.startsWith("data: {") && line.includes('"content"'))
  .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content)
  .join("");
check("stream is event-stream", (stream.headers.get("content-type") || "").includes("text/event-stream"));
check("stream delivers deltas", deltas.length > 0, JSON.stringify(deltas.slice(0, 60)));
check("stream terminates with [DONE]", text.trim().endsWith("[DONE]"));

const preflight = await fetch(`${base}/v1/chat/completions`, { method: "OPTIONS" });
check("CORS preflight is answered", preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === "*");
check("key usage was recorded", keyStore.list()[0].requests >= 2, String(keyStore.list()[0].requests));

const missingModel = await fetch(`${base}/v1/nope`, { headers: auth });
check("unknown route is a clean 404", missingModel.status === 404);

await api.stop();
await engine.unload();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
