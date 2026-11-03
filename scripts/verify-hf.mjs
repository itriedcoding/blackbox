/**
 * Live check of the Hugging Face client the app actually ships.
 *
 * This talks to huggingface.co with the same module the IPC handlers use, so a
 * failure here means Discover is broken for real users, not that a fixture
 * drifted. No token is needed: everything below is public.
 *
 *   node scripts/verify-hf.mjs
 */

import {
  getRepoInfo,
  listGgufFiles,
  normalizeRepoId,
  quantFromFilename,
  resolveUrl,
  searchModels,
  shardIndex,
} from "../electron/lib/hf.js";

const REPO = "mradermacher/Qwen2.5-0.5B-Instruct-abliterated-GGUF";

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

console.log("huggingface.co live checks\n");

await check("normalizeRepoId accepts the shapes users paste", () => {
  const cases = new Map([
    ["mradermacher/Qwen2.5-0.5B-Instruct-abliterated-GGUF", "mradermacher/Qwen2.5-0.5B-Instruct-abliterated-GGUF"],
    ["https://huggingface.co/mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF", "mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF"],
    ["https://huggingface.co/mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF/tree/main", "mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF"],
    ["models/QuantFactory/Llama-3.2-3B-Instruct-abliterated-GGUF", "QuantFactory/Llama-3.2-3B-Instruct-abliterated-GGUF"],
    ["  org/name  ", "org/name"],
  ]);
  for (const [input, expected] of cases) {
    const actual = normalizeRepoId(input);
    assert(actual === expected, `${JSON.stringify(input)} -> ${JSON.stringify(actual)}, expected ${expected}`);
  }
  assert(normalizeRepoId("just-a-name") === null, "a bare name must be rejected");
  assert(normalizeRepoId("") === null, "empty input must be rejected");
});

await check("quantFromFilename reads real GGUF quant names", () => {
  const cases = new Map([
    ["model.Q4_K_M.gguf", "Q4_K_M"],
    ["nested/dir/model-IQ3_XS.gguf", "IQ3_XS"],
    ["model.Q8_0.gguf", "Q8_0"],
    ["weights.f16.gguf", "F16"],
    ["plain.gguf", "UNKNOWN"],
  ]);
  for (const [file, expected] of cases) {
    const actual = quantFromFilename(file);
    assert(actual === expected, `${file} -> ${actual}, expected ${expected}`);
  }
});

await check("shardIndex detects split quants only", () => {
  const split = shardIndex("model-00002-of-00003.gguf");
  assert(split && split.index === 2 && split.total === 3, `unexpected shard ${JSON.stringify(split)}`);
  assert(shardIndex("model.Q4_K_M.gguf") === null, "single files must not look split");
});

await check("searchModels returns real Hub results for a query", async () => {
  const results = await searchModels({ query: "abliterated", limit: 8, uncensoredOnly: true });
  assert(Array.isArray(results) && results.length > 0, "expected at least one result");
  for (const result of results) {
    assert(/^[^/]+\/[^/]+$/.test(result.id), `bad repo id ${JSON.stringify(result.id)}`);
    assert(result.uncensored === true, `${result.id} should be marked uncensored`);
    assert(typeof result.downloads === "number" && result.downloads >= 0, "downloads must be a number");
  }
  console.log(`      ${results.length} results, top: ${results[0].id}`);
});

await check("searchModels works with an empty query (browse mode)", async () => {
  const results = await searchModels({ query: "", limit: 5 });
  assert(results.length > 0, "browse returned nothing");
  assert(results.every((result) => typeof result.id === "string"), "browse rows must have ids");
});

await check("searchModels caps the limit instead of trusting the caller", async () => {
  const results = await searchModels({ query: "gguf", limit: 500 });
  assert(results.length <= 60, `limit was not capped: ${results.length}`);
});

await check("getRepoInfo returns the repo's own metadata", async () => {
  const info = await getRepoInfo(REPO);
  assert(info.id.toLowerCase() === REPO.toLowerCase(), `unexpected id ${info.id}`);
  assert(typeof info.gated === "boolean", "gated must be a boolean");
  assert(Array.isArray(info.tags), "tags must be an array");
});

await check("getRepoInfo reports a missing repo without throwing a network error", async () => {
  let message = "";
  try {
    await getRepoInfo("mradermacher/this-repo-does-not-exist-blackbox-test");
  } catch (error) {
    message = error.message;
  }
  assert(/not found|gated/i.test(message), `unexpected error: ${message}`);
});

await check("listGgufFiles returns real sizes and quant names", async () => {
  const files = await listGgufFiles(REPO);
  assert(files.length > 0, "expected GGUF files");
  for (const file of files) {
    assert(file.size > 0, `${file.path} has no size`);
    assert(/\.gguf$/i.test(file.path), `${file.path} is not a gguf`);
    assert(!/mmproj/i.test(file.path), "vision projectors must be filtered out");
  }
  const known = files.filter((file) => file.quant !== "UNKNOWN");
  assert(known.length > 0, "no file had a recognisable quant");
  console.log(`      ${files.length} files, smallest ${files[0].filename} (${files[0].size} bytes as ${files[0].quant})`);
});

await check("resolveUrl encodes paths and points at the Hub", () => {
  const url = resolveUrl("org/repo", "dir/my model.Q4_K_M.gguf");
  assert(url.startsWith("https://huggingface.co/org/repo/resolve/main/"), url);
  assert(url.includes("my%20model.Q4_K_M.gguf"), url);
});

console.log(`\n${passed}/${passed + failures.length} Hugging Face checks passed`);
if (failures.length) {
  console.error("failures:", failures.map((failure) => failure.name));
  process.exitCode = 1;
}
