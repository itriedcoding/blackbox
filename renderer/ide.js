/* Code workspace: folder tree, CodeMirror editor, xterm.js shell, model-written projects. */
(function () {
  "use strict";

  var api = window.blackbox;
  var view = null;
  var el = {};
  var editor = null;
  var term = null;
  var fit = null;
  var modeLoads = {};

  var state = {
    mounted: false,
    root: null,
    tree: null,
    truncated: false,
    fileCount: 0,
    tabs: [],
    active: null,
    openDirs: {},
    plan: null,
    generating: false,
    stream: "",
    termId: null,
    silent: false,
    modelLoaded: false,
    languages: 0,
  };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function elById(id) {
    return document.getElementById(id);
  }

  function setStatus(text) {
    var target = elById("ide-gen-status");
    if (target) target.textContent = text || "";
  }

  function setEditorMessage(text) {
    var node = elById("ide-empty");
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("hidden", !text);
  }

  // ------------------------------------------------------------------ mount

  function mount() {
    view = document.querySelector('[data-view-panel="code"]');
    if (!view || state.mounted) return;
    state.mounted = true;

    view.innerHTML =
      '<div class="ide">' +
      '<div class="ide__bar">' +
      '<div class="ide__folder">' +
      '<button class="btn btn--sm btn--primary" data-ide="open">Open folder</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="refresh" title="Re-read the folder">Refresh</button>' +
      '<span class="ide__path mono" id="ide-path">No folder open</span>' +
      "</div>" +
      '<div class="ide__actions">' +
      '<button class="btn btn--sm btn--ghost" data-ide="open-path" title="Type an absolute folder path">Path…</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="recent" title="Folders opened before">Recent</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="new-file">New file</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="new-folder">New folder</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="save" id="ide-save">Save</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="close-tab">Close file</button>' +
      "</div>" +
      "</div>" +
      '<div class="ide__grid">' +
      '<aside class="ide__side">' +
      '<div class="ide__side-head"><span>Explorer</span><span class="ide__count" id="ide-count"></span></div>' +
      '<div class="ide__tree" id="ide-tree"></div>' +
      "</aside>" +
      '<section class="ide__center">' +
      '<div class="ide__tabs" id="ide-tabs"></div>' +
      '<div class="ide__editor" id="ide-editor">' +
      '<div class="ide__empty" id="ide-empty">Open a folder, then choose a file.</div>' +
      '<textarea id="ide-source" spellcheck="false"></textarea>' +
      "</div>" +
      '<div class="ide__gen">' +
      '<div class="ide__gen-head"><span>Build with the local model</span><span class="ide__count" id="ide-gen-status"></span></div>' +
      '<div class="ide__gen-row">' +
      '<textarea id="ide-instruction" rows="2" spellcheck="false" placeholder="Describe a project or a change. The model writes complete files into the open folder."></textarea>' +
      '<div class="ide__gen-buttons">' +
      '<button class="btn btn--sm btn--primary" data-ide="build" id="ide-build" title="Keep generating rounds until the project is complete">Build until done</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="generate" id="ide-generate" title="One reply, reviewed before writing">Plan only</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="stop">Stop</button>' +
      "</div>" +
      "</div>" +
      '<pre class="ide__stream mono" id="ide-stream"></pre>' +
      '<div class="ide__build mono" id="ide-build-log"></div>' +
      '<div class="ide__plan" id="ide-plan"></div>' +
      "</div>" +
      "</section>" +
      '<section class="ide__term">' +
      '<div class="ide__term-head"><span>Terminal</span><span class="ide__term-path mono" id="ide-term-path"></span>' +
      '<button class="btn btn--sm btn--ghost" data-ide="term-restart">Restart</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="term-clear">Clear</button></div>' +
      '<div class="ide__term-body" id="ide-term"></div>' +
      "</section>" +
      "</div>" +
      '<div class="ide__status"><span id="ide-status-lang">—</span><span id="ide-status-pos"></span><span id="ide-status-model"></span></div>' +
      "</div>";

    el.tree = elById("ide-tree");
    el.tabs = elById("ide-tabs");
    el.source = elById("ide-source");
    el.instruction = elById("ide-instruction");
    el.stream = elById("ide-stream");
    el.plan = elById("ide-plan");
    el.buildLog = elById("ide-build-log");
    el.path = elById("ide-path");
    el.count = elById("ide-count");
    el.termBody = elById("ide-term");
    el.termPath = elById("ide-term-path");
    el.lang = elById("ide-status-lang");
    el.pos = elById("ide-status-pos");
    el.model = elById("ide-status-model");

    view.addEventListener("click", onViewClick);
    view.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && event.target === el.instruction) {
        event.preventDefault();
        generate();
      }
    });

    if (window.CodeMirror) {
      editor = window.CodeMirror.fromTextArea(el.source, {
        lineNumbers: true,
        theme: "blackbox",
        indentUnit: 2,
        tabSize: 2,
        lineWrapping: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: true,
        extraKeys: {
          "Ctrl-S": function () { saveActive(); },
          "Cmd-S": function () { saveActive(); },
        },
      });
      editor.setSize("100%", "100%");
      editor.on("change", function () {
        if (state.silent || !state.active) return;
        var tab = findTab(state.active);
        if (!tab) return;
        tab.dirty = editor.getValue() !== tab.content;
        renderTabs();
      });
      editor.on("cursorActivity", function () {
        if (!el.pos) return;
        var cursor = editor.getCursor();
        el.pos.textContent = "Ln " + (cursor.line + 1) + ", Col " + (cursor.ch + 1);
      });
    } else {
      setEditorMessage("The editor runtime did not load.");
    }

    if (api.ide.onGenerateDelta) {
      api.ide.onGenerateDelta(function (payload) {
        if (!payload || typeof payload.text !== "string") return;
        state.stream += payload.text;
        if (el.stream) {
          el.stream.textContent = state.stream.length > 6000 ? state.stream.slice(-6000) : state.stream;
          el.stream.scrollTop = el.stream.scrollHeight;
        }
      });
    }

    if (api.ide.onBuildProgress) {
      api.ide.onBuildProgress(function (payload) {
        if (!payload || payload.done) return;
        setStatus("Round " + payload.round + " · " + payload.files.length + " file(s) · " + fmtBytes(payload.totalBytes));
      });
    }

    if (api.ide.onBuildRound) {
      api.ide.onBuildRound(function (payload) {
        if (!payload) return;
        if (payload.done) return appendBuild("Round " + payload.round + ": model signalled completion");
        if (!payload.files.length) return appendBuild("Round " + payload.round + ": no new files");
        appendBuild("Round " + payload.round + ": " + payload.files.join(", "));
      });
    }

    if (api.ide.onBuildDelta) {
      api.ide.onBuildDelta(function (payload) {
        if (!payload || !el.stream) return;
        state.stream += payload.text;
        el.stream.textContent = state.stream.length > 6000 ? state.stream.slice(-6000) : state.stream;
        el.stream.scrollTop = el.stream.scrollHeight;
      });
    }

    if (api.terminal.onData) {
      api.terminal.onData(function (payload) {
        if (!term || !state.termId || payload.id !== state.termId) return;
        term.write(payload.data);
      });
      api.terminal.onExit(function (payload) {
        if (payload && payload.id === state.termId) state.termId = null;
      });
    }

    refreshState();
  }

  function onViewClick(event) {
    var target = event.target.closest("[data-ide]");
    if (!target) return;
    var action = target.getAttribute("data-ide");
    event.preventDefault();

    switch (action) {
      case "open": return pickFolder();
      case "refresh": return refreshTree();
      case "new-file": return createEntry("file");
      case "new-folder": return createEntry("dir");
      case "save": return saveActive();
      case "close-tab": return closeActive();
      case "generate": return generate();
      case "build": return buildProject();
      case "open-path": return openPathDialog();
      case "recent": return recentFolders();
      case "stop": return stopGenerate();
      case "apply-plan": return applyPlan();
      case "discard-plan": return discardPlan();
      case "term-restart": return restartShell();
      case "term-clear": if (term) term.clear(); return undefined;
      case "open-file": return openFile(target.getAttribute("data-path"));
      case "toggle-dir": return toggleDir(target.getAttribute("data-path"));
      case "remove": return removeActive();
      case "reveal": return revealActive();
      default: return undefined;
    }
  }

  // -------------------------------------------------------------- folder/data

  async function refreshState() {
    try {
      var info = await api.ide.state();
      state.root = info.root || null;
      state.modelLoaded = Boolean(info.model && info.model.loaded);
      state.languages = info.languages || 0;
      paintStatus();
      if (state.root) await refreshTree();
      else {
        if (el.path) el.path.textContent = "No folder open";
        if (el.tree) el.tree.innerHTML = '<div class="ide__hint">Pick a folder to browse its files. Nothing is read until you open a file.</div>';
      }
      if (state.root && !state.termId) startShell();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function pickFolder() {
    try {
      var picked = await api.ide.pickFolder();
      if (!picked) return;
      state.root = picked.root;
      state.tabs = [];
      state.active = null;
      state.openDirs = {};
      if (editor) editor.setValue("");
      renderTabs();
      await refreshTree();
      restartShell();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function refreshTree() {
    if (!state.root) return;
    try {
      var listing = await api.ide.tree();
      state.tree = listing.tree;
      state.truncated = listing.truncated;
      state.fileCount = listing.fileCount;
      state.root = listing.root;
      if (el.path) {
        el.path.textContent = listing.root;
        el.path.title = listing.root;
      }
      if (el.count) el.count.textContent = state.fileCount + " files" + (listing.truncated ? " (partial)" : "");
      renderTree();
    } catch (error) {
      setStatus(error.message);
    }
  }

  function renderTree() {
    if (!el.tree) return;
    if (!state.tree) {
      el.tree.innerHTML = "";
      return;
    }
    var html = "";
    var walk = function (children, depth) {
      for (var i = 0; i < children.length; i += 1) {
        var node = children[i];
        var open = node.type === "dir" ? state.openDirs[node.path] === true || depth === 0 : false;
        var indent = 8 + depth * 12;
        if (node.type === "dir") {
          html +=
            '<button class="ide__row ide__row--dir" data-ide="toggle-dir" data-path="' + esc(node.path) + '" style="padding-left:' + indent + 'px" title="' + esc(node.path) + '">' +
            '<span class="ide__caret">' + (open ? "▾" : "▸") + "</span>" +
            '<span class="ide__name">' + esc(node.name) + "</span>" +
            "</button>";
          if (open && node.children && node.children.length) walk(node.children, depth + 1);
          else if (open && node.collapsed) {
            html += '<div class="ide__hint" style="padding-left:' + (indent + 14) + 'px">Deeper folders are not listed.</div>';
          }
        } else {
          var active = state.active === node.path ? " is-active" : "";
          html +=
            '<button class="ide__row ide__row--file' + active + '" data-ide="open-file" data-path="' + esc(node.path) + '" style="padding-left:' + (indent + 14) + 'px" title="' + esc(node.path) + ' · ' + fmtBytes(node.size) + '">' +
            '<span class="ide__name">' + esc(node.name) + "</span>" +
            "</button>";
        }
      }
    };
    walk(state.tree.children || [], 0);
    el.tree.innerHTML = html || '<div class="ide__hint">This folder is empty.</div>';
  }

  function toggleDir(path) {
    state.openDirs[path] = state.openDirs[path] !== true;
    renderTree();
  }

  // -------------------------------------------------------------------- tabs

  function findTab(path) {
    for (var i = 0; i < state.tabs.length; i += 1) if (state.tabs[i].path === path) return state.tabs[i];
    return null;
  }

  function renderTabs() {
    if (!el.tabs) return;
    if (!state.tabs.length) {
      el.tabs.innerHTML = '<span class="ide__hint">No file open</span>';
      return;
    }
    var html = "";
    for (var i = 0; i < state.tabs.length; i += 1) {
      var tab = state.tabs[i];
      html +=
        '<span class="ide__tab' + (state.active === tab.path ? " is-active" : "") + '" data-ide="open-file" data-path="' + esc(tab.path) + '" title="' + esc(tab.path) + '">' +
        '<span class="ide__tab-name">' + esc(tab.path.split("/").pop()) + "</span>" +
        (tab.dirty ? '<span class="ide__dot"></span>' : "") +
        "</span>";
    }
    el.tabs.innerHTML = html;
  }

  async function openFile(path) {
    if (!path) return;
    var existing = findTab(path);
    if (existing) return activate(path);

    try {
      var file = await api.ide.read(path);
      if (file.tooLarge || file.binary) {
        setEditorMessage(file.message || "This file cannot be opened as text.");
        return;
      }
      if (state.tabs.length >= 10) state.tabs.shift();
      state.tabs.push({ path: file.path, content: file.content, dirty: false, mtimeMs: file.mtimeMs, language: file.language });
      activate(file.path);
      renderTree();
    } catch (error) {
      setEditorMessage(error.message);
    }
  }

  function activate(path) {
    var tab = findTab(path);
    if (!tab || !editor) return;
    state.active = path;
    state.silent = true;
    editor.setValue(tab.content);
    state.silent = false;
    editor.clearHistory();
    tab.dirty = false;
    setEditorMessage("");
    applyLanguage(tab);
    renderTabs();
    renderTree();
    editor.focus();
    if (el.lang) el.lang.textContent = tab.language ? tab.language.label : "Plain text";
  }

  function applyLanguage(tab) {
    if (!editor) return;
    var language = tab.language || { mode: null, modeFile: null };
    if (!language.modeFile) {
      editor.setOption("mode", language.mode || null);
      return;
    }
    if (!modeLoads[language.modeFile]) {
      modeLoads[language.modeFile] = new Promise(function (resolve) {
        var script = document.createElement("script");
        script.src = "vendor/codemirror/mode/" + language.modeFile + ".js";
        script.onload = resolve;
        script.onerror = resolve;
        document.head.appendChild(script);
      });
    }
    modeLoads[language.modeFile].then(function () {
      if (state.active === tab.path && editor) editor.setOption("mode", language.mode || null);
    });
  }

  function closeActive() {
    if (!state.active) return;
    var tab = findTab(state.active);
    if (!tab) return;
    var proceed = function () {
      state.tabs = state.tabs.filter(function (entry) { return entry.path !== tab.path; });
      state.active = state.tabs.length ? state.tabs[state.tabs.length - 1].path : null;
      if (state.active) activate(state.active);
      else {
        if (editor) { state.silent = true; editor.setValue(""); state.silent = false; }
        renderTabs();
        setEditorMessage("Open a folder, then choose a file.");
        if (el.lang) el.lang.textContent = "—";
        if (el.pos) el.pos.textContent = "";
      }
    };
    if (!tab.dirty) return proceed();
    confirmBox("Discard changes to " + tab.path + "?", "Discard").then(function (yes) {
      if (yes) proceed();
    });
  }

  async function saveActive() {
    var tab = findTab(state.active);
    if (!tab || !editor) return;
    var content = editor.getValue();
    try {
      var saved = await api.ide.write({ path: tab.path, content: content, expectedMtimeMs: tab.mtimeMs });
      tab.content = content;
      tab.mtimeMs = saved.mtimeMs;
      tab.dirty = false;
      renderTabs();
      setStatus("Saved " + tab.path);
    } catch (error) {
      if (/changed on disk/i.test(error.message)) {
        confirmBox(tab.path + " changed on disk. Overwrite it with your version?", "Overwrite").then(async function (yes) {
          if (!yes) return;
          try {
            var forced = await api.ide.write({ path: tab.path, content: content, expectedMtimeMs: null });
            tab.content = content;
            tab.mtimeMs = forced.mtimeMs;
            tab.dirty = false;
            renderTabs();
            setStatus("Saved " + tab.path + " (overwrote disk version)");
          } catch (inner) {
            setStatus(inner.message);
          }
        });
      } else {
        setStatus(error.message);
      }
    }
  }

  async function removeActive() {
    var tab = findTab(state.active);
    if (!tab) return;
    var yes = await confirmBox("Move " + tab.path + " to the recycle bin?", "Move to bin");
    if (!yes) return;
    try {
      await api.ide.remove(tab.path);
      var index = state.tabs.indexOf(tab);
      state.tabs.splice(index, 1);
      state.active = state.tabs.length ? state.tabs[Math.max(0, index - 1)].path : null;
      if (state.active) activate(state.active);
      else renderTabs();
      await refreshTree();
      setStatus("Moved " + tab.path + " to the recycle bin");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function revealActive() {
    if (!state.active) return;
    try {
      await api.ide.reveal(state.active);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function createEntry(type) {
    if (!state.root) return setStatus("Open a folder first.");
    var name = await askBox(type === "dir" ? "New folder path" : "New file path", "src/example.ts");
    if (!name) return;
    try {
      await api.ide.create({ path: name, type: type });
      await refreshTree();
      if (type === "file") await openFile(name);
      setStatus("Created " + name);
    } catch (error) {
      setStatus(error.message);
    }
  }

  // ------------------------------------------------------------- model plans

  async function generate() {
    if (!state.root) return setStatus("Open a folder first.");
    var instruction = (el.instruction && el.instruction.value || "").trim();
    if (!instruction) return setStatus("Describe what to build first.");
    if (!state.modelLoaded) return setStatus("Load a model first (Models). The code workspace uses the local model.");

    state.generating = true;
    state.stream = "";
    if (el.stream) el.stream.textContent = "";
    if (el.plan) el.plan.innerHTML = "";
    var button = elById("ide-generate");
    if (button) button.disabled = true;
    setStatus("Generating…");

    try {
      var openPaths = state.tabs.map(function (tab) { return tab.path; });
      var result = await api.ide.generate({ instruction: instruction, files: openPaths });
      state.plan = result;
      if (el.stream && !state.stream) el.stream.textContent = (result.commentary || "").slice(0, 3000);
      renderPlan(result);
      setStatus(result.plan && result.plan.length ? result.plan.length + " file(s) ready to write" : "No files returned");
    } catch (error) {
      setStatus(error.message);
    } finally {
      state.generating = false;
      if (button) button.disabled = false;
    }
  }

  async function stopGenerate() {
    try {
      await api.chat.stop();
      setStatus("Stopped.");
    } catch (error) {
      setStatus(error.message);
    }
  }

  function renderPlan(result) {
    if (!el.plan) return;
    var plan = (result && result.plan) || [];
    if (!plan.length) {
      el.plan.innerHTML =
        '<div class="ide__warn">' + esc(((result && result.warnings) || ["Nothing to write."]).join(" ")) + "</div>";
      return;
    }
    var rows = plan
      .map(function (file, index) {
        var disabled = file.action === "invalid";
        return (
          '<label class="ide__plan-row">' +
          '<input type="checkbox" data-path="' + esc(file.path) + '"' + (disabled ? " disabled" : " checked") + " />" +
          '<span class="ide__plan-path mono">' + esc(file.path) + "</span>" +
          '<span class="ide__plan-meta">' + fmtBytes(file.bytes) + " · " + esc(file.action) + "</span>" +
          "</label>"
        );
      })
      .join("");
    var warnings = ((result && result.warnings) || [])
      .map(function (warning) { return '<div class="ide__warn">' + esc(warning) + "</div>"; })
      .join("");
    el.plan.innerHTML =
      rows +
      warnings +
      '<div class="ide__plan-actions">' +
      '<button class="btn btn--sm btn--primary" data-ide="apply-plan">Write selected files</button>' +
      '<button class="btn btn--sm btn--ghost" data-ide="discard-plan">Discard</button>' +
      '<span class="ide__count">' + fmtBytes(result.totalBytes || 0) + " total</span>" +
      "</div>";
  }

  async function applyPlan() {
    if (!state.plan || !state.plan.id) return setStatus("Generate first.");
    var boxes = el.plan ? Array.prototype.slice.call(el.plan.querySelectorAll("input[type=checkbox]")) : [];
    var paths = boxes.filter(function (box) { return box.checked; }).map(function (box) { return box.getAttribute("data-path"); });
    if (!paths.length) return setStatus("Nothing selected.");
    try {
      var result = await api.ide.apply({ id: state.plan.id, paths: paths });
      state.plan = null;
      if (el.plan) el.plan.innerHTML = "";
      await refreshTree();
      if (result.written.length === 1) await openFile(result.written[0].path);
      setStatus(
        "Wrote " + result.written.length + " file(s)" + (result.failed.length ? ", " + result.failed.length + " failed: " + result.failed[0].message : ""),
      );
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function discardPlan() {
    state.plan = null;
    if (el.plan) el.plan.innerHTML = "";
    try {
      await api.ide.discard();
    } catch (error) {
      /* nothing held */
    }
    setStatus("Plan discarded.");
  }

  async function buildProject() {
    if (!state.root) return setStatus("Open a folder first.");
    var instruction = (el.instruction && el.instruction.value || "").trim();
    if (!instruction) return setStatus("Describe the project first.");
    if (!state.modelLoaded) return setStatus("Load a model first (Models). This runs on the local model.");
    if (state.building) return setStatus("A build is already running.");

    state.building = true;
    state.stream = "";
    if (el.stream) el.stream.textContent = "";
    if (el.plan) el.plan.innerHTML = "";
    if (el.buildLog) el.buildLog.innerHTML = "";
    var buildButton = elById("ide-build");
    if (buildButton) buildButton.disabled = true;
    setStatus("Building…");
    appendBuild("Building: " + instruction);

    try {
      var result = await api.ide.build({ instruction: instruction });
      appendBuild("Finished: " + result.reason + " · " + (result.files ? result.files.length : 0) + " file(s) · " + fmtBytes(result.totalBytes || 0));
      if (result.failures && result.failures.length) {
        appendBuild("Failed: " + result.failures.map(function (failure) { return failure.path + " — " + failure.message; }).join("; "));
      }
      await refreshTree();
      setStatus(result.reason === "done" ? "Project complete" : "Stopped: " + result.reason);
    } catch (error) {
      appendBuild("Error: " + error.message);
      setStatus(error.message);
    } finally {
      state.building = false;
      if (buildButton) buildButton.disabled = false;
    }
  }

  function appendBuild(line) {
    if (!el.buildLog) return;
    var row = document.createElement("div");
    row.className = "ide__build-row";
    row.textContent = line;
    el.buildLog.appendChild(row);
    el.buildLog.scrollTop = el.buildLog.scrollHeight;
  }

  async function adoptFolder(path) {
    var opened = await api.ide.openFolder(path);
    if (!opened) return false;
    state.root = opened.root;
    state.tabs = [];
    state.active = null;
    state.openDirs = {};
    state.plan = null;
    if (editor) {
      state.silent = true;
      editor.setValue("");
      state.silent = false;
    }
    renderTabs();
    setEditorMessage("Open a file from the tree.");
    await refreshTree();
    await restartShell();
    setStatus("Opened " + opened.root);
    return true;
  }

  async function openPathDialog() {
    var value = await askBox("Absolute folder path", "D:/projects/demo");
    if (!value) return;
    try {
      await adoptFolder(value);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function recentFolders() {
    try {
      var info = await api.ide.state();
      var recent = info.recent || [];
      if (!recent.length) return setStatus("No folders opened yet.");
      var picked = await listBox("Open a recent folder", recent);
      if (!picked) return;
      await adoptFolder(picked);
    } catch (error) {
      setStatus(error.message);
    }
  }

  // ---------------------------------------------------------------- terminal

  function mountTerminal() {
    if (term || !window.Terminal || !el.termBody) return;
    term = new window.Terminal({
      fontFamily: 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: "#070707",
        foreground: "#e9e9e6",
        cursor: "#f3f3f1",
        selectionBackground: "rgba(255,255,255,0.22)",
        black: "#141414",
        brightBlack: "#5a5a56",
        white: "#f3f3f1",
        brightWhite: "#ffffff",
        red: "#d8d8d4",
        brightRed: "#f0f0ec",
        green: "#c9c9c4",
        brightGreen: "#eaeae6",
        yellow: "#bdbdb8",
        brightYellow: "#e4e4df",
        blue: "#c2c2bd",
        brightBlue: "#f2f2ee",
        magenta: "#cfcfca",
        brightMagenta: "#f6f6f2",
        cyan: "#c6c6c1",
        brightCyan: "#eeeeea",
      },
    });
    if (window.FitAddon && window.FitAddon.FitAddon) {
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open(el.termBody);
    if (fit) try { fit.fit(); } catch (error) { /* hidden panel */ }
    term.onData(function (data) {
      if (state.termId) api.terminal.write(state.termId, data);
    });
    if (window.ResizeObserver) {
      new window.ResizeObserver(function () {
        if (fit) try { fit.fit(); } catch (error) { /* not visible */ }
      }).observe(el.termBody);
    }
  }

  async function startShell() {
    mountTerminal();
    if (!term) return;
    if (!state.root) {
      term.writeln("Open a folder to start a shell.");
      return;
    }
    try {
      var info = await api.terminal.start({ cwd: state.root });
      state.termId = info.id;
      if (el.termPath) {
        el.termPath.textContent = info.cwd;
        el.termPath.title = info.shell + " · " + info.cwd;
      }
      term.writeln("\x1b[2m" + info.shell + " · " + info.cwd + " · line-oriented shell (no pty)\x1b[0m");
    } catch (error) {
      term.writeln("\x1b[2m" + error.message + "\x1b[0m");
    }
  }

  async function restartShell() {
    if (state.termId) {
      try { await api.terminal.kill(state.termId); } catch (error) { /* already gone */ }
      state.termId = null;
    }
    if (term) term.reset();
    await startShell();
  }

  // ------------------------------------------------------------ small dialogs

  function dialogBox(title, input, confirmLabel) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "ide-modal";
      overlay.innerHTML =
        '<div class="ide-modal__box glass">' +
        '<div class="ide-modal__title">' + esc(title) + "</div>" +
        (input === null ? "" : '<input class="field" id="ide-modal-input" value="' + esc(input) + '" spellcheck="false" />') +
        '<div class="ide-modal__row">' +
        '<button class="btn btn--sm btn--ghost" data-choice="cancel">Cancel</button>' +
        '<button class="btn btn--sm btn--primary" data-choice="ok">' + esc(confirmLabel) + "</button>" +
        "</div></div>";
      document.body.appendChild(overlay);
      var field = overlay.querySelector("input");
      if (field) field.focus();
      var done = function (value) {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      var onKey = function (event) {
        if (event.key === "Escape") { event.preventDefault(); done(null); }
        if (event.key === "Enter" && field) { event.preventDefault(); done(field.value.trim() || null); }
        if (event.key === "Enter" && !field) { event.preventDefault(); done(true); }
      };
      document.addEventListener("keydown", onKey, true);
      overlay.addEventListener("click", function (event) {
        var choice = event.target.getAttribute("data-choice");
        if (choice === "cancel") done(null);
        if (choice === "ok") done(field ? field.value.trim() || null : true);
        if (event.target === overlay) done(null);
      });
    });
  }

  function askBox(title, placeholder) {
    var promise = dialogBox(title, "", "Create");
    return promise.then(function (value) {
      return value;
    });
  }

  function listBox(title, options) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "ide-modal";
      var rows = options
        .map(function (option) {
          return '<button class="ide__recent mono" data-value="' + esc(option) + '" title="' + esc(option) + '">' + esc(option) + "</button>";
        })
        .join("");
      overlay.innerHTML =
        '<div class="ide-modal__box glass">' +
        '<div class="ide-modal__title">' + esc(title) + "</div>" +
        '<div class="ide__recent-list">' + rows + "</div>" +
        '<div class="ide-modal__row"><button class="btn btn--sm btn--ghost" data-choice="cancel">Cancel</button></div>' +
        "</div>";
      document.body.appendChild(overlay);
      overlay.addEventListener("click", function (event) {
        var value = event.target.getAttribute("data-value");
        var cancel = event.target.getAttribute("data-choice") === "cancel" || event.target === overlay;
        overlay.remove();
        resolve(cancel || value === null ? null : value);
      });
    });
  }

  function confirmBox(title, label) {
    return dialogBox(title, null, label || "Confirm").then(function (value) {
      return Boolean(value);
    });
  }

  // ------------------------------------------------------------------- status

  function paintStatus() {
    if (el.model) {
      el.model.textContent = state.modelLoaded ? "Local model loaded" : "No model loaded — loading is required for generation";
      el.model.classList.toggle("is-warn", !state.modelLoaded);
    }
  }

  // -------------------------------------------------------------------- entry

  function render(viewName) {
    if (viewName !== "code") return;
    mount();
    if (state.mounted && view) view.classList.toggle("hidden", false);
  }

  async function handle(action) {
    if (action === "view") return false;
    return false;
  }

  if (api && api.ide) {
    window.BlackboxIde = { render: render, handle: handle };
  }
})();
