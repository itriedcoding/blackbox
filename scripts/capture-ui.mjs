/**
 * Dev utility: boots the real Electron app headlessly, drives it over the Chrome
 * DevTools Protocol and writes screenshots to artifacts/.
 *
 *   node scripts/capture-ui.mjs [--model <path.gguf>] [--port 9333]
 *
 * It uses the app's own IPC bridge (window.blackbox) — no stubbed data. When a model
 * path is supplied it is loaded through the real engine, then the window is reloaded
 * so the screenshots show the app in its normal "model loaded" state.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const modelFlag = args.indexOf("--model");
const modelPath = modelFlag !== -1 ? args[modelFlag + 1] : null;
const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : 9333;

const OUT_DIR = path.join(process.cwd(), "artifacts");
fs.mkdirSync(OUT_DIR, { recursive: true });

const electronBinary = path.join(process.cwd(), "node_modules", "electron", "dist", "electron");

const child = spawn(
  electronBinary,
  [".", "--no-sandbox", "--ozone-platform=headless", "--disable-gpu", `--remote-debugging-port=${port}`],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } },
);

const logs = [];
child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget(timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error(`Electron DevTools endpoint never appeared.\n${logs.join("")}`);
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (event) => reject(new Error("CDP socket error: " + event.message)));
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(message.params.exceptionDetails?.exception?.description ?? "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async screenshot(name) {
    const result = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    console.log(`  saved ${path.relative(process.cwd(), file)}`);
    return file;
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  console.log("Launching Electron headless…");
  const target = await waitForTarget();
  console.log(`  target ${target.url}`);

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 840,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await sleep(1500);

  const bridge = await cdp.evaluate('typeof window.blackbox === "object" && typeof window.blackbox.engine.load === "function"');
  console.log(`  preload bridge: ${bridge ? "present" : "MISSING"}`);
  if (!bridge) throw new Error("Renderer did not receive the preload bridge.");

  const bootState = await cdp.evaluate(
    '({ title: document.querySelector("#chat-title")?.textContent, tabs: document.querySelectorAll("[data-view-panel]").length, chats: document.querySelectorAll(".chat-item").length })',
  );
  console.log(`  boot: ${JSON.stringify(bootState)}`);

  if (modelPath) {
    console.log("  loading model through the real engine…");
    const loaded = await cdp.evaluate(
      `window.blackbox.engine.load({ modelPath: ${JSON.stringify(modelPath)}, contextSize: 2048, threads: 2, gpu: "cpu" })`,
    );
    console.log(`  engine.load -> loaded=${loaded.status?.loaded} ctx=${loaded.status?.contextSize} gpu=${loaded.status?.gpu}`);
    await cdp.send("Page.reload");
    await sleep(2500);
  }

  await cdp.screenshot("ui-chat.png");

  // Models view: triggers a live huggingface.co catalog request through IPC.
  await cdp.evaluate('document.querySelector(\'[data-action="view"][data-view="models"]\').click()');
  await sleep(6000);
  const modelsState = await cdp.evaluate(
    '({ cards: document.querySelectorAll("#view-models .card").length, title: document.querySelector("#view-models .page__title")?.textContent, firstRepo: document.querySelector("#view-models .card__repo")?.textContent })',
  );
  console.log(`  models view: ${JSON.stringify(modelsState)}`);
  await cdp.screenshot("ui-models.png");

  // Settings view: real memory/CPU numbers from the main process.
  await cdp.evaluate('document.querySelector(\'[data-action="view"][data-view="settings"]\').click()');
  await sleep(1800);
  await cdp.screenshot("ui-settings.png");

  // Performance view: live memory + the optimizer, both through real IPC.
  await cdp.evaluate('document.querySelector(\'[data-action="view"][data-view="performance"]\').click()');
  await sleep(2200);
  const perfState = await cdp.evaluate(`({
    title: document.querySelector("#view-performance .page__title")?.textContent,
    live: [...document.querySelectorAll("#perf-live .kv")].map((row) => row.innerText.replace(/\\s+/g, " ")),
    recommendation: [...document.querySelectorAll("#perf-recommendation .kv")].map((row) => row.innerText.replace(/\\s+/g, " ")),
    reason: document.querySelector("#perf-recommendation .field-row__hint")?.textContent,
    optimizeButton: Boolean(document.querySelector(\'[data-action="optimize-memory"]\')),
    freeButton: Boolean(document.querySelector(\'[data-action="free-memory"]\')),
    controls: [...document.querySelectorAll("#view-performance select")].map((select) => select.id + "=" + select.value)
  })`);
  console.log(`  performance view: ${JSON.stringify(perfState)}`);
  await cdp.screenshot("ui-performance.png");

  if (modelPath) {
    await cdp.evaluate('document.querySelector(\'[data-action="view"][data-view="chat"]\').click()');
    await sleep(500);

    // Real typing + real Enter key through the renderer's own handlers.
    await cdp.evaluate(
      'document.querySelector("#composer").focus(); document.querySelector("#composer").value = "In one sentence: why does a local model matter?"; document.querySelector("#composer").dispatchEvent(new Event("input", { bubbles: true }));',
    );
    await cdp.evaluate(
      'document.querySelector("#composer").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))',
    );
    await sleep(1200);
    await cdp.screenshot("ui-streaming.png");

    console.log("  waiting for generation to finish…");
    const started = Date.now();
    let done = false;
    while (Date.now() - started < 90000) {
      done = await cdp.evaluate('!document.querySelector(".caret") && !document.querySelector("[data-stream=\\"1\\"]")');
      if (done) break;
      await sleep(500);
    }
    const reply = await cdp.evaluate(
      '(() => { const nodes = document.querySelectorAll(".msg--assistant .msg__body"); const last = nodes[nodes.length - 1]; return { text: last ? last.innerText.slice(0, 300) : null, meta: document.querySelectorAll(".msg--assistant .msg__meta")[document.querySelectorAll(".msg--assistant .msg__meta").length - 1]?.textContent }; })()',
    );
    console.log(`  reply: ${JSON.stringify(reply)}`);
    await cdp.screenshot("ui-chat-generated.png");
  }

  console.log(`  renderer errors: ${cdp.errors.length ? JSON.stringify(cdp.errors) : "none"}`);
  cdp.close();

  if (cdp.errors.length) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    if (logs.length) console.error(logs.join("").slice(-4000));
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(300);
    child.kill("SIGTERM");
    await sleep(400);
    if (!child.killed) child.kill("SIGKILL");
  });
