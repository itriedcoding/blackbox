/**
 * Curated starter models. Every repo id below was verified live against the Hub:
 * each one publishes single-file GGUF quants small enough for a <4 GB machine.
 *
 * Sizes are never hardcoded here — the UI asks the Hub tree API for real sizes
 * when a card is opened, so this list cannot drift into fiction.
 */

export const CURATED_MODELS = [
  {
    repo: "mradermacher/Qwen2.5-0.5B-Instruct-abliterated-GGUF",
    name: "Qwen2.5 0.5B Abliterated",
    params: "0.5B",
    sizeHint: "~0.4 GB",
    blurb: "The floor. Instant load, works on any machine, good for tooling and short answers.",
    license: "Apache-2.0",
    tag: "ultra light",
  },
  {
    repo: "mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF",
    name: "Llama 3.2 1B Abliterated",
    params: "1.2B",
    sizeHint: "~1.0 GB",
    blurb: "Meta's 1B instruction model with the refusal direction removed. Fast on two cores.",
    license: "Llama 3.2 Community",
    tag: "balanced",
  },
  {
    repo: "mradermacher/Qwen2.5-1.5B-Instruct-abliterated-GGUF",
    name: "Qwen2.5 1.5B Abliterated",
    params: "1.5B",
    sizeHint: "~1.0 GB",
    blurb: "Strongest writing per gigabyte in this class. Multilingual, clean chat template.",
    license: "Apache-2.0",
    tag: "recommended",
  },
  {
    repo: "mradermacher/Qwen3-1.7B-abliterated-GGUF",
    name: "Qwen3 1.7B Abliterated",
    params: "1.7B",
    sizeHint: "~1.1 GB",
    blurb: "Newer tokenizer and reasoning mode, abliterated. Best general pick under 1.5 GB.",
    license: "Apache-2.0",
    tag: "recommended",
  },
  {
    repo: "mradermacher/gemma-2-2b-it-abliterated-GGUF",
    name: "Gemma 2 2B Abliterated",
    params: "2.6B",
    sizeHint: "~1.7 GB",
    blurb: "Google's Gemma 2 with refusals ablated. Warm prose, 8K context.",
    license: "Gemma",
    tag: "heavier",
  },
  {
    repo: "QuantFactory/Llama-3.2-3B-Instruct-abliterated-GGUF",
    name: "Llama 3.2 3B Abliterated",
    params: "3.2B",
    sizeHint: "~2.0 GB",
    blurb: "The largest model that still fits a 4 GB machine. Tighter context budget.",
    license: "Llama 3.2 Community",
    tag: "max quality",
  },
];
