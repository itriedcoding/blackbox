/**
 * Browser inference for an exported Blackbox site.
 *
 * The model runs in the visitor's browser through wllama (llama.cpp compiled to
 * WebAssembly). Nothing is sent to a server: the GGUF file is downloaded once,
 * cached by the browser, and evaluated on the visitor's CPU.
 *
 * This module is also imported by scripts/verify-site.mjs under Node, so the
 * exact code that ships to the website is what gets tested.
 */

export class SiteEngine {
  constructor({ modelUrl, wasmUrl, wllamaUrl = "./vendor/wllama/wllama.js", cacheManager = undefined, contextSize = 4096 }) {
    if (!modelUrl) throw new Error("modelUrl is required");
    this.modelUrl = modelUrl;
    this.wasmUrl = wasmUrl;
    this.wllamaUrl = wllamaUrl;
    this.cacheManager = cacheManager;
    this.contextSize = contextSize;
    this.wllama = null;
    this.wasm = null;
  }

  async load({ onProgress = () => {}, onStatus = () => {} } = {}) {
    if (this.wllama) return this.info();
    onStatus("Loading inference engine");
    const module = await import(this.wllamaUrl);
    this.wasm = module;
    const paths = { default: this.wasmUrl };
    const config = { suppressNativeLog: true };
    if (this.cacheManager) config.cacheManager = this.cacheManager;
    this.wllama = new module.Wllama(paths, config);

    onStatus("Downloading model");
    await this.wllama.loadModelFromUrl(this.modelUrl, {
      n_ctx: this.contextSize,
      progressCallback: ({ loaded, total }) => {
        if (total > 0) onProgress({ loaded, total, percent: Math.min(100, (loaded / total) * 100) });
      },
    });
    onStatus("Ready");
    return this.info();
  }

  info() {
    if (!this.wllama) return { loaded: false };
    const meta = this.wllama.getModelMetadata?.() ?? null;
    return { loaded: true, metadata: meta, contextSize: this.contextSize };
  }

  /**
   * Stream a reply. Supply `messages` for chat models (the GGUF chat template is
   * applied by llama.cpp) or `prompt` for plain completion.
   */
  async generate({ messages, prompt, maxTokens = 512, temperature = 0.8, topP = 0.9, topK = 40, signal, onToken = () => {} }) {
    if (!this.wllama) throw new Error("Model is not loaded yet.");
    let text = "";
    const collect = (chunk) => {
      const piece = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.text ?? "";
      if (piece) {
        text += piece;
        onToken(piece);
      }
    };

    if (messages) {
      const result = await this.wllama.createChatCompletion({
        messages,
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        top_k: topK,
        stream: true,
        abortSignal: signal,
        onData: collect,
      });
      if (!text && result?.choices?.[0]?.message?.content) text = result.choices[0].message.content;
    } else {
      const result = await this.wllama.createCompletion({
        prompt: String(prompt ?? ""),
        max_tokens: maxTokens,
        temperature,
        top_p: topP,
        top_k: topK,
        stream: true,
        abortSignal: signal,
        onData: collect,
      });
      if (!text && result?.choices?.[0]?.text) text = result.choices[0].text;
    }
    return text;
  }

  async dispose() {
    if (!this.wllama) return;
    try {
      await this.wllama.exit();
    } catch {
      /* engine already gone */
    }
    this.wllama = null;
  }
}

export default SiteEngine;
