/**
 * Builds a site with electron/lib/site-export.js, checks the folder is complete,
 * then imports the *exported* engine.js and runs real wasm inference through the
 * vendored wllama bundle.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CacheManager } from "@wllama/wllama/esm/index.js";
import { exportSite, defaultConfig } from "../electron/lib/site-export.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const modelFile = process.argv[2] ?? path.join(root, ".probe/tiny.gguf");
const outDir = path.join(root, ".probe/site");

if (!fs.existsSync(modelFile)) {
  console.error(`Missing model file: ${modelFile}`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });

const server = http.createServer((req, res) => {
  const stat = fs.statSync(modelFile);
  res.writeHead(200, { "content-length": stat.size, "content-type": "application/octet-stream" });
  fs.createReadStream(modelFile).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

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

const built = exportSite({
  outDir,
  overwrite: true,
  config: defaultConfig({
    title: "Test Site",
    modelUrl: `http://127.0.0.1:${port}/model.gguf`,
    modelName: "tiny",
  }),
});

const present = (name) => fs.existsSync(path.join(outDir, name));
for (const name of ["index.html", "style.css", "app.js", "engine.js", "config.json", "vercel.json", "README.md", "vendor/wllama/wllama.js", "vendor/wllama/wllama.wasm"]) {
  check(`site contains ${name}`, present(name));
}

const config = JSON.parse(fs.readFileSync(path.join(outDir, "config.json"), "utf8"));
check("config points at the model URL", config.modelUrl === `http://127.0.0.1:${port}/model.gguf`);
check("readme title substituted", fs.readFileSync(path.join(outDir, "README.md"), "utf8").includes("# Test Site"));
check("wasm bundle is non-trivial", fs.statSync(path.join(outDir, "vendor/wllama/wllama.wasm")).size > 100_000);
check("no absolute local paths leaked", !built.files.some((file) => file.path.includes("\\")));

const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
check("html loads the site app", html.includes('src="./app.js"'));
check("html references the stylesheet", html.includes('href="./style.css"'));

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

const { SiteEngine } = await import(pathToFileURL(path.join(outDir, "engine.js")).href);
const engine = new SiteEngine({
  modelUrl: config.modelUrl,
  wasmUrl: pathToFileURL(path.join(outDir, "vendor/wllama/wllama.wasm")).href,
  wllamaUrl: pathToFileURL(path.join(outDir, "vendor/wllama/wllama.js")).href,
  cacheManager: new CacheManager([memoryBackend()]),
  contextSize: 256,
});

let progress = 0;
const info = await engine.load({ onProgress: ({ percent }) => (progress = percent) });
check("exported engine loads the model", info.loaded === true);
check("exported engine reports progress", progress >= 100, `progress=${progress}`);

const streamed = [];
const text = await engine.generate({ prompt: "Once upon a time", maxTokens: 16, onToken: (piece) => streamed.push(piece) });
check("exported engine generates text", text.trim().length > 0, JSON.stringify(text.slice(0, 60)));
check("exported engine streams", streamed.length > 0 && streamed.join("") === text);

await engine.dispose();
server.close();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
