/**
 * Headless proof that an exported site's inference module really runs.
 *
 * It loads electron/templates/site/engine.js under Node, gives wllama an
 * in-memory storage backend (the browser uses OPFS), serves a tiny GGUF over
 * HTTP, and generates tokens. This exercises the same wllama + wasm path the
 * deployed website uses.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CacheManager } from "@wllama/wllama/esm/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const engineFile = path.join(root, "electron/templates/site/engine.js");
const modelFile = process.argv[2] ?? path.join(root, ".probe/tiny.gguf");
const wasmFile = path.join(root, "node_modules/@wllama/wllama/esm/wasm/wllama.wasm");

if (!fs.existsSync(modelFile)) {
  console.error(`Missing model file: ${modelFile}`);
  process.exit(1);
}

function memoryBackend() {
  const files = new Map();
  return {
    isSupported: () => true,
    read: async (key) => files.get(key) ?? null,
    write: async (key, stream) => {
      files.set(key, await new Response(stream).blob());
    },
    getSize: async (key) => (files.has(key) ? files.get(key).size : -1),
    list: async () => [...files.entries()].map(([key, blob]) => ({ key, size: blob.size })),
    delete: async (key) => {
      files.delete(key);
    },
  };
}

const server = http.createServer((req, res) => {
  const stat = fs.statSync(modelFile);
  res.writeHead(200, { "content-length": stat.size, "content-type": "application/octet-stream" });
  fs.createReadStream(modelFile).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const { SiteEngine } = await import(pathToFileURL(engineFile).href);

let checks = 0;
let failures = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const engine = new SiteEngine({
  modelUrl: `http://127.0.0.1:${port}/tiny.gguf`,
  wasmUrl: pathToFileURL(wasmFile).href,
  wllamaUrl: pathToFileURL(path.join(root, "node_modules/@wllama/wllama/esm/index.js")).href,
  cacheManager: new CacheManager([memoryBackend()]),
  contextSize: 256,
});

let lastPercent = 0;
const info = await engine.load({
  onProgress: ({ percent }) => {
    lastPercent = percent;
  },
  onStatus: (status) => console.log(`  · ${status}`),
});
check("engine reports loaded", info.loaded === true);
check("download progress reached 100%", lastPercent >= 100, `last=${lastPercent}`);

const chunks = [];
const text = await engine.generate({
  prompt: "Once upon a time",
  maxTokens: 16,
  temperature: 0.8,
  onToken: (piece) => chunks.push(piece),
});
check("generation produced text", text.trim().length > 0, JSON.stringify(text.slice(0, 80)));
check("streaming delivered token callbacks", chunks.length > 0, `chunks=${chunks.length}`);
check("streamed text matches return value", chunks.join("") === text);

await engine.dispose();
server.close();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
