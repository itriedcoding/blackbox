/**
 * End-to-end engine test against the real services this app uses.
 *
 *   node scripts/smoke-test.mjs            # full test (downloads ~400 MB once)
 *   node scripts/smoke-test.mjs --keep     # keep the downloaded model
 *   node scripts/smoke-test.mjs --hf-only  # only exercise the Hugging Face API
 *
 * Steps: Hub search -> Hub file listing -> real GGUF download -> GGUF metadata parse
 *        -> llama.cpp load -> streamed generation -> abort mid-stream -> unload.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { searchModels, listGgufFiles, getRepoInfo } from "../electron/lib/hf.js";
import { DownloadManager } from "../electron/lib/downloads.js";
import { readGgufInfo } from "../electron/lib/gguf.js";
import { formatBytes, ramBudget, pickRecommendedFile } from "../electron/lib/quant.js";
import * as engine from "../electron/lib/engine.js";

const args = new Set(process.argv.slice(2));
const keep = args.has("--keep");
const hfOnly = args.has("--hf-only");

const WORK_DIR = path.join(process.cwd(), ".smoke");
const MODELS_DIR = path.join(WORK_DIR, "models");
const REPO = "mradermacher/Qwen2.5-0.5B-Instruct-abliterated-GGUF";

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function memoryLine() {
  const budget = ramBudget({ totalMem: os.totalmem(), freeMem: os.freemem() });
  return `total ${formatBytes(os.totalmem())}, free ${formatBytes(os.freemem())}, budget ${formatBytes(budget)}`;
}

async function main() {
  console.log("Blackbox smoke test");
  console.log(`memory: ${memoryLine()}`);

  section("1. Hugging Face API");
  const results = await searchModels({ query: "abliterated", limit: 10, uncensoredOnly: true });
  check("search returns GGUF repos", results.length > 0, `${results.length} results`);
  check(
    "search results carry download counts",
    results.every((entry) => typeof entry.downloads === "number"),
  );
  check(
    "uncensored filter keeps only abliterated/uncensored repos",
    results.every((entry) => entry.uncensored),
    results[0]?.id ?? "",
  );

  const info = await getRepoInfo(REPO);
  check("repo metadata resolves", Boolean(info.id), `${info.id}, gated=${info.gated}`);

  const files = await listGgufFiles(REPO);
  check("repo lists real GGUF files with sizes", files.length > 0 && files.every((file) => file.size > 0), `${files.length} files`);
  check("quant names parsed", files.some((file) => file.quant === "Q4_K_M"));

  const budget = ramBudget({ totalMem: os.totalmem(), freeMem: os.freemem() });
  const recommended = pickRecommendedFile(files, budget);
  check("recommended quant fits the RAM budget", recommended.fits, `${recommended.file?.quant} ${formatBytes(recommended.file?.size)}`);

  if (hfOnly) {
    console.log("\nHF-only mode, stopping here.");
    return finish();
  }

  section("2. Download");
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const chosen = recommended.file ?? files.find((file) => file.quant === "Q4_K_M") ?? files[0];

  const manager = new DownloadManager({
    onProgress: (() => {
      let lastShown = -1;
      return (progress) => {
        if (progress.status !== "downloading") return;
        const decile = progress.percent ? Math.floor(progress.percent / 20) * 20 : -1;
        if (decile !== lastShown) {
          lastShown = decile;
          const speed = progress.bytesPerSecond ? ` @ ${formatBytes(progress.bytesPerSecond)}/s` : "";
          console.log(
            `        ${progress.percent ? progress.percent.toFixed(0) : "?"}%  ${formatBytes(progress.received)} / ${formatBytes(progress.total)}${speed}`,
          );
        }
      };
    })(),
    onComplete: () => {},
  });

  const started = Date.now();
  const job = await manager.start({ repo: REPO, path: chosen.path, size: chosen.size, modelsDir: MODELS_DIR });

  let final = null;
  while (Date.now() - started < 600000) {
    const jobs = manager.list();
    const current = jobs.find((entry) => entry.id === job.id);
    if (current && (current.status === "done" || current.status === "error")) {
      final = current;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const target = path.join(MODELS_DIR, REPO.replace("/", "--"), job.filename);
  check("download completed", Boolean(final && final.status === "done"), final?.error ?? formatBytes(fs.existsSync(target) ? fs.statSync(target).size : 0));
  check("file exists on disk", fs.existsSync(target));
  check("no .part left behind", !fs.existsSync(`${target}.part`));
  if (final?.status !== "done" || !fs.existsSync(target)) return finish();

  const stat = fs.statSync(target);
  check("size matches Hub listing", stat.size === chosen.size, `${stat.size} bytes`);

  section("3. GGUF metadata");
  const gguf = readGgufInfo(target);
  check("GGUF parses", gguf.architecture !== null, `arch=${gguf.architecture}`);
  check("KV cache size derived from metadata", Number(gguf.kvBytesPerToken) > 0, `${formatBytes(gguf.kvBytesPerToken)} per token`);
  check("context length reported", Number(gguf.contextLength) > 0, String(gguf.contextLength));

  section("4. llama.cpp load (CPU)");
  const loadProgress = [];
  const status = await engine.load({
    modelPath: target,
    contextSize: 1024,
    threads: Math.max(2, Math.min(4, os.cpus().length)),
    gpu: "cpu",
    onProgress: (progress) => loadProgress.push(progress),
  });
  check("model loaded", status.loaded, `${status.modelName} ctx=${status.contextSize}`);
  check("runs on CPU backend", status.gpu === false);
  check("load progress emitted", loadProgress.length > 0);

  section("5. Streaming generation");
  let chunks = 0;
  let streamed = "";
  const response = await engine.chat({
    chatId: "smoke",
    systemPrompt: "You are terse and direct.",
    history: [],
    prompt: "Reply with exactly one short sentence about local AI running on a CPU.",
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 60,
    onDelta: (chunk) => {
      chunks += 1;
      streamed += chunk;
    },
  });
  check("generation produced text", response.text.trim().length > 0, JSON.stringify(response.text.slice(0, 90)));
  check("tokens streamed incrementally", chunks > 1, `${chunks} chunks`);
  check("streamed text matches result", streamed === response.text);
  check("token stats reported", Number(response.stats.tokens) > 0, `${response.stats.tokens} tokens, ${response.stats.tokensPerSecond} tok/s`);

  section("6. Stop mid-generation");
  const slow = engine.chat({
    chatId: "smoke-stop",
    systemPrompt: "",
    history: [],
    prompt: "Count from 1 to 200, one number per line.",
    temperature: 0.8,
    maxTokens: 400,
    onDelta: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 900));
  const stopped = engine.stop();
  const partial = await slow;
  check("stop accepted", stopped === true);
  check("generation ended early", partial.stats.stopped === true, `${partial.stats.tokens} tokens before stop`);
  check("partial text kept", partial.text.length > 0);

  section("7. Second turn reuses context");
  const followUp = await engine.chat({
    chatId: "smoke",
    systemPrompt: "You are terse and direct.",
    history: [
      { role: "user", content: "Reply with exactly one short sentence about local AI running on a CPU." },
      { role: "assistant", content: response.text },
    ],
    prompt: "Now in three words: what machine is this running on?",
    temperature: 0.2,
    maxTokens: 24,
    onDelta: () => {},
  });
  check("follow-up generation works", followUp.text.trim().length > 0, JSON.stringify(followUp.text.trim().slice(0, 60)));

  section("8. Unload");
  const after = await engine.unload();
  check("model unloaded", after.loaded === false);
  await engine.disposeAll();
}

function finish() {
  if (!keep && failures === 0) {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
    console.log("\nCleaned up .smoke/");
  } else if (keep) {
    console.log(`\nKept ${path.relative(process.cwd(), WORK_DIR)}/`);
  } else {
    console.log(`\nLeft ${path.relative(process.cwd(), WORK_DIR)}/ in place so a rerun can resume the download.`);
  }
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nSmoke test crashed:", error?.stack ?? error);
  process.exit(1);
});
