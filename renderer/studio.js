/* Studio views: publish, API access, fine-tuning. Uses only the preload bridge. */
(function () {
  "use strict";
  var api = window.blackbox;
  var ui = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function page(title, sub, body) {
    return '<div class="page"><div class="page__head"><div><h2 class="page__title">' + esc(title) + '</h2><p class="page__sub">' + esc(sub) + "</p></div></div>" + body + "</div>";
  }

  function panel(title, sub, body) {
    return '<div class="panel"><div class="panel__title">' + esc(title) + '</div><p class="panel__sub">' + esc(sub) + "</p>" + body + "</div>";
  }

  var s = {
    site: { title: "Blackbox", modelUrl: "", outDir: "", result: null, log: [], busy: false },
    keys: [], apiState: null,
    train: { env: null, dataset: null, log: [], progress: null, base: "HuggingFaceTB/SmolLM2-135M-Instruct", busy: false, adapter: null, gguf: null }
  };

  function homePublish() {
    return page("Publish", "A static site where visitors chat with the model in their own browser.",
      panel("Site", "Exports plain HTML/CSS/JS plus the wllama runtime. Deploy the folder anywhere static.",
        '<div class="field-row"><label class="field-row__label" for="site-title"><span>Title</span></label><input class="field" id="site-title" value="' + esc(s.site.title) + '"></div>' +
        '<div class="field-row"><label class="field-row__label" for="site-model"><span>Model URL (GGUF)</span></label><input class="field" id="site-model" placeholder="https://huggingface.co/owner/repo/resolve/main/model-Q4_K_M.gguf" value="' + esc(s.site.modelUrl) + '"><div class="field-row__hint">Direct link to a single-file GGUF with CORS enabled. Hugging Face resolve URLs work.</div></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn btn--sm btn--primary" data-action="site-export"' + (s.site.busy ? " disabled" : "") + ">Export site</button>" +
        '<button class="btn btn--sm btn--ghost" data-action="site-open">Open folder</button>' +
        '<button class="btn btn--sm btn--ghost" data-action="site-deploy">Deploy to Vercel</button></div>' +
        (s.site.result ? '<div class="kv" style="margin-top:10px"><span>Folder</span><span class="kv__value mono" style="word-break:break-all">' + esc(s.site.result.dir) + '</span></div><div class="kv"><span>Files</span><span class="kv__value">' + s.site.result.files.length + " · " + Math.round(s.site.result.totalBytes / 1024) + " KB</span></div>" : "") +
        (s.site.log.length ? '<pre class="mono" style="margin-top:10px;max-height:160px;overflow:auto;font-size:11px;color:var(--ink-muted)">' + esc(s.site.log.slice(-12).join("\n")) + "</pre>" : "")
      ));
  }

  function homeApi() {
    var status = s.apiState || {};
    var keys = s.keys.length
      ? s.keys.map(function (key) {
          return '<div class="kv"><span>' + esc(key.name) + ' <span class="mono" style="color:var(--ink-faint)">' + esc(key.prefix) + '…</span></span><span class="kv__value">' + key.requests + ' req <button class="btn btn--sm btn--ghost" data-action="api-revoke" data-id="' + esc(key.id) + '">Revoke</button></span></div>';
        }).join("")
      : '<div class="empty-small" style="text-align:left;padding:0">No keys yet.</div>';
    return page("API", "OpenAI-compatible endpoint served by this app on this machine.",
      panel("Server", status.running ? "Running on " + esc(status.host) + ":" + status.port : "Stopped",
        '<div class="kv"><span>Endpoint</span><span class="kv__value mono">' + esc((status.urls && status.urls[0]) || "not running") + '</span></div>' +
        '<div class="kv"><span>Auth</span><span class="kv__value">' + (status.settings && status.settings.apiRequireKey ? "bearer key required" : "open") + "</span></div>" +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn btn--sm btn--primary" data-action="api-toggle">' + (status.running ? "Stop" : "Start") + "</button>" +
        '<button class="btn btn--sm btn--ghost" data-action="api-new-key">New key</button></div>' +
        '<div class="field-row__hint">POST /v1/chat/completions · GET /v1/models · GET /health. Requests run on the loaded model.</div>') +
      panel("Keys", "Stored as SHA-256 hashes. Each key is shown once when created.", keys));
  }

  function homeTrain() {
    var env = s.train.env;
    var envText = !env ? "Checking…" : env.ready ? "ready · torch " + (env.versions.torch || "") : env.detail || "not ready";
    return page("Fine-tune", "LoRA training on your own data, on this CPU. No hosted service.",
      panel("Environment", envText,
        '<div class="field-row__hint">Training runs a real PyTorch job. Python 3.9+ is required; the app can create an isolated environment with CPU PyTorch (~1 GB on disk).</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn--sm btn--ghost" data-action="train-provision">Set up environment</button>' +
        '<button class="btn btn--sm btn--ghost" data-action="train-env">Re-check</button></div>') +
      panel("Dataset", s.train.dataset ? s.train.dataset.file : "No dataset selected",
        '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn--sm" data-action="train-pick">Choose file</button></div>' +
        (s.train.dataset ? '<div class="kv" style="margin-top:8px"><span>Examples</span><span class="kv__value">' + s.train.dataset.stats.count + " · " + s.train.dataset.stats.format + '</span></div><div class="kv"><span>Approx tokens</span><span class="kv__value">' + s.train.dataset.stats.approxTokens + "</span></div>" : '<div class="field-row__hint">JSONL with {"messages":[…]} or {"prompt","completion"}, or a plain text file.</div>')) +
      panel("Run", "Base model must be a Hugging Face repo with safetensors (a GGUF cannot be trained directly).",
        '<div class="field-row"><label class="field-row__label" for="train-base"><span>Base model</span></label><input class="field" id="train-base" value="' + esc(s.train.base) + '"></div>' +
        '<div class="kv"><span>Progress</span><span class="kv__value">' + (s.train.progress ? s.train.progress.step + " / " + s.train.progress.steps + " · loss " + s.train.progress.loss : "idle") + "</span></div>" +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn btn--sm btn--primary" data-action="train-start"' + (s.train.busy ? " disabled" : "") + ">Start training</button>" +
        '<button class="btn btn--sm btn--ghost" data-action="train-stop">Stop</button>' +
        '<button class="btn btn--sm btn--ghost" data-action="train-merge"' + (s.train.busy ? " disabled" : "") + ">Merge to GGUF</button></div>" +
        (s.train.gguf ? '<div class="kv" style="margin-top:8px"><span>Fine-tuned model</span><span class="kv__value mono" style="word-break:break-all">' + esc(s.train.gguf) + "</span></div>" : "") +
        (s.train.log.length ? '<pre class="mono" style="margin-top:10px;max-height:180px;overflow:auto;font-size:11px;color:var(--ink-muted)">' + esc(s.train.log.slice(-18).join("\n")) + "</pre>" : "")));
  }

  function render(view) {
    ui = window.blackboxUI;
    if (!api) return;
    var host = document.getElementById("view-" + view);
    if (!host) return;
    if (view === "publish") host.innerHTML = homePublish();
    if (view === "api") {
      host.innerHTML = homeApi();
      Promise.all([api.api.status(), api.api.keys()]).then(function (values) {
        s.apiState = values[0];
        s.keys = values[1];
        if (window.blackboxUI && window.blackboxUI.state.view === "api") host.innerHTML = homeApi();
      }).catch(function () {});
    }
    if (view === "train") {
      host.innerHTML = homeTrain();
      if (!s.train.env) {
        api.training.env().then(function (env) {
          s.train.env = env;
          s.train.base = (env.settings && env.settings.trainBaseModel) || s.train.base;
          host.innerHTML = homeTrain();
        }).catch(function () {});
      }
    }
  }

  async function handle(action, el) {
    if (!api) return false;
    if (action === "site-export") {
      s.site.busy = true;
      s.site.log = [];
      render("publish");
      try {
        var titleEl = document.querySelector("#view-publish #site-title");
        var modelEl = document.querySelector("#view-publish #site-model");
        s.site.title = titleEl ? titleEl.value : s.site.title;
        s.site.modelUrl = modelEl ? modelEl.value.trim() : s.site.modelUrl;
        s.site.result = await api.site.export({ title: s.site.title, modelUrl: s.site.modelUrl });
        ui.notify("Site exported · " + s.site.result.files.length + " files");
      } catch (error) {
        ui.notify(error.message, true);
      } finally {
        s.site.busy = false;
        render("publish");
      }
      return true;
    }
    if (action === "site-open") { await api.site.openFolder(s.site.result && s.site.result.dir); return true; }
    if (action === "site-deploy") {
      s.site.log = [];
      s.site.busy = true;
      render("publish");
      try {
        var deployed = await api.site.deploy(s.site.result && s.site.result.dir);
        ui.notify(deployed.url ? "Deployed · " + deployed.url : "Deployed");
      } catch (error) {
        ui.notify(error.message, true);
      } finally {
        s.site.busy = false;
        render("publish");
      }
      return true;
    }
    if (action === "api-toggle") {
      var settings = await api.settings.get();
      await api.settings.set({ apiEnabled: !(settings.apiEnabled) });
      s.apiState = await api.api.sync();
      render("api");
      return true;
    }
    if (action === "api-new-key") {
      var created = await api.api.createKey("Key " + new Date().toLocaleDateString());
      ui.notify("Key created — copy it now: " + created.key, false);
      s.keys = await api.api.keys();
      render("api");
      return true;
    }
    if (action === "api-revoke") { await api.api.revokeKey(el.getAttribute("data-id")); s.keys = await api.api.keys(); render("api"); return true; }
    if (action === "train-env") { s.train.env = await api.training.env(); render("train"); return true; }
    if (action === "train-provision") {
      s.train.busy = true;
      try { s.train.env = await api.training.provision(); ui.notify("Training environment ready."); }
      catch (error) { ui.notify(error.message, true); }
      finally { s.train.busy = false; render("train"); }
      return true;
    }
    if (action === "train-pick") {
      try { s.train.dataset = await api.training.pickDataset(); if (s.train.dataset) ui.notify("Dataset: " + s.train.dataset.stats.count + " examples"); }
      catch (error) { ui.notify(error.message, true); }
      render("train");
      return true;
    }
    if (action === "train-start") {
      s.train.busy = true;
      s.train.log = [];
      var baseEl = document.querySelector("#view-train #train-base");
      var base = baseEl ? baseEl.value.trim() : s.train.base;
      s.train.base = base;
      render("train");
      try {
        var run = await api.training.start({ baseModel: base });
        s.train.adapter = run.adapterDir;
        ui.notify("Training finished · adapter saved");
      } catch (error) { ui.notify(error.message, true); }
      finally { s.train.busy = false; render("train"); }
      return true;
    }
    if (action === "train-stop") { await api.training.stop(); s.train.busy = false; render("train"); return true; }
    if (action === "train-merge") {
      s.train.busy = true;
      render("train");
      try {
        var merged = await api.training.merge({ baseModel: s.train.base });
        s.train.gguf = merged.modelPath;
        ui.notify("Fine-tuned model added to your library");
      } catch (error) { ui.notify(error.message, true); }
      finally { s.train.busy = false; render("train"); }
      return true;
    }
    return false;
  }

  if (api) {
    api.site.onDeployLog(function (payload) {
      s.site.log.push(payload.line);
      if (window.blackboxUI && window.blackboxUI.state.view === "publish") render("publish");
    });
    api.training.onLog(function (payload) {
      s.train.log.push(payload.line);
      if (window.blackboxUI && window.blackboxUI.state.view === "train") render("train");
    });
    api.training.onProgress(function (payload) {
      s.train.progress = payload;
      if (window.blackboxUI && window.blackboxUI.state.view === "train") render("train");
    });
  }

  window.BlackboxStudio = { render: render, handle: handle };
})();
