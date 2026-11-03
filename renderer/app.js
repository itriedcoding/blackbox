/* Blackbox renderer. Talks to the main process through the preload bridge only. */
(function () {
  "use strict";

  var api = window.blackbox;
  var md = window.BlackboxMarkdown;

  var chatListEl = document.getElementById("chat-list");
  var messagesEl = document.getElementById("messages");
  var composerEl = document.getElementById("composer");
  var modalRoot = document.getElementById("modal-root");
  var toastsEl = document.getElementById("toasts");

  var RING_MARK =
    '<svg class="empty__mark" viewBox="0 0 64 64" aria-hidden="true">' +
    '<rect x="3.5" y="3.5" width="57" height="57" rx="18" fill="none" stroke="currentColor" stroke-width="2.4" opacity="0.9"/>' +
    '<circle cx="32" cy="32" r="13" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
    '<circle cx="32" cy="32" r="3.4" fill="currentColor"/></svg>';

  var state = {
    view: "chat",
    info: null,
    settings: null,
    chats: [],
    chat: null,
    models: [],
    catalog: null,
    catalogError: null,
    modelsTab: "discover",
    search: { query: "", uncensoredOnly: true, results: null, loading: false, error: null, ran: false },
    repoInput: "",
    downloads: new Map(),
    engine: { provider: "local", loaded: false, modelName: null, modelPath: null, contextSize: null, gpu: false, busy: false, gateway: null },
    loading: null,
    streaming: { active: false, chatId: null, stopping: false },
    streamNode: null,
    pinned: true,
    settingsSaveTimer: null,
    searchTimer: null,
    diagnostics: null,
    gateway: { models: null, loading: false, error: null }
  };

  // ---------------------------------------------------------------- helpers

  function $(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function fmtBytes(bytes) {
    var value = Number(bytes);
    if (!isFinite(value) || value <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    var scaled = value / Math.pow(1024, exponent);
    var digits = scaled >= 100 || exponent === 0 ? 0 : scaled >= 10 ? 1 : 2;
    return scaled.toFixed(digits) + " " + units[exponent];
  }

  function fmtSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return "";
    return fmtBytes(bytesPerSecond) + "/s";
  }

  function fmtDuration(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return "";
    if (seconds < 60) return Math.round(seconds) + "s";
    var minutes = Math.floor(seconds / 60);
    return minutes + "m " + Math.round(seconds % 60) + "s";
  }

  function fmtCount(value) {
    var number = Number(value) || 0;
    if (number >= 1000000) return (number / 1000000).toFixed(1) + "M";
    if (number >= 1000) return (number / 1000).toFixed(1) + "k";
    return String(number);
  }

  function timeAgo(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    var seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
    if (seconds < 604800) return Math.floor(seconds / 86400) + "d";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function notify(message, isError) {
    var node = document.createElement("div");
    node.className = "toast" + (isError ? " is-error" : "");
    node.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      (isError
        ? '<path d="M8 4.2v4.6M8 11.2v.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.1"/>'
        : '<path d="M3.6 8.4l2.8 2.8 5.9-6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>') +
      "</svg><span>" +
      esc(message) +
      "</span>";
    toastsEl.appendChild(node);
    setTimeout(function () {
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      node.style.transition = "all .25s ease";
      setTimeout(function () {
        node.remove();
      }, 260);
    }, isError ? 7000 : 3800);
  }

  function openModal(html) {
    modalRoot.innerHTML = html;
    modalRoot.classList.add("is-open");
  }

  var pendingConfirm = null;

  function closeModal() {
    modalRoot.classList.remove("is-open");
    modalRoot.innerHTML = "";
    // A confirm dialog dismissed by Escape or a backdrop click must settle its promise,
    // otherwise the caller awaits forever.
    if (pendingConfirm) {
      var settle = pendingConfirm;
      pendingConfirm = null;
      settle(false);
    }
  }

  function confirmDialog(options) {
    return new Promise(function (resolve) {
      openModal(
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<div class="modal__head"><div><div class="modal__title">' +
          esc(options.title) +
          '</div><div class="modal__sub">' +
          esc(options.subtitle || "") +
          "</div></div>" +
          '<button class="icon-btn" data-action="modal-close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></div>' +
          '<div class="modal__body"><div style="font-size:12.5px;line-height:1.65;color:var(--ink-soft);white-space:pre-wrap">' +
          esc(options.message) +
          "</div></div>" +
          '<div class="modal__foot"><button class="btn btn--ghost" data-action="modal-cancel">' +
          esc(options.cancelLabel || "Cancel") +
          '</button><button class="btn btn--primary" data-action="modal-confirm">' +
          esc(options.confirmLabel || "Continue") +
          "</button></div></div>",
      );
      pendingConfirm = resolve;
      modalRoot.querySelector('[data-action="modal-confirm"]').addEventListener("click", function () {
        pendingConfirm = null;
        closeModal();
        resolve(true);
      });
      modalRoot.querySelector('[data-action="modal-cancel"]').addEventListener("click", function () {
        closeModal();
      });
    });
  }

  // ---------------------------------------------------------------- chrome

  function modelDisplayName(path) {
    if (!path) return "None loaded";
    return path
      .split(/[\\/]/)
      .pop()
      .replace(/\.gguf$/i, "")
      .replace(/__/g, " · ");
  }

  function activeModelName() {
    if (state.engine.provider === "gateway") return state.engine.modelName || "No gateway model";
    return modelDisplayName(state.engine.modelPath);
  }

  function gatewayHost(url) {
    try {
      return new URL(String(url)).host;
    } catch (error) {
      return "gateway";
    }
  }

  function isGateway() {
    return state.engine.provider === "gateway";
  }

  function paintTitleStatus() {
    var el = document.getElementById("titlebar-status");
    if (!el) return;
    if (state.loading) {
      var percent = state.loading.progress ? " " + Math.round(state.loading.progress * 100) + "%" : "";
      el.innerHTML = '<span class="spin"></span><span>' + esc(state.loading.message || "Loading model") + esc(percent) + "</span>";
      return;
    }
    if (state.streaming.active) {
      el.innerHTML = '<span class="spin"></span><span>Generating</span>';
      return;
    }
    if (state.engine.loaded) {
      el.innerHTML =
        '<span class="status-dot is-live"></span><span>' +
        esc(state.engine.modelName || "model") +
        (state.engine.gpu ? " · " + esc(String(state.engine.gpu)) : " · CPU") +
        "</span>";
      return;
    }
    el.innerHTML = "";
  }

  function paintMemory() {
    var memory = state.info && state.info.memory;
    if (!memory) return;
    var used = Math.max(0, memory.totalMem - memory.freeMem);
    var percent = Math.min(100, (used / memory.totalMem) * 100);
    var fill = document.getElementById("memory-fill");
    var readout = document.getElementById("memory-readout");
    if (fill) fill.style.width = percent.toFixed(1) + "%";
    if (readout) readout.textContent = fmtBytes(memory.freeMem) + " free";
  }

  async function refreshMemory() {
    try {
      var fresh = await api.system.info();
      state.info.memory = fresh.memory;
      paintMemory();
    } catch (error) {
      /* memory readout is cosmetic; never block the UI on it */
    }
  }

  function paintRailModel() {
    var dot = document.getElementById("rail-model-dot");
    var name = document.getElementById("rail-model-name");
    var meta = document.getElementById("rail-model-meta");
    if (!dot || !name || !meta) return;

    var remote = isGateway();
    dot.className = "status-dot" + (state.engine.loaded ? " is-live" : "");
    name.textContent = state.engine.loaded ? activeModelName() : remote ? "No gateway model" : "None loaded";

    var metaText = remote ? "AI Gateway · add a key in Settings" : "Choose a model to begin";
    if (state.loading) {
      metaText = (state.loading.message || "Loading") + (state.loading.progress ? " " + Math.round(state.loading.progress * 100) + "%" : "");
    } else if (state.engine.loaded) {
      metaText = remote
        ? "AI Gateway · " + gatewayHost(state.engine.gateway && state.engine.gateway.baseUrl)
        : (state.engine.contextSize ? state.engine.contextSize + " ctx · " : "") +
          (state.engine.gpu ? String(state.engine.gpu) : "CPU") +
          (state.engine.fileInfo && state.engine.fileInfo.architecture ? " · " + state.engine.fileInfo.architecture : "");
    }
    meta.textContent = metaText;

    var chipName = document.getElementById("composer-model-name");
    var chipDot = document.getElementById("composer-dot");
    if (chipName) chipName.textContent = state.engine.loaded ? activeModelName() : remote ? "No gateway model" : "No model";
    if (chipDot) chipDot.className = "status-dot status-dot--sm" + (state.engine.loaded ? " is-live" : "");
  }

  function paintChatChrome() {
    var title = document.getElementById("chat-title");
    var sub = document.getElementById("chat-sub");
    var sendBtn = document.getElementById("send-btn");
    var stopBtn = document.getElementById("stop-btn");
    var hint = document.getElementById("composer-hint");
    var foot = document.getElementById("composer-foot");

    if (title) title.textContent = state.chat ? state.chat.title : "New conversation";
    var remote = isGateway();
    if (sub) {
      if (state.loading) sub.textContent = (state.loading.message || "Loading model") + "…";
      else if (state.engine.loaded && remote) {
        sub.textContent = activeModelName() + " · via AI Gateway · " + ((state.engine.gateway && state.engine.gateway.keyHint) || "your key");
      } else if (state.engine.loaded) {
        sub.textContent =
          modelDisplayName(state.engine.modelPath) +
          " · " +
          (state.engine.contextSize || state.settings.contextSize) +
          " context · " +
          (state.engine.gpu ? String(state.engine.gpu) + " + CPU" : "CPU only");
      } else {
        sub.textContent = remote ? "Add an AI Gateway key in Settings, or switch back to a local model." : "No model loaded. Pick one to start generating.";
      }
    }

    if (composerEl) {
      composerEl.disabled = !state.engine.loaded;
      composerEl.placeholder = state.engine.loaded
        ? remote
          ? "Ask anything. Prompts go to the AI Gateway with your key."
          : "Ask anything. Nothing leaves this machine."
        : remote
          ? "Add a gateway key and model to start writing."
          : "Load a model to start writing.";
    }

    if (sendBtn) {
      sendBtn.classList.toggle("hidden", state.streaming.active);
      sendBtn.disabled = !state.engine.loaded || state.streaming.active;
    }
    if (stopBtn) {
      stopBtn.classList.toggle("hidden", !state.streaming.active);
      stopBtn.disabled = !state.streaming.active || state.streaming.stopping;
    }
    if (hint) {
      hint.textContent = state.streaming.active
        ? state.streaming.stopping
          ? "Stopping…"
          : remote
            ? "Streaming from the AI Gateway"
            : "Streaming tokens from your CPU"
        : "Enter to send · Shift+Enter for a new line";
    }
    if (foot) {
      foot.textContent = remote
        ? state.engine.loaded
          ? "Answered by the AI Gateway · billed to your provider account · key stays in the main process"
          : "Local models need no key. The gateway needs yours."
        : state.engine.loaded
          ? "Runs entirely on this machine · no account · no telemetry · no filters"
          : "No cloud, no GPU required, no content filter in the path.";
    }
  }

  function renderRail() {
    if (!chatListEl) return;
    if (!state.chats.length) {
      chatListEl.innerHTML = '<div class="chat-list__empty">Nothing here yet. Your conversations are saved on this machine only.</div>';
    } else {
      chatListEl.innerHTML = state.chats
        .map(function (chat) {
          var active = state.chat && state.chat.id === chat.id;
          return (
            '<div class="chat-item' +
            (active ? " is-active" : "") +
            '" data-action="open-chat" data-id="' +
            esc(chat.id) +
            '">' +
            '<span class="chat-item__title">' +
            esc(chat.title || "Untitled") +
            "</span>" +
            '<button class="chat-item__del" data-action="delete-chat" data-id="' +
            esc(chat.id) +
            '" title="Delete" aria-label="Delete conversation">' +
            '<svg viewBox="0 0 12 12" width="11" height="11"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>' +
            "</button></div>"
          );
        })
        .join("");
    }
    paintRailModel();
    paintMemory();

    var modelsNav = document.getElementById("nav-models");
    var settingsNav = document.getElementById("nav-settings");
    if (modelsNav) modelsNav.classList.toggle("is-active", state.view === "models");
    if (settingsNav) settingsNav.classList.toggle("is-active", state.view === "settings");
  }

  // ------------------------------------------------------------------ chat

  function messageMeta(message, index) {
    if (message.role === "user") return "You";
    var parts = [];
    if (message.stats && message.stats.tokens) {
      parts.push(message.stats.tokens + " tok");
      if (message.stats.tokensPerSecond) parts.push(message.stats.tokensPerSecond.toFixed(1) + " tok/s");
      if (message.stats.stopped) parts.push("stopped");
    } else if (message.pending) {
      parts.push("generating");
    } else if (message.error) {
      parts.push("error");
    }
    return parts.length ? parts.join(" · ") : "Blackbox";
  }

  function messageHtml(message, index) {
    if (message.role === "user") {
      return (
        '<div class="msg msg--user"><div class="msg__body">' +
        esc(message.content) +
        '</div><div class="msg__meta">You</div></div>'
      );
    }

    if (message.pending) {
      return (
        '<div class="msg msg--assistant"><div class="msg__body msg__body--stream" data-stream="1">' +
        esc(message.content) +
        '</div><div class="msg__meta">' +
        esc(messageMeta(message, index)) +
        "</div></div>"
      );
    }

    if (message.error) {
      return (
        '<div class="msg msg--assistant is-error"><div class="msg__body">' +
        esc(message.content) +
        '</div><div class="msg__meta">Generation failed</div></div>'
      );
    }

    return (
      '<div class="msg msg--assistant"><div class="msg__body md">' +
      md.render(message.content) +
      '</div><div class="msg__meta">' +
      esc(messageMeta(message, index)) +
      "</div></div>"
    );
  }

  function chatIsEmpty() {
    return !state.chat || state.chat.messages.length === 0;
  }

  function emptyChatHtml() {
    if (isGateway() && !state.engine.loaded) {
      return (
        '<div class="empty">' +
        RING_MARK +
        '<div class="empty__title">Run a model without the download</div>' +
        '<p class="empty__text">Add an AI Gateway key and pick a model, and a hosted model answers instead of a file on disk. Local GGUF models still run with no key at all.</p>' +
        '<div class="empty__actions"><button class="btn btn--primary" data-action="view" data-view="settings">Add gateway key</button>' +
        '<button class="btn btn--ghost" data-action="view" data-view="models">Use a local model</button></div>' +
        '<p class="empty__text" style="font-size:11.5px;color:var(--ink-ghost)">The key is encrypted on this machine and never reaches the window.</p>' +
        "</div>"
      );
    }

    if (!state.engine.loaded) {
      return (
        '<div class="empty">' +
        RING_MARK +
        '<div class="empty__title">Run a model that answers you</div>' +
        '<p class="empty__text">Blackbox runs abliterated GGUF models directly on this machine\'s CPU. No API keys, no accounts, no GPU, no output filtering between the model and you.</p>' +
        '<div class="empty__actions"><button class="btn btn--primary" data-action="view" data-view="models">Choose a model</button>' +
        '<button class="btn btn--ghost" data-action="view" data-view="settings">Tune memory</button></div>' +
        '<p class="empty__text" style="font-size:11.5px;color:var(--ink-ghost)">A 0.5B quant runs in under 1 GB. A 3B at Q4_K_M runs in about 2.5 GB.</p>' +
        "</div>"
      );
    }

    var prompts = [
      "Explain how attention works in a transformer, in plain language.",
      "Write a Python function that tails a log file and prints only errors.",
      "Take this paragraph and make it colder and more precise: ",
      "Draft a blunt, five-line reply to: "
    ];
    return (
      '<div class="empty">' +
      RING_MARK +
      '<div class="empty__title">' +
      esc(activeModelName()) +
      (isGateway() ? " · AI Gateway" : "") +
      " is loaded</div>" +
      '<p class="empty__text">' +
      (isGateway()
        ? esc("Answers stream from the gateway, billed to your provider account")
        : esc((state.engine.contextSize || state.settings.contextSize) + " token context · ") +
          esc(state.engine.gpu ? String(state.engine.gpu) + " + CPU" : "CPU") +
          " · " +
          esc(state.settings.threads + " threads")) +
      "</p>" +
      '<div class="prompt-grid">' +
      prompts
        .map(function (prompt) {
          return '<button class="prompt-chip" data-action="use-prompt" data-prompt="' + esc(prompt) + '">' + esc(prompt) + "</button>";
        })
        .join("") +
      "</div></div>"
    );
  }

  function setStreamNode() {
    state.streamNode = messagesEl.querySelector('[data-stream="1"]');
  }

  function renderMessages() {
    if (!messagesEl) return;
    if (!state.chat || chatIsEmpty()) {
      messagesEl.innerHTML = emptyChatHtml();
      state.streamNode = null;
      return;
    }
    messagesEl.innerHTML = state.chat.messages.map(messageHtml).join("");
    setStreamNode();
    if (state.engine.loaded === false && state.chat.messages.length > 0) {
      // keep the conversation visible even if the model was unloaded
    }
    scrollToBottom(true);
  }

  function scrollToBottom(force) {
    if (!messagesEl) return;
    if (force || state.pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function paintStream() {
    if (!state.streamNode || !state.chat) return;
    var last = state.chat.messages[state.chat.messages.length - 1];
    if (!last) return;
    state.streamNode.textContent = last.content;
    var meta = state.streamNode.parentElement.querySelector(".msg__meta");
    if (meta) meta.textContent = last.stats ? messageMeta(last, 0) : "generating · " + last.content.length + " chars";
    scrollToBottom(false);
  }

  function autosize() {
    if (!composerEl) return;
    composerEl.style.height = "auto";
    composerEl.style.height = Math.min(composerEl.scrollHeight, 190) + "px";
  }

  // ------------------------------------------------------------- chat actions

  function newChatId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function newChat(options) {
    var opts = options || {};
    if (state.streaming.active) {
      notify("Stop the current response first.");
      return;
    }
    var chat = {
      id: newChatId(),
      title: "New conversation",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    };
    state.chat = chat;
    state.view = "chat";
    renderViews();
    renderChat();
    renderRail();
    if (opts.focus !== false && composerEl) composerEl.focus();
    try {
      await api.chats.save(chat);
      await refreshChats();
    } catch (error) {
      notify(error.message, true);
    }
  }

  async function openChat(id) {
    if (state.streaming.active) {
      notify("Stop the current response first.");
      return;
    }
    try {
      var chat = await api.chats.get(id);
      if (!chat) {
        notify("That conversation is gone.", true);
        await refreshChats();
        return;
      }
      state.chat = {
        id: chat.id,
        title: chat.title || "Untitled",
        createdAt: chat.createdAt,
        messages: Array.isArray(chat.messages) ? chat.messages : []
      };
      state.view = "chat";
      renderViews();
      renderChat();
      renderRail();
    } catch (error) {
      notify(error.message, true);
    }
  }

  async function refreshChats() {
    try {
      state.chats = await api.chats.list();
    } catch (error) {
      state.chats = [];
    }
    renderRail();
  }

  async function persistChat() {
    if (!state.chat) return;
    try {
      var plain = {
        id: state.chat.id,
        title: state.chat.title,
        createdAt: state.chat.createdAt,
        modelPath: state.engine.modelPath,
        messages: state.chat.messages.map(function (message) {
          return {
            role: message.role,
            content: message.content,
            stats: message.stats || null,
            error: message.error || false,
            at: message.at || null
          };
        })
      };
      await api.chats.save(plain);
      await refreshChats();
    } catch (error) {
      notify("Could not save the conversation: " + error.message, true);
    }
  }

  async function sendMessage() {
    if (!state.engine.loaded) {
      notify("Load a model first.", true);
      state.view = "models";
      renderViews();
      return;
    }
    if (state.streaming.active) return;
    var text = composerEl.value.trim();
    if (!text) return;

    if (!state.chat) {
      await newChat({ focus: false });
    }

    var chat = state.chat;
    var history = chat.messages
      .filter(function (message) {
        return !message.pending && !message.error && message.content;
      })
      .map(function (message) {
        return { role: message.role, content: message.content };
      });

    chat.messages.push({ role: "user", content: text, at: Date.now() });
    if (!chat.title || chat.title === "New conversation") {
      chat.title = text.length > 58 ? text.slice(0, 58).trim() + "…" : text;
    }

    var assistant = { role: "assistant", content: "", pending: true, at: Date.now() };
    chat.messages.push(assistant);

    composerEl.value = "";
    autosize();
    state.streaming.active = true;
    state.streaming.chatId = chat.id;
    state.streaming.stopping = false;
    state.pinned = true;

    renderViews();
    renderChat();
    renderRail();

    try {
      var result = await api.chat.start({
        chatId: chat.id,
        systemPrompt: state.settings.systemPrompt,
        history: history,
        prompt: text,
        temperature: state.settings.temperature,
        topP: state.settings.topP,
        maxTokens: state.settings.maxTokens
      });

      assistant.pending = false;
      assistant.content = (result && result.text) || assistant.content || "(no output)";
      assistant.stats = result ? result.stats : null;
    } catch (error) {
      assistant.pending = false;
      assistant.error = true;
      assistant.content = error && error.message ? error.message : String(error);
    } finally {
      state.streaming.active = false;
      state.streaming.chatId = null;
      state.streaming.stopping = false;
      state.streamNode = null;
      renderChat();
      renderRail();
      paintTitleStatus();
      await persistChat();
      if (composerEl) composerEl.focus();
    }
  }

  async function stopGeneration() {
    if (!state.streaming.active) return;
    state.streaming.stopping = true;
    paintChatChrome();
    paintTitleStatus();
    try {
      await api.chat.stop();
    } catch (error) {
      notify(error.message, true);
    }
  }

  // ------------------------------------------------------------------ models

  function curatedCard(entry) {
    var tags = ['<span class="tag">' + esc(entry.params) + "</span>"];
    if (entry.recommendedQuant) {
      tags.push(
        '<span class="tag">' +
          esc(entry.recommendedQuant) +
          (entry.recommendedSize ? " · " + esc(fmtBytes(entry.recommendedSize)) : "") +
          "</span>",
      );
    }
    tags.push('<span class="tag">' + esc(entry.license) + "</span>");
    if (entry.available && entry.fits === false) tags.push('<span class="tag tag--warn">over RAM budget</span>');
    if (entry.error) tags.push('<span class="tag tag--warn">unreachable</span>');

    var downloadLabel = entry.available
      ? entry.recommendedQuant
        ? "Get " + entry.recommendedQuant
        : "Choose a file"
      : "Unavailable";

    return (
      '<div class="card">' +
      '<div class="card__top"><div style="min-width:0"><div class="card__name">' +
      esc(entry.name) +
      '</div><div class="card__repo">' +
      esc(entry.repo) +
      "</div></div>" +
      (entry.tag === "recommended" ? '<span class="tag tag--solid">pick</span>' : "") +
      "</div>" +
      '<p class="card__blurb">' +
      esc(entry.blurb) +
      "</p>" +
      '<div class="card__meta">' +
      tags.join("") +
      "</div>" +
      '<div class="card__actions">' +
      '<button class="btn btn--sm btn--ghost" data-action="open-repo" data-repo="' +
      esc(entry.repo) +
      '">All quants</button>' +
      '<button class="btn btn--sm btn--primary" data-action="open-repo" data-repo="' +
      esc(entry.repo) +
      '"' +
      (entry.available ? "" : " disabled") +
      ">" +
      esc(downloadLabel) +
      "</button></div></div>"
    );
  }

  function searchResultRow(entry) {
    return (
      '<div class="row"><div class="row__main"><div class="row__title">' +
      esc(entry.id) +
      '</div><div class="row__sub">' +
      esc(fmtCount(entry.downloads) + " downloads · " + fmtCount(entry.likes) + " likes" + (entry.gated ? " · gated" : "")) +
      "</div></div>" +
      (entry.uncensored ? '<span class="tag">uncensored</span>' : "") +
      '<div class="row__actions"><button class="btn btn--sm" data-action="open-repo" data-repo="' +
      esc(entry.id) +
      '">Files</button></div></div>'
    );
  }

  function downloadRow(job) {
    var percent = job.percent == null ? null : Math.min(100, job.percent);
    var sub;
    if (job.status === "done") sub = "complete · " + fmtBytes(job.total || job.received);
    else if (job.status === "error") sub = job.error || "failed";
    else if (job.status === "cancelled") sub = "cancelled · file kept for resume";
    else
      sub =
        fmtBytes(job.received) +
        " / " +
        fmtBytes(job.total) +
        " · " +
        fmtSpeed(job.bytesPerSecond) +
        (job.etaSeconds ? " · " + fmtDuration(job.etaSeconds) + " left" : "");

    var actions = "";
    if (job.status === "downloading") {
      actions = '<button class="btn btn--sm btn--ghost" data-action="cancel-download" data-id="' + esc(job.id) + '">Cancel</button>';
    } else if (job.status === "done") {
      actions =
        '<button class="btn btn--sm btn--primary" data-action="load-target" data-path="' + esc(job.target) + '">Load</button>';
    } else {
      actions =
        '<button class="btn btn--sm" data-action="retry-download" data-id="' + esc(job.id) + '">Resume</button>';
    }

    return (
      '<div class="row" data-dl="' +
      esc(job.id) +
      '"><div class="row__main"><div class="row__title">' +
      esc(job.filename) +
      '</div><div class="row__sub">' +
      esc(job.repo) +
      " · " +
      esc(sub) +
      "</div>" +
      (job.status === "downloading"
        ? '<div class="progress"><div class="progress__fill" style="width:' + (percent == null ? 30 : percent) + '%"></div></div>'
        : "") +
      '</div><div class="row__actions">' +
      (percent != null && job.status === "downloading" ? '<span class="mono">' + Math.round(percent) + "%</span>" : "") +
      actions +
      "</div></div>"
    );
  }

  function localModelRow(model) {
    var isLoaded = state.engine.loaded && state.engine.modelPath === model.path;
    var isBusy = state.loading && state.loading.path === model.path;
    var meta = [
      fmtBytes(model.size),
      model.quant,
      model.architecture || "gguf",
      model.contextLength ? model.contextLength + " ctx train" : null,
      model.repo || "imported"
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      '<div class="row"><div class="row__main"><div class="row__title">' +
      esc(model.filename.replace(/\.gguf$/i, "")) +
      '</div><div class="row__sub">' +
      esc(meta) +
      "</div></div>" +
      (isLoaded ? '<span class="tag tag--solid">loaded</span>' : "") +
      '<div class="row__actions">' +
      '<button class="icon-btn" data-action="reveal-model" data-path="' +
      esc(model.path) +
      '" title="Show in folder" aria-label="Show in folder"><svg viewBox="0 0 16 16"><path d="M2.5 5.2h4l1.2 1.6h5.8v6.4a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V5.2z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 5.2V3.6a.8.8 0 0 1 .8-.8h3l1.2 1.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>' +
      '<button class="icon-btn" data-action="delete-model" data-path="' +
      esc(model.path) +
      '" title="Delete file" aria-label="Delete file"><svg viewBox="0 0 16 16"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.2h4.8L11 4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>' +
      (isLoaded
        ? '<button class="btn btn--sm btn--ghost" data-action="unload-model">Unload</button>'
        : '<button class="btn btn--sm btn--primary" data-action="load-model" data-path="' +
          esc(model.path) +
          '"' +
          (isBusy ? " disabled" : "") +
          ">" +
          (isBusy ? "Loading…" : "Load") +
          "</button>") +
      "</div></div>"
    );
  }

  function tabButton(id, label, count) {
    return (
      '<button class="tab' +
      (state.modelsTab === id ? " is-active" : "") +
      '" data-action="models-tab" data-tab="' +
      id +
      '">' +
      esc(label) +
      (count ? '<span class="tab__count">' + count + "</span>" : "") +
      "</button>"
    );
  }

  function discoverHtml() {
    var html = "";
    var memory = state.info ? state.info.memory : null;

    html +=
      '<div class="search-bar">' +
      '<div class="search-input"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.3 10.3l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
      '<input type="text" id="hf-search" placeholder="Search GGUF models on huggingface.co" value="' +
      esc(state.search.query) +
      '" spellcheck="false" /></div>' +
      '<label class="toggle"><input type="checkbox" id="uncensored-only"' +
      (state.search.uncensoredOnly ? " checked" : "") +
      ' /><span class="toggle__track"></span>Uncensored only</label>' +
      "</div>";

    html += '<div class="section-label">Starter models · verified repos</div>';
    if (state.catalogError) {
      html +=
        '<div class="note"><svg viewBox="0 0 16 16"><path d="M8 4v4.4M8 11.4v.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>' +
        "<div>Could not reach huggingface.co: " +
        esc(state.catalogError) +
        ' <button class="btn btn--sm btn--ghost" data-action="reload-catalog" style="margin-left:8px">Retry</button></div></div>';
    } else if (!state.catalog) {
      html += '<div class="empty-small">Reading the model list from huggingface.co…</div>';
    } else {
      html += '<div class="cards">' + state.catalog.entries.map(curatedCard).join("") + "</div>";
      if (memory) {
        html +=
          '<div class="note" style="margin-top:12px"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M8 5.2v3.4M8 10.4v.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
          "<div>RAM budget for weights + context: <strong>" +
          esc(fmtBytes(memory.budget)) +
          "</strong> (of " +
          esc(fmtBytes(memory.totalMem)) +
          " installed). Sizes above come live from the Hub, not from this app's copy.</div></div>";
      }
    }

    html += '<div class="section-label">Search results</div>';
    html += '<div id="search-results">' + searchResultsHtml() + "</div>";

    html += '<div class="section-label">Any GGUF repository</div>';
    html +=
      '<div class="search-bar"><div class="search-input"><input type="text" id="repo-input" placeholder="owner/model-GGUF or a huggingface.co URL" value="' +
      esc(state.repoInput) +
      '" spellcheck="false" /></div>' +
      '<button class="btn" data-action="inspect-repo">Inspect files</button>' +
      '<button class="btn btn--ghost" data-action="import-model">Add local file</button></div>';

    return html;
  }

  function searchResultsHtml() {
    if (state.search.loading) return '<div class="empty-small">Searching huggingface.co…</div>';
    if (state.search.error) return '<div class="note"><div>' + esc(state.search.error) + "</div></div>";
    if (!state.search.results) {
      return '<div class="empty-small">Type a query to search every GGUF repo on the Hub.</div>';
    }
    if (!state.search.results.length) {
      return '<div class="empty-small">No GGUF repos matched. Try a shorter query, or turn off the uncensored filter.</div>';
    }
    return '<div class="list">' + state.search.results.map(searchResultRow).join("") + "</div>";
  }

  function libraryHtml() {
    if (!state.models.length) {
      return (
        '<div class="note"><svg viewBox="0 0 16 16"><path d="M2.5 12.5V6l5.5-3.5L13.5 6v6.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 12.5V9h4v3.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>' +
        "<div>No models on disk yet. Download one from Discover, or drop a .gguf file into the model folder with <strong>Add local file</strong>.</div></div>" +
        '<div class="empty-small" style="text-align:left;padding-left:2px">Model folder: <span class="mono">' +
        esc(state.info ? state.info.paths.models : "") +
        '</span> <button class="btn btn--sm btn--ghost" data-action="open-models-folder">Open folder</button></div>'
      );
    }
    return '<div class="list">' + state.models.map(localModelRow).join("") + "</div>";
  }

  function downloadsHtml() {
    var jobs = Array.from(state.downloads.values()).sort(function (a, b) {
      return a.id < b.id ? 1 : -1;
    });
    if (!jobs.length) {
      return '<div class="empty-small">No downloads in this session.</div>';
    }
    return '<div class="list">' + jobs.map(downloadRow).join("") + "</div>";
  }

  function renderModels() {
    var host = document.getElementById("view-models");
    if (!host) return;

    var activeDownloads = Array.from(state.downloads.values()).filter(function (job) {
      return job.status === "downloading";
    }).length;

    var title = state.info ? "huggingface.co · budget " + fmtBytes(state.info.memory.budget) : "huggingface.co";

    host.innerHTML =
      '<div class="page"><div class="page__head">' +
      '<div><h2 class="page__title">Models</h2><p class="page__sub">' +
      esc(title) +
      "</p></div>" +
      '<div class="tabs">' +
      tabButton("discover", "Discover", null) +
      tabButton("library", "Library", state.models.length) +
      tabButton("downloads", "Downloads", activeDownloads) +
      "</div></div>" +
      (state.modelsTab === "discover" ? discoverHtml() : state.modelsTab === "library" ? libraryHtml() : downloadsHtml()) +
      "</div>";

    bindModelsInputs();
  }

  function bindModelsInputs() {
    var searchInput = document.getElementById("hf-search");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        state.search.query = searchInput.value;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(function () {
          runSearch();
        }, 420);
      });
      searchInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          clearTimeout(state.searchTimer);
          runSearch();
        }
      });
    }

    var uncensored = document.getElementById("uncensored-only");
    if (uncensored) {
      uncensored.addEventListener("change", function () {
        state.search.uncensoredOnly = uncensored.checked;
        if (state.search.query) runSearch();
      });
    }

    var repoInput = document.getElementById("repo-input");
    if (repoInput) {
      repoInput.addEventListener("input", function () {
        state.repoInput = repoInput.value;
      });
      repoInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          inspectRepo(state.repoInput);
        }
      });
    }
  }

  async function runSearch() {
    var query = state.search.query.trim();
    var container = document.getElementById("search-results");
    if (!query) {
      state.search.results = null;
      state.search.ran = false;
      if (container) container.innerHTML = searchResultsHtml();
      return;
    }
    state.search.loading = true;
    state.search.error = null;
    if (container) container.innerHTML = searchResultsHtml();
    try {
      var response = await api.hf.search({ query: query, uncensoredOnly: state.search.uncensoredOnly, limit: 25 });
      state.search.results = response.results;
      state.search.ran = true;
    } catch (error) {
      state.search.error = error.message;
      state.search.results = null;
    } finally {
      state.search.loading = false;
      container = document.getElementById("search-results");
      if (container) container.innerHTML = searchResultsHtml();
    }
  }

  // ------------------------------------------------------------- file picker

  async function inspectRepo(repo) {
    var repoId = String(repo || "").trim();
    if (!repoId) {
      notify("Paste a repository id first.", true);
      return;
    }
    openModal(
      '<div class="modal"><div class="modal__head"><div><div class="modal__title">Reading repository</div><div class="modal__sub">' +
      esc(repoId) +
      "</div></div>" +
      '<button class="icon-btn" data-action="modal-close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></div>' +
      '<div class="modal__body"><div class="empty-small">Querying huggingface.co…</div></div></div>',
    );

    try {
      var data = await api.hf.files({ repo: repoId });
      renderFilePicker(data);
    } catch (error) {
      openModal(
        '<div class="modal"><div class="modal__head"><div><div class="modal__title">Could not read that repo</div><div class="modal__sub">' +
        esc(repoId) +
        "</div></div>" +
        '<button class="icon-btn" data-action="modal-close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></div>' +
        '<div class="modal__body"><div class="note"><div>' +
        esc(error.message) +
        "</div></div></div>" +
        '<div class="modal__foot"><button class="btn btn--ghost" data-action="modal-close">Close</button></div></div>',
      );
    }
  }

  function renderFilePicker(data) {
    var budget = data.memory ? data.memory.budget : Infinity;
    var rows = data.files
      .map(function (file) {
        var tooBig = file.size > budget;
        var isRecommended = file.path === data.recommendedPath;
        return (
          '<div class="quant-row' +
          (isRecommended ? " is-recommended" : "") +
          '"><div class="row__main"><div class="quant-row__name">' +
          esc(file.quant) +
          (isRecommended ? '<span class="tag tag--solid">fits best</span>' : "") +
          (file.splitted ? '<span class="tag tag--warn">split</span>' : "") +
          '</div><div class="quant-row__meta">' +
          esc(fmtBytes(file.size) + " · " + file.quality + (tooBig ? " · larger than RAM budget" : "")) +
          '</div><div class="row__sub">' +
          esc(file.path) +
          "</div></div>" +
          '<div class="row__actions"><button class="btn btn--sm' +
          (isRecommended ? " btn--primary" : "") +
          '" data-action="download-file" data-repo="' +
          esc(data.repo.id) +
          '" data-path="' +
          esc(file.path) +
          '" data-size="' +
          file.size +
          '"' +
          (file.splitted ? " disabled" : "") +
          ">Download</button></div></div>"
        );
      })
      .join("");

    openModal(
      '<div class="modal"><div class="modal__head"><div style="min-width:0"><div class="modal__title">' +
      esc(data.repo.id) +
      '</div><div class="modal__sub">' +
      esc(
        fmtCount(data.repo.downloads) +
          " downloads · " +
          fmtCount(data.repo.likes) +
          " likes · " +
          (data.repo.gated ? "gated" : "public") +
          " · " +
          data.files.length +
          " GGUF files",
      ) +
      "</div></div>" +
      '<button class="icon-btn" data-action="modal-close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></div>' +
      '<div class="modal__body">' +
      rows +
      '<div class="modal__note" style="margin-top:8px">Files download straight from huggingface.co to this machine. Split quants are listed but not offered, because this app loads single-file models.</div>' +
      "</div>" +
      '<div class="modal__foot"><div class="modal__note">Highest quality that fits your ' +
      esc(fmtBytes(budget)) +
      " budget is marked.</div>" +
      '<button class="btn btn--ghost" data-action="modal-close">Close</button></div></div>',
    );
  }

  // ----------------------------------------------------------------- settings

  function numberField(id, label, value, min, max, step, hint, suffix) {
    return (
      '<div class="field-row"><label class="field-row__label" for="' +
      id +
      '"><span>' +
      esc(label) +
      '</span><span class="field-row__value" id="' +
      id +
      '-value">' +
      esc(value + (suffix || "")) +
      "</span></label>" +
      '<input type="range" id="' +
      id +
      '" data-setting="' +
      id +
      '" data-kind="number" min="' +
      min +
      '" max="' +
      max +
      '" step="' +
      step +
      '" value="' +
      value +
      '" />' +
      (hint ? '<div class="field-row__hint">' + esc(hint) + "</div>" : "") +
      "</div>"
    );
  }

  function renderSettings() {
    var host = document.getElementById("view-settings");
    if (!host) return;
    var settings = state.settings;
    var info = state.info;

    var threadOptions = info ? info.threadOptions.slice() : [2, 4, 6, 8];
    if (threadOptions.indexOf(settings.threads) === -1) {
      threadOptions.push(settings.threads);
      threadOptions.sort(function (a, b) {
        return a - b;
      });
    }

    var contextChoices = [1024, 2048, 4096, 8192, 16384];
    if (contextChoices.indexOf(settings.contextSize) === -1) contextChoices.push(settings.contextSize);

    host.innerHTML =
      '<div class="page"><div class="page__head"><div><h2 class="page__title">Settings</h2><p class="page__sub">stored on this machine · ' +
      esc(info ? info.platform + " " + info.arch : "") +
      "</p></div></div>" +
      '<div class="settings-grid">' +
      // model source
      gatewayPanelHtml() +
      // performance
      '<div class="panel"><div class="panel__title">Memory & compute</div><p class="panel__sub">Applied the next time a model loads.</p>' +
      '<div class="field-row"><label class="field-row__label" for="set-threads">CPU threads</label>' +
      '<select id="set-threads" data-setting="threads" data-kind="number">' +
      threadOptions
        .map(function (option) {
          return '<option value="' + option + '"' + (option === settings.threads ? " selected" : "") + ">" + option + " threads</option>";
        })
        .join("") +
      "</select>" +
      '<div class="field-row__hint">' +
      esc(info ? info.cpuModel + " · " + info.cores + " logical cores" : "") +
      "</div></div>" +
      '<div class="field-row"><label class="field-row__label" for="set-context">Context window</label>' +
      '<select id="set-context" data-setting="contextSize" data-kind="number">' +
      contextChoices
        .map(function (choice) {
          return (
            '<option value="' + choice + '"' + (choice === settings.contextSize ? " selected" : "") + ">" + choice + " tokens" + (state.engine.loaded ? " · ~" + fmtBytes(estimateKv(choice)) + " KV" : "") + "</option>"
          );
        })
        .join("") +
      "</select>" +
      '<div class="field-row__hint">Bigger context costs RAM up front. 2048–4096 keeps a 4 GB machine comfortable.</div></div>' +
      '<div class="field-row"><label class="field-row__label" for="set-gpu">Acceleration</label>' +
      '<select id="set-gpu" data-setting="gpu" data-kind="string">' +
      '<option value="auto"' +
      (settings.gpu === "auto" ? " selected" : "") +
      ">Auto (use GPU when present)</option>" +
      '<option value="cpu"' +
      (settings.gpu === "cpu" ? " selected" : "") +
      ">CPU only</option>" +
      "</select>" +
      '<div class="field-row__hint">This build never requires a GPU. Auto simply uses one if llama.cpp finds a supported device.</div></div>' +
      '<div class="meter" id="set-meter"></div>' +
      "</div>" +
      // generation
      '<div class="panel"><div class="panel__title">Generation</div><p class="panel__sub">Defaults for every new message in this app.</p>' +
      numberField("temperature", "Temperature", settings.temperature, 0, 1.5, 0.05, "Higher values drift further from the model's safest continuation.", "") +
      numberField("topP", "Top P", settings.topP, 0.1, 1, 0.01, "Nucleus sampling cutoff.", "") +
      numberField("maxTokens", "Max tokens", settings.maxTokens, 64, 2048, 32, "Upper bound for one response.", "") +
      "</div>" +
      // system prompt
      '<div class="panel"><div class="panel__title">System prompt</div><p class="panel__sub">Sent with every conversation. There is no hidden prompt layered on top.</p>' +
      '<textarea class="field" id="set-system" data-setting="systemPrompt" data-kind="string" rows="6" spellcheck="false">' +
      esc(settings.systemPrompt) +
      "</textarea>" +
      '<div class="field-row__hint">Editing this clears the warm context; the next message starts fresh.</div>' +
      '<div><button class="btn btn--sm btn--ghost" data-action="reset-prompt">Restore default prompt</button></div>' +
      "</div>" +
      // Hugging Face
      '<div class="panel"><div class="panel__title">Hugging Face access</div><p class="panel__sub">Optional. Public repos download without a token; gated or private ones need one.</p>' +
      '<div class="field-row"><label class="field-row__label" for="set-token">Access token</label>' +
      '<input type="password" id="set-token" data-setting="hfToken" data-kind="string" placeholder="hf_… (leave empty for public repos)" value="' +
      esc(settings.hfToken) +
      '" spellcheck="false" autocomplete="off" />' +
      '<div class="field-row__hint">Stored in plain text in this app\'s settings file on your machine. It is only sent to huggingface.co.</div></div>' +
      '<div class="kv"><span>Token status</span><span class="kv__value">' +
      (settings.hfToken ? "set" : "not set") +
      "</span></div>" +
      "</div>" +
      // storage
      '<div class="panel"><div class="panel__title">Storage</div><p class="panel__sub">Models and conversations never leave this folder.</p>' +
      '<div class="field-row"><div class="field-row__label"><span>Model folder</span></div><div class="mono" style="word-break:break-all;color:var(--ink-soft)">' +
      esc(info ? info.paths.models : "") +
      "</div>" +
      '<div class="field-row__label" style="margin-top:6px"><span>App data</span></div><div class="mono" style="word-break:break-all;color:var(--ink-faint)">' +
      esc(info ? info.paths.root : "") +
      "</div></div>" +
      '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn--sm" data-action="open-models-folder">Open model folder</button>' +
      '<button class="btn btn--sm btn--ghost" data-action="import-model">Add local file</button>' +
      '<button class="btn btn--sm btn--ghost" data-action="reload-catalog">Refresh Hub data</button></div>' +
      "</div>" +
      // engine
      '<div class="panel"><div class="panel__title">Engine</div><p class="panel__sub">Live state of the llama.cpp runtime.</p>' +
      '<div id="set-diagnostics"><div class="empty-small" style="text-align:left;padding:0">Reading…</div></div>' +
      "</div>" +
      "</div></div>";

    bindSettingsInputs();
    refreshDiagnostics();
  }

  function providerButton(provider, label, active) {
    return (
      '<button type="button" class="seg__btn' +
      (active ? " is-active" : "") +
      '" data-action="set-provider" data-provider="' +
      provider +
      '">' +
      esc(label) +
      "</button>"
    );
  }

  function gatewayPanelHtml() {
    var settings = state.settings;
    var gatewayState = state.gateway || {};
    var remote = settings.provider === "gateway";
    var keySet = Boolean(settings.gatewayKeySet);
    var models = gatewayState.models;
    var ids = models
      ? models.map(function (model) {
          return model.id;
        })
      : [];
    var current = settings.gatewayModel || "";
    if (current && ids.indexOf(current) === -1) current = "";

    var keyStatus = keySet
      ? "Saved " +
        esc(settings.gatewayKeyHint || "") +
        " · " +
        (settings.gatewayKeyEncrypted ? "encrypted by this OS" : "stored without OS encryption")
      : "No key saved";

    var options = '<option value=""' + (current ? "" : " selected") + ">Choose a model...</option>";
    options += ids
      .map(function (id) {
        return '<option value="' + esc(id) + '"' + (id === current ? " selected" : "") + ">" + esc(id) + "</option>";
      })
      .join("");

    var modelHint = gatewayState.loading
      ? "Loading the live model list from the gateway…"
      : gatewayState.error
        ? esc(gatewayState.error)
        : models
          ? ids.length + " models available with this key."
          : "Refresh to load the models this key can use.";

    var body = remote
      ? '<div class="field-row"><label class="field-row__label" for="set-gateway-key">API key</label>' +
        '<div style="display:flex;gap:6px"><input type="password" id="set-gateway-key" placeholder="' +
        (keySet ? "Replace the saved key" : "Paste your AI Gateway key") +
        '" spellcheck="false" autocomplete="off" style="flex:1;min-width:0" />' +
        '<button type="button" class="btn btn--sm btn--primary" data-action="gateway-save-key">Save</button></div>' +
        '<div class="field-row__hint">' +
        keyStatus +
        ". Create one at Vercel → AI Gateway → API Keys. It is sent only to the gateway." +
        "</div>" +
        (keySet ? '<div><button type="button" class="btn btn--sm btn--ghost" data-action="gateway-clear-key">Remove key</button></div>' : "") +
        "</div>" +
        '<div class="field-row"><label class="field-row__label" for="set-gateway-url">Gateway URL</label>' +
        '<input type="text" id="set-gateway-url" data-setting="gatewayBaseUrl" data-kind="string" value="' +
        esc(settings.gatewayBaseUrl || "") +
        '" spellcheck="false" />' +
        '<div class="field-row__hint">Any OpenAI-compatible base URL, including a gateway you host yourself.</div></div>' +
        '<div class="field-row"><label class="field-row__label" for="set-gateway-model">Model</label>' +
        '<select id="set-gateway-model" data-setting="gatewayModel" data-kind="string">' +
        options +
        "</select>" +
        '<div class="field-row__hint">' +
        modelHint +
        "</div></div>" +
        '<div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="btn btn--sm" data-action="gateway-refresh"' +
        (keySet ? "" : " disabled") +
        ">Refresh models</button>" +
        '<button type="button" class="btn btn--sm btn--ghost" data-action="view" data-view="chat">Back to chat</button></div>'
      : "";

    return (
      '<div class="panel"><div class="panel__title">Model source</div><p class="panel__sub">Run a GGUF file on this machine, or send prompts to the AI Gateway with your own key.</p>' +
      '<div class="seg">' +
      providerButton("local", "This machine", !remote) +
      providerButton("gateway", "AI Gateway", remote) +
      "</div>" +
      '<div class="field-row__hint" style="margin-top:8px">' +
      (remote
        ? "Prompts leave this machine and go to the gateway URL below, billed to your key."
        : "Nothing leaves this machine. No account, no key, and no calls to a model provider.") +
      "</div>" +
      body +
      "</div>"
    );
  }

  async function syncEngine() {
    state.engine = Object.assign(state.engine, await api.engine.status());
    paintRailModel();
    paintChatChrome();
    paintTitleStatus();
    renderMessages();
  }

  async function setProvider(provider) {
    if (provider !== "local" && provider !== "gateway") return;
    if (state.settings.provider === provider) return;
    try {
      state.settings = await api.settings.set({ provider: provider });
      await syncEngine();
      renderSettings();
      notify(provider === "gateway" ? "Generation now goes through the AI Gateway." : "Generation now runs on this machine.");
      if (provider === "gateway" && state.settings.gatewayKeySet) await refreshGatewayModels();
    } catch (error) {
      notify("Could not switch provider: " + error.message, true);
    }
  }

  async function saveGatewayKey() {
    var input = document.getElementById("set-gateway-key");
    var value = input ? input.value.trim() : "";
    if (!value) {
      notify("Paste a gateway key first.", true);
      return;
    }
    try {
      state.settings = await api.gateway.setKey(value);
      await syncEngine();
      notify(
        state.settings.gatewayKeyEncrypted
          ? "Key saved and encrypted by this OS."
          : "Key saved. This machine offers no OS encryption, so it is only obfuscated on disk.",
      );
      renderSettings();
      await refreshGatewayModels();
    } catch (error) {
      notify(error.message, true);
    }
  }

  async function clearGatewayKey() {
    try {
      state.settings = await api.gateway.clearKey();
      state.gateway.models = null;
      state.gateway.error = null;
      await syncEngine();
      renderSettings();
      notify("Gateway key removed.");
    } catch (error) {
      notify(error.message, true);
    }
  }

  async function refreshGatewayModels() {
    if (!state.settings.gatewayKeySet) {
      notify("Save a gateway key first.", true);
      return;
    }
    state.gateway.loading = true;
    state.gateway.error = null;
    if (state.view === "settings") renderSettings();
    try {
      var result = await api.gateway.models({});
      state.gateway.models = result.models;
      if (!state.settings.gatewayModel || !result.models.some(function (model) { return model.id === state.settings.gatewayModel; })) {
        if (result.models.length === 1) {
          state.settings = await api.settings.set({ gatewayModel: result.models[0].id });
        }
      }
      await syncEngine();
    } catch (error) {
      state.gateway.models = null;
      state.gateway.error = error.message;
    } finally {
      state.gateway.loading = false;
      if (state.view === "settings") renderSettings();
    }
  }

  function estimateKv(contextSize) {
    var info = state.engine.fileInfo;
    var perToken = info && info.kvBytesPerToken ? info.kvBytesPerToken : 30000;
    return perToken * contextSize;
  }

  var settingsBound = false;

  function bindGatewayActions(host) {
    host.addEventListener(
      "click",
      function (event) {
        var target = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
        if (!target || !host.contains(target)) return;
        var action = target.getAttribute("data-action");
        if (action === "set-provider") {
          event.preventDefault();
          event.stopPropagation();
          setProvider(target.getAttribute("data-provider"));
        } else if (action === "gateway-save-key") {
          event.preventDefault();
          event.stopPropagation();
          saveGatewayKey();
        } else if (action === "gateway-clear-key") {
          event.preventDefault();
          event.stopPropagation();
          clearGatewayKey();
        } else if (action === "gateway-refresh") {
          event.preventDefault();
          event.stopPropagation();
          refreshGatewayModels();
        }
      },
      true,
    );
  }

  function bindSettingsInputs() {
    var host = document.getElementById("view-settings");
    if (!host || settingsBound) return;
    settingsBound = true;
    bindGatewayActions(host);

    host.addEventListener("input", function (event) {
      var target = event.target;
      var key = target.getAttribute("data-setting");
      if (!key) return;
      var kind = target.getAttribute("data-kind");
      var value = kind === "number" ? Number(target.value) : target.value;
      state.settings[key] = value;

      if (target.type === "range") {
        var readout = document.getElementById(target.id + "-value");
        if (readout) readout.textContent = key === "maxTokens" ? String(Math.round(value)) : Number(value).toFixed(2);
      }
      if (key === "hfToken" || key === "systemPrompt" || key === "gatewayBaseUrl") return;
      scheduleSettingsSave(key);
    });

    host.addEventListener("change", function (event) {
      var target = event.target;
      var key = target.getAttribute("data-setting");
      if (!key) return;
      var kind = target.getAttribute("data-kind");
      var value = kind === "number" ? Number(target.value) : target.value;
      state.settings[key] = value;
      if (key === "hfToken") state.catalog = null;
      scheduleSettingsSave(key);
      if (key === "hfToken") {
        var status = host.querySelector(".kv__value");
        if (status) status.textContent = value ? "set" : "not set";
      }
      if (key === "contextSize") refreshDiagnostics();
    });
  }

  function scheduleSettingsSave(key) {
    if (!state.settingsSaveTimer) {
      state.settingsSaveTimer = setTimeout(function () {
        state.settingsSaveTimer = null;
        saveSettingsIgnoringErrors();
      }, 350);
    }
    if (key === "contextSize" || key === "threads") {
      clearTimeout(state.settingsSaveTimer);
      state.settingsSaveTimer = null;
      saveSettingsIgnoringErrors();
    }
  }

  async function saveSettingsIgnoringErrors() {
    try {
      state.settings = await api.settings.set(state.settings);
      state.engine = Object.assign(state.engine, await api.engine.status());
      paintChatChrome();
      paintRailModel();
      paintTitleStatus();
    } catch (error) {
      notify("Could not save settings: " + error.message, true);
    }
  }

  async function refreshDiagnostics() {
    var host = document.getElementById("set-diagnostics");
    if (!host) return;

    var status = state.engine;
    var rows = [];
    rows.push(["Backend", status.gpu ? String(status.gpu) + " + CPU" : status.loaded ? "CPU" : "not initialised"]);
    rows.push(["Loaded model", status.loaded ? modelDisplayName(status.modelPath) : "none"]);
    if (status.loaded) {
      rows.push(["Context", (status.contextSize || "—") + " tokens"]);
      rows.push(["Threads", (status.threads || "—") + " / " + (state.info ? state.info.cores : "?")]);
      if (status.fileInfo && status.fileInfo.architecture) rows.push(["Architecture", status.fileInfo.architecture]);
      if (status.fileInfo && status.fileInfo.blockCount) rows.push(["Layers", String(status.fileInfo.blockCount)]);
      if (status.fileInfo && status.fileInfo.kvBytesPerToken) rows.push(["KV per token", fmtBytes(status.fileInfo.kvBytesPerToken)]);
    }
    if (state.info) {
      rows.push(["llama.cpp", "node-llama-cpp " + (state.info.engineVersion || "—")]);
      rows.push(["Electron", state.info.versions.electron || "—"]);
      rows.push(["Node", state.info.versions.node || "—"]);
    }

    var memory = state.info ? state.info.memory : null;
    if (memory) {
      rows.push(["System memory", fmtBytes(memory.totalMem)]);
      rows.push(["Free memory", fmtBytes(memory.freeMem)]);
      rows.push(["RAM budget", fmtBytes(memory.budget)]);
    }

    host.innerHTML = rows
      .map(function (row) {
        return '<div class="kv"><span>' + esc(row[0]) + '</span><span class="kv__value">' + esc(row[1]) + "</span></div>";
      })
      .join("");

    var meter = document.getElementById("set-meter");
    if (meter && memory) {
      var html = "";
      if (status.loaded && status.modelPath) {
        try {
          var fit = await api.models.fit({ path: status.modelPath, contextSize: state.settings.contextSize });
          var total = memory.budget;
          var weights = fit.fileSize;
          var kv = fit.estimatedKv;
          var usedPercent = Math.min(100, (weights / total) * 100);
          var kvPercent = Math.min(100 - usedPercent, (kv / total) * 100);
          html =
            '<div class="field-row__label"><span>Budget for the loaded model</span><span class="field-row__value">' +
            esc(fmtBytes(weights + kv)) +
            " / " +
            esc(fmtBytes(total)) +
            "</span></div>" +
            '<div class="meter__bar"><div class="meter__used" style="width:' +
            usedPercent +
            '%"></div><div class="meter__kv" style="width:' +
            kvPercent +
            '%"></div></div>' +
            '<div class="legend"><span><i></i>weights</span><span><i class="dim"></i>KV cache</span></div>' +
            '<div class="field-row__hint">' +
            esc(fit.message) +
            "</div>";
        } catch (error) {
          html = '<div class="field-row__hint">' + esc(error.message) + "</div>";
        }
      } else {
        html =
          '<div class="field-row__label"><span>System memory</span><span class="field-row__value">' +
          esc(fmtBytes(memory.totalMem - memory.freeMem) + " used / " + fmtBytes(memory.totalMem)) +
          "</span></div>" +
          '<div class="meter__bar"><div class="meter__used" style="width:' +
          Math.min(100, ((memory.totalMem - memory.freeMem) / memory.totalMem) * 100) +
          '%"></div></div>';
      }
      meter.innerHTML = html;
    }
  }

  // ---------------------------------------------------------------- loading

  async function loadModel(modelPath, options) {
    var opts = options || {};
    if (!modelPath) return;
    state.loading = { path: modelPath, progress: 0, message: "Preparing model" };
    paintTitleStatus();
    paintRailModel();
    if (state.view === "models") renderModels();

    try {
      var result = await api.engine.load({
        modelPath: modelPath,
        contextSize: state.settings.contextSize,
        threads: state.settings.threads,
        gpu: state.settings.gpu,
        force: Boolean(opts.force)
      });

      if (result.blocked) {
        state.loading = null;
        paintTitleStatus();
        paintRailModel();
        var proceed = await confirmDialog({
          title: "Not enough headroom",
          subtitle: "Memory guard",
          message:
            result.message +
            "\n\nLoading anyway can push the machine into swap and make Windows unresponsive. Close other apps first if you continue.",
          confirmLabel: "Load anyway",
          cancelLabel: "Keep it small"
        });
        if (proceed) return loadModel(modelPath, { force: true });
        return;
      }

      state.engine = Object.assign({}, result.status);
      if (state.chat) state.chat.modelPath = modelPath;
      notify("Loaded " + modelDisplayName(modelPath));
      await persistChat();
      renderSettings();
    } catch (error) {
      notify(error.message, true);
    } finally {
      state.loading = null;
      paintTitleStatus();
      paintRailModel();
      paintChatChrome();
      refreshMemory();
      renderMessages();
      if (state.view === "models") renderModels();
    }
  }

  async function unloadModel() {
    try {
      state.engine = Object.assign({}, await api.engine.unload());
      notify("Model unloaded. RAM released.");
      refreshMemory();
      renderAll();
    } catch (error) {
      notify(error.message, true);
    }
  }

  async function refreshModels() {
    try {
      state.models = await api.models.local();
    } catch (error) {
      state.models = [];
    }
    if (state.view === "models") renderModels();
  }

  async function loadCatalog(force) {
    if (state.catalog && !force) return;
    state.catalogError = null;
    if (force) renderModels();
    try {
      state.catalog = await api.catalog.list();
    } catch (error) {
      state.catalogError = error.message;
    }
    if (state.view === "models") renderModels();
  }

  // ---------------------------------------------------------------- actions

  async function handleAction(action, element, event) {
    switch (action) {
      case "new-chat":
        await newChat();
        break;
      case "open-chat":
        await openChat(element.getAttribute("data-id"));
        break;
      case "delete-chat": {
        event.stopPropagation();
        var id = element.getAttribute("data-id");
        if (state.streaming.active && state.chat && state.chat.id === id) {
          notify("Stop the response before deleting this conversation.", true);
          return;
        }
        var ok = await confirmDialog({
          title: "Delete conversation",
          subtitle: "Stored on this machine only",
          message: "This removes the transcript from disk. There is no cloud copy to fall back on.",
          confirmLabel: "Delete"
        });
        if (!ok) return;
        if (state.streaming.active && state.chat && state.chat.id === id) await api.chat.stop();
        await api.chats.remove(id);
        if (state.chat && state.chat.id === id) {
          state.chat = null;
          await newChat({ focus: false });
        }
        await refreshChats();
        break;
      }
      case "view":
        state.view = element.getAttribute("data-view");
        renderViews();
        renderRail();
        if (state.view === "models") {
          loadCatalog(false);
          refreshModels();
        }
        break;
      case "models-tab":
        state.modelsTab = element.getAttribute("data-tab");
        renderModels();
        break;
      case "reload-catalog":
        state.catalog = null;
        await loadCatalog(true);
        break;
      case "open-repo":
        await inspectRepo(element.getAttribute("data-repo"));
        break;
      case "inspect-repo":
        await inspectRepo(state.repoInput);
        break;
      case "download-file": {
        var repo = element.getAttribute("data-repo");
        var path = element.getAttribute("data-path");
        var size = Number(element.getAttribute("data-size"));
        element.disabled = true;
        try {
          await api.downloads.start({ repo: repo, path: path, size: size });
          closeModal();
          notify("Download started · " + path.split("/").pop());
          state.modelsTab = "downloads";
          renderModels();
        } catch (error) {
          element.disabled = false;
          notify(error.message, true);
        }
        break;
      }
      case "cancel-download":
        await api.downloads.cancel(element.getAttribute("data-id"));
        break;
      case "retry-download": {
        var job = state.downloads.get(element.getAttribute("data-id"));
        if (job) {
          try {
            await api.downloads.start({ repo: job.repo, path: job.path, size: job.total });
            notify("Resuming download.");
          } catch (error) {
            notify(error.message, true);
          }
        }
        break;
      }
      case "load-model":
        await loadModel(element.getAttribute("data-path"));
        break;
      case "load-target":
        await loadModel(element.getAttribute("data-path"));
        break;
      case "unload-model":
        await unloadModel();
        break;
      case "delete-model": {
        var target = element.getAttribute("data-path");
        var confirmed = await confirmDialog({
          title: "Delete model file",
          subtitle: target.split(/[\\/]/).pop(),
          message: "The GGUF file is removed from disk. You can download it again from the Hub at any time.",
          confirmLabel: "Delete file"
        });
        if (!confirmed) return;
        try {
          await api.models.remove(target);
          notify("Model file deleted.");
          await refreshModels();
          state.engine = Object.assign({}, await api.engine.status());
          renderAll();
        } catch (error) {
          notify(error.message, true);
        }
        break;
      }
      case "reveal-model":
        await api.models.reveal(element.getAttribute("data-path"));
        break;
      case "import-model":
        try {
          var imported = await api.models.import();
          if (imported) {
            notify("Model added: " + imported.split(/[\\/]/).pop());
            await refreshModels();
            state.modelsTab = "library";
            renderModels();
          }
        } catch (error) {
          notify(error.message, true);
        }
        break;
      case "open-models-folder":
        await api.system.openModelsFolder();
        break;
      case "send":
        await sendMessage();
        break;
      case "stop":
        await stopGeneration();
        break;
      case "use-prompt": {
        composerEl.value = element.getAttribute("data-prompt");
        autosize();
        composerEl.focus();
        break;
      }
      case "clear-chat": {
        if (!state.chat || !state.chat.messages.length) return;
        if (state.streaming.active) {
          notify("Stop the response before clearing the transcript.", true);
          return;
        }
        var clearOk = await confirmDialog({
          title: "Clear this conversation",
          subtitle: state.chat.title,
          message: "The transcript is deleted. The loaded model stays in memory.",
          confirmLabel: "Clear"
        });
        if (!clearOk) return;
        state.chat.messages = [];
        renderMessages();
        await persistChat();
        break;
      }
      case "open-sampling":
        openSamplingModal();
        break;
      case "reset-prompt":
        state.settings.systemPrompt = state.info.defaultSettings.systemPrompt;
        await saveSettingsIgnoringErrors();
        renderSettings();
        notify("System prompt restored.");
        break;
      case "modal-close":
      case "modal-cancel":
        closeModal();
        break;
      default:
        if (window.BlackboxStudio && (await window.BlackboxStudio.handle(action, element, event))) return;
        if (window.BlackboxIde && (await window.BlackboxIde.handle(action, element, event))) return;
        break;
    }
  }

  function openSamplingModal() {
    var settings = state.settings;
    openModal(
      '<div class="modal" style="max-width:460px"><div class="modal__head"><div><div class="modal__title">Sampling</div><div class="modal__sub">applies to the next message</div></div>' +
      '<button class="icon-btn" data-action="modal-close" aria-label="Close"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></div>' +
      '<div class="modal__body">' +
      numberField("m-temperature", "Temperature", settings.temperature, 0, 1.5, 0.05, "", "") +
      numberField("m-topP", "Top P", settings.topP, 0.1, 1, 0.01, "", "") +
      numberField("m-maxTokens", "Max tokens", settings.maxTokens, 64, 2048, 32, "", "") +
      "</div>" +
      '<div class="modal__foot"><button class="btn btn--ghost" data-action="modal-close">Done</button></div></div>',
    );

    modalRoot.querySelectorAll("input[data-setting]").forEach(function (input) {
      input.addEventListener("input", function () {
        var key = input.id.replace("m-", "");
        var value = Number(input.value);
        state.settings[key] = value;
        var readout = document.getElementById(input.id + "-value");
        if (readout) readout.textContent = key === "maxTokens" ? String(Math.round(value)) : value.toFixed(2);
        scheduleSettingsSave(key);
      });
    });
  }

  // ----------------------------------------------------------------- render

  function renderViews() {
    ["chat", "models", "settings", "publish", "train", "api", "code"].forEach(function (view) {
      var panel = document.querySelector('[data-view-panel="' + view + '"]');
      if (panel) panel.classList.toggle("hidden", state.view !== view);
    });
    if (state.view === "models") renderModels();
    if (state.view === "settings") renderSettings();
    if (window.BlackboxStudio) window.BlackboxStudio.render(state.view);
    if (window.BlackboxIde) window.BlackboxIde.render(state.view);
  }

  function renderChat() {
    paintChatChrome();
    renderMessages();
  }

  function renderAll() {
    paintTitleStatus();
    renderRail();
    renderViews();
    renderChat();
  }

  // ------------------------------------------------------------------- boot

  window.blackboxUI = { state: state, notify: notify, esc: esc, fmtBytes: fmtBytes };

  async function boot() {
    if (!api) {
      document.body.innerHTML =
        '<div style="padding:40px;font-family:monospace;color:#eee;line-height:1.6">Blackbox must be launched with Electron.<br />Run "npm start" from the project folder.</div>';
      return;
    }

    document.querySelectorAll("[data-win]").forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.getAttribute("data-win");
        if (action === "minimize") api.window.minimize();
        if (action === "maximize") api.window.maximize();
        if (action === "close") api.window.close();
      });
    });

    document.addEventListener("click", function (event) {
      var link = event.target.closest && event.target.closest("a[href]");
      if (link) {
        var href = link.getAttribute("href");
        if (href && href.indexOf("http") === 0) {
          event.preventDefault();
          api.system.openExternal(href);
          return;
        }
      }

      if (event.target === modalRoot) {
        closeModal();
        return;
      }

      var element = event.target.closest && event.target.closest("[data-action]");
      if (!element) return;
      var action = element.getAttribute("data-action");
      handleAction(action, element, event).catch(function (error) {
        notify(error && error.message ? error.message : String(error), true);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && modalRoot.classList.contains("is-open")) closeModal();
    });

    composerEl.addEventListener("input", autosize);
    composerEl.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    var scroller = messagesEl;
    scroller.addEventListener("scroll", function () {
      state.pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    });

    api.chat.onDelta(function (payload) {
      if (!state.chat || state.chat.id !== payload.chatId) return;
      var last = state.chat.messages[state.chat.messages.length - 1];
      if (!last || last.role !== "assistant" || !last.pending) return;
      last.content += payload.text;
      if (!state.streamNode) setStreamNode();
      paintStream();
    });

    api.engine.onProgress(function (payload) {
      if (!state.loading) return;
      state.loading.progress = payload.progress;
      state.loading.message = payload.message || (payload.phase === "context" ? "Allocating context" : "Loading weights");
      if (state.loading.progress >= 1) state.loading.message = "Ready";
      paintTitleStatus();
      paintRailModel();
    });

    api.downloads.onProgress(function (job) {
      state.downloads.set(job.id, job);
      if (state.view === "models" && state.modelsTab === "downloads") {
        var row = document.querySelector('[data-dl="' + job.id + '"]');
        if (row) {
          var fill = row.querySelector(".progress__fill");
          var sub = row.querySelector(".row__sub");
          var percentEl = row.querySelector(".mono");
          if (fill && job.percent != null) fill.style.width = job.percent + "%";
          if (percentEl && job.percent != null) percentEl.textContent = Math.round(job.percent) + "%";
          if (sub) {
            sub.textContent =
              job.status === "downloading"
                ? job.repo + " · " + fmtBytes(job.received) + " / " + fmtBytes(job.total) + " · " + fmtSpeed(job.bytesPerSecond)
                : job.repo + " · " + (job.status === "done" ? "complete" : job.status);
          }
        } else {
          renderModels();
        }
      }
      renderRail();
    });

    api.downloads.onComplete(function (job) {
      state.downloads.set(job.id, job);
      notify("Downloaded " + job.filename + " · " + fmtBytes(job.total));
      refreshModels();
      refreshMemory();
      if (state.view === "models") renderModels();
    });

    var info = await api.system.info();
    state.info = info;
    state.settings = info.settings;
    state.engine = Object.assign(state.engine, await api.engine.status());

    await refreshChats();
    await refreshModels();

    if (state.chats.length && state.chats[0].id) {
      await openChat(state.chats[0].id);
    } else {
      await newChat({ focus: false });
    }

    renderAll();

    if (state.settings.activeModelPath && state.models.some(function (model) { return model.path === state.settings.activeModelPath; })) {
      await loadModel(state.settings.activeModelPath);
    }

    if (state.settings.provider === "gateway" && state.settings.gatewayKeySet) {
      refreshGatewayModels();
    }

    if (state.view === "chat" && state.engine.loaded && composerEl) composerEl.focus();
  }

  // Both paths below can fire (a deferred script runs while readyState is already
  // "interactive"), so boot exactly once — a second boot would double every listener.
  var started = false;

  function start() {
    if (started) return;
    started = true;
    boot().catch(function (error) {
      notify(error && error.message ? error.message : String(error), true);
      console.error(error);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
