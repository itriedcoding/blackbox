/**
 * One generation surface, two backends.
 *
 * Everything above this file (chat, the code workspace, build-until-done) asks
 * for text and does not care where it comes from. The provider is a setting,
 * and this module is the only place that decision is made:
 *
 *   "local"   → llama.cpp via engine.js, fully offline
 *   "gateway" → Vercel AI Gateway over HTTPS with the user's own key
 *
 * The settings are read per call, so switching provider takes effect on the
 * next message without restarting the app.
 */

import { safeStorage } from "electron";
import * as engine from "./engine.js";
import * as gateway from "./gateway.js";
import * as store from "./store.js";
import { openSecret } from "./secrets.js";

export const engineVersion = engine.engineVersion;

export function providerName(settings = store.readSettings()) {
  return settings.provider === "gateway" ? "gateway" : "local";
}

export function gatewayKey(settings = store.readSettings()) {
  return openSecret(settings.gatewayApiKey, safeStorage);
}

function gatewayState(settings) {
  const key = gatewayKey(settings);
  return {
    baseUrl: settings.gatewayBaseUrl || gateway.DEFAULT_BASE_URL,
    model: settings.gatewayModel || null,
    keySet: Boolean(key),
    keyHint: settings.gatewayKeyHint || "",
    keyEncrypted: Boolean(settings.gatewayKeyEncrypted),
    ready: Boolean(key && settings.gatewayModel),
    busy: gateway.busy(),
  };
}

/**
 * A status object shaped like engine.status(), so the UI keeps working. In
 * gateway mode there is no context, no GPU and no GGUF file — those fields are
 * null rather than invented.
 */
export function status() {
  const settings = store.readSettings();
  const gatewayInfo = gatewayState(settings);
  if (providerName(settings) !== "gateway") {
    return { provider: "local", gateway: gatewayInfo, ...engine.status() };
  }
  return {
    provider: "gateway",
    gateway: gatewayInfo,
    loaded: gatewayInfo.ready,
    modelPath: null,
    modelName: gatewayInfo.model,
    contextSize: null,
    requestedContextSize: null,
    threads: null,
    gpu: false,
    fileInfo: null,
    busy: gatewayInfo.busy,
    chatId: null,
  };
}

export async function chat(request = {}) {
  const settings = store.readSettings();
  if (providerName(settings) !== "gateway") return engine.chat(request);

  const info = gatewayState(settings);
  if (!info.keySet) {
    throw new Error("No AI Gateway key is saved. Add one in Settings → Model source, or switch back to a local model.");
  }
  if (!info.model) {
    throw new Error("No gateway model is selected. Open Settings → Model source, refresh the list and pick one.");
  }

  return gateway.chat({
    apiKey: gatewayKey(settings),
    baseUrl: info.baseUrl,
    model: info.model,
    systemPrompt: request.systemPrompt,
    history: request.history,
    prompt: request.prompt,
    temperature: request.temperature,
    topP: request.topP,
    maxTokens: request.maxTokens,
    onDelta: request.onDelta,
  });
}

export function stop() {
  const gatewayStopped = gateway.stop();
  const engineStopped = engine.stop();
  return gatewayStopped || engineStopped;
}

// Local-model lifecycle: unchanged for the gateway, which has nothing to load.
export const load = engine.load;
export const unload = engine.unload;
export const initLlama = engine.initLlama;
export const disposeAll = engine.disposeAll;
