/**
 * Fine-tuning orchestration.
 *
 * Everything here is a real local process: Python is detected (never bundled
 * silently), a virtual environment is created on request, the trainer runs as a
 * child process, and progress is parsed from its JSON log lines.
 *
 * Adapter -> GGUF conversion uses llama.cpp's own convert_lora_to_gguf.py,
 * fetched at a pinned commit because it needs the gguf-py and conversion
 * packages from that repository.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const trainerScript = path.join(here, "..", "..", "resources", "trainer", "train_lora.py");

// llama.cpp ships the LoRA converter as a script inside its repository, and it
// imports the repo's own gguf-py/conversion packages, so the sources are fetched
// once rather than vendored into the installer.
const LLAMA_TARBALL = "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/refs/heads/master";

let active = null;

export function detectPython(candidates = ["python3", "python", "py"]) {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 8000 });
    if (result.status === 0) {
      return { command: candidate, version: String(result.stdout || result.stderr).trim() };
    }
  }
  return null;
}

export function inspectEnvironment(python) {
  if (!python) return { python: null, ready: false, missing: ["python"], detail: "Python 3.9+ is required for training." };
  const probe = spawnSync(
    python,
    [
      "-c",
      "import json,sys;out={};\n"
        + "try:\n import torch;out['torch']=torch.__version__\nexcept Exception as e: out['torch']=None\n"
        + "try:\n import transformers;out['transformers']=transformers.__version__\nexcept Exception: out['transformers']=None\n"
        + "try:\n import peft;out['peft']=peft.__version__\nexcept Exception: out['peft']=None\n"
        + "print(json.dumps(out))",
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  if (probe.status !== 0) {
    return { python, ready: false, missing: ["torch", "transformers", "peft"], detail: String(probe.stderr || "").trim() };
  }
  let versions = {};
  try {
    versions = JSON.parse(probe.stdout.trim().split("\n").pop());
  } catch {
    versions = {};
  }
  const missing = ["torch", "transformers", "peft"].filter((name) => !versions[name]);
  return {
    python,
    ready: missing.length === 0,
    missing,
    versions,
    detail: missing.length ? `Missing Python packages: ${missing.join(", ")}` : "Training environment ready.",
  };
}

function run(command, args, { cwd, onLog = () => {}, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let output = "";
    const handle = (chunk) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line);
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}\n${output.split(/\r?\n/).slice(-15).join("\n")}`))));
  });
}

/** Create a virtual environment and install the real CPU training stack. */
export async function provisionEnvironment({ python, venvDir, onLog = () => {} }) {
  if (!python) throw new Error("Python was not found on PATH.");
  fs.mkdirSync(path.dirname(venvDir), { recursive: true });
  if (!fs.existsSync(venvDir)) {
    onLog(`Creating virtual environment in ${venvDir}`);
    await run(python, ["-m", "venv", venvDir], { onLog });
  }
  const venvPython = path.join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!fs.existsSync(venvPython)) throw new Error("Could not create the virtual environment.");
  onLog("Installing PyTorch (CPU build) — this is ~200 MB and takes a few minutes.");
  await run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], { onLog });
  await run(venvPython, ["-m", "pip", "install", "--index-url", "https://download.pytorch.org/whl/cpu", "torch"], { onLog });
  await run(venvPython, ["-m", "pip", "install", "transformers", "peft", "accelerate", "safetensors", "gguf", "sentencepiece", "protobuf"], { onLog });
  return inspectEnvironment(venvPython);
}

/**
 * Start a training run. Resolves when it finishes; rejects if it fails.
 * `onProgress` receives {step, steps, loss}.
 */
export async function train({
  python,
  model,
  data,
  outDir,
  rank = 8,
  alpha = 16,
  lr = 0.0002,
  epochs = 1,
  maxSteps = 0,
  seqLen = 512,
  batchSize = 1,
  gradAccum = 4,
  threads = 0,
  onLog = () => {},
  onProgress = () => {},
  onChild = () => {},
}) {
  if (!python) throw new Error("Python was not found on PATH.");
  if (!fs.existsSync(trainerScript)) throw new Error("The trainer script is missing from this build.");
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    trainerScript,
    "--model", model,
    "--data", data,
    "--out", outDir,
    "--rank", String(rank),
    "--alpha", String(alpha),
    "--lr", String(lr),
    "--epochs", String(epochs),
    "--max-steps", String(maxSteps),
    "--seq-len", String(seqLen),
    "--batch-size", String(batchSize),
    "--grad-accum", String(gradAccum),
    "--threads", String(threads),
  ];
  onLog(`$ ${python} ${args.join(" ")}`);

  const child = spawn(python, args, { env: { ...process.env, PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" } });
  active = child;
  onChild(child);

  let tail = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    tail = (tail + text).split(/\r?\n/).slice(-40).join("\n");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.startsWith("{")) {
        try {
          const event = JSON.parse(line);
          if (event.event === "step") onProgress({ step: event.step, steps: event.steps, loss: event.loss });
          else onLog(line);
          continue;
        } catch {
          /* non-JSON line, fall through */
        }
      }
      onLog(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onLog(line);
  });

  const code = await new Promise((resolve) => child.on("close", resolve));
  active = null;
  if (code !== 0) throw new Error(`Training stopped with exit code ${code}.\n${tail}`);
  return { adapterDir: outDir };
}

export function stopTraining() {
  if (!active) return false;
  active.kill();
  active = null;
  return true;
}

/** Download (once) the llama.cpp sources needed for LoRA→GGUF conversion. */
export async function ensureLlamaSource({ cacheDir, onLog = () => {} }) {
  const dir = path.join(cacheDir, "llama.cpp");
  if (fs.existsSync(path.join(dir, "convert_lora_to_gguf.py"))) return dir;
  fs.mkdirSync(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, `llama-${Date.now()}.tar.gz`);
  onLog("Fetching llama.cpp conversion tools (one time, ~40 MB)");
  const response = await fetch(LLAMA_TARBALL);
  if (!response.ok) throw new Error(`Could not download llama.cpp sources: HTTP ${response.status}`);
  fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  fs.mkdirSync(dir, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"], { encoding: "utf8" });
  fs.rmSync(tarball, { force: true });
  if (tar.status !== 0) throw new Error(`Could not extract llama.cpp sources: ${tar.stderr || tar.status}`);
  return dir;
}

const mergeScript = path.join(here, "..", "..", "resources", "trainer", "merge_adapter.py");

/**
 * Merge a LoRA adapter into its base weights and convert the result to GGUF.
 * node-llama-cpp has no public adapter API, so merging is the honest path to a
 * model the chat window can actually load.
 */
export async function mergeAdapterToGguf({ python, adapterDir, baseModelId, cacheDir, onLog = () => {} }) {
  if (!python) throw new Error("Python was not found on PATH.");
  const mergedDir = path.join(adapterDir, "merged");
  onLog("Merging the adapter into the base weights (CPU, this allocates the full model)");
  await run(python, [mergeScript, "--adapter", adapterDir, "--model", baseModelId, "--out", mergedDir], { onLog });

  const source = await ensureLlamaSource({ cacheDir, onLog });
  const outFile = path.join(adapterDir, "fine-tuned.f16.gguf");
  onLog("Converting merged weights to GGUF (F16)");
  await run(python, [path.join(source, "convert_hf_to_gguf.py"), mergedDir, "--outfile", outFile, "--outtype", "f16"], {
    cwd: source,
    onLog,
    env: { PYTHONPATH: [path.join(source, "gguf-py"), path.join(source), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  if (!fs.existsSync(outFile)) throw new Error("Conversion finished without producing a GGUF file.");
  return { file: outFile, bytes: fs.statSync(outFile).size };
}

/** Convert a PEFT adapter into a GGUF LoRA that llama.cpp can load. */
export async function convertAdapterToGguf({ python, adapterDir, baseModelId, cacheDir, onLog = () => {} }) {
  if (!python) throw new Error("Python was not found on PATH.");
  const source = await ensureLlamaSource({ cacheDir, onLog });
  const outFile = path.join(adapterDir, "adapter.gguf");
  const script = path.join(source, "convert_lora_to_gguf.py");
  await run(python, [script, adapterDir, "--base-model-id", baseModelId, "--outtype", "f16", "--outfile", outFile], {
    cwd: source,
    onLog,
    env: { PYTHONPATH: [path.join(source, "gguf-py"), path.join(source), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  if (!fs.existsSync(outFile)) throw new Error("Conversion finished without producing adapter.gguf.");
  return { file: outFile, bytes: fs.statSync(outFile).size };
}
