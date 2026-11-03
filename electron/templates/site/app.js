/**
 * Front end for an exported Blackbox site. Static files only: the model runs in
 * the visitor's browser through wllama, so any static host works.
 */
import { SiteEngine } from "./engine.js";

const el = {
  title: document.getElementById("site-title"),
  tagline: document.getElementById("site-tagline"),
  thread: document.getElementById("thread"),
  gate: document.getElementById("gate"),
  gateTitle: document.getElementById("gate-title"),
  gateBody: document.getElementById("gate-body"),
  gateFill: document.getElementById("gate-fill"),
  gateMeta: document.getElementById("gate-meta"),
  gateButton: document.getElementById("gate-button"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  hint: document.getElementById("hint"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
};

const config = await fetch("./config.json", { cache: "no-store" }).then((response) => {
  if (!response.ok) throw new Error("config.json is missing from this deployment");
  return response.json();
});

document.title = config.title || "Blackbox";
el.title.textContent = config.title || "Blackbox";
el.tagline.textContent = config.tagline || "runs in your browser";
el.gateTitle.textContent = `Loading ${config.modelName || "the model"}`;

const history = [];
let engine = null;
let controller = null;
let busy = false;

function setStatus(text, live) {
  el.statusText.textContent = text;
  el.statusDot.className = "dot" + (live ? " is-live" : busy ? " is-busy" : "");
}

function appendMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${role}`;
  const label = document.createElement("div");
  label.className = "msg__role";
  label.textContent = role === "user" ? "you" : config.modelName || "model";
  const body = document.createElement("div");
  body.className = "msg__body";
  body.textContent = text;
  wrap.append(label, body);
  el.thread.append(wrap);
  el.thread.scrollTop = el.thread.scrollHeight;
  return body;
}

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
}

el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.form.requestSubmit();
  }
});

async function boot() {
  engine = new SiteEngine({
    modelUrl: config.modelUrl,
    wasmUrl: new URL("./vendor/wllama/wllama.wasm", import.meta.url).href,
    wllamaUrl: new URL("./vendor/wllama/wllama.js", import.meta.url).href,
    contextSize: config.contextSize || 4096,
  });

  try {
    await engine.load({
      onProgress: ({ percent, loaded, total }) => {
        el.gateFill.style.width = `${percent}%`;
        el.gateMeta.textContent = `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB · ${percent.toFixed(0)}%`;
      },
      onStatus: (status) => {
        el.gateMeta.textContent = status.toLowerCase();
      },
    });
    el.gateFill.style.width = "100%";
    el.gateMeta.textContent = "model ready";
    el.gateTitle.textContent = "Ready";
    el.gateBody.textContent = "The model is loaded in this tab. Replies stream from your own CPU; nothing is uploaded.";
    el.gateButton.hidden = false;
    el.gateButton.onclick = () => {
      el.gate.hidden = true;
      el.input.focus();
    };
    setStatus("ready · local", true);
  } catch (error) {
    el.gateTitle.textContent = "Could not start";
    el.gateBody.textContent = String(error.message || error);
    el.gateMeta.textContent = "check the model URL in config.json";
    setStatus("error", false);
  }
}

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = el.input.value.trim();
  if (!text || busy || !engine) return;

  busy = true;
  const previous = el.send;
  el.send.disabled = true;
  el.stop.hidden = false;
  el.input.value = "";
  autosize();
  appendMessage("user", text);
  history.push({ role: "user", content: text });
  const body = appendMessage("assistant", "");
  const cursor = document.createElement("span");
  cursor.className = "msg__cursor";
  body.append(cursor);
  setStatus("generating · local", false);

  controller = new AbortController();
  const started = performance.now();
  let tokens = 0;
  try {
    const messages = [
      ...(config.systemPrompt ? [{ role: "system", content: config.systemPrompt }] : []),
      ...history,
    ];
    const reply = await engine.generate({
      messages,
      maxTokens: config.maxTokens || 512,
      temperature: config.temperature ?? 0.8,
      topP: config.topP ?? 0.9,
      topK: config.topK ?? 40,
      signal: controller.signal,
      onToken: (piece) => {
        tokens += 1;
        body.textContent = body.textContent + piece;
        body.append(cursor);
        el.thread.scrollTop = el.thread.scrollHeight;
      },
    });
    cursor.remove();
    if (!body.textContent) body.textContent = reply || "(empty reply)";
    history.push({ role: "assistant", content: reply });
    const seconds = Math.max(0.001, (performance.now() - started) / 1000);
    el.hint.textContent = `${tokens} tokens · ${(tokens / seconds).toFixed(1)} tok/s · in your browser`;
  } catch (error) {
    cursor.remove();
    body.textContent = `Generation stopped: ${error.message || error}`;
  } finally {
    controller = null;
    busy = false;
    el.send.disabled = false;
    el.stop.hidden = true;
    setStatus("ready · local", true);
    el.input.focus();
    previous?.focus?.();
  }
});

el.stop.addEventListener("click", () => {
  controller?.abort();
});

boot();
