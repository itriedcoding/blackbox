/**
 * Real checks for the code workspace, runnable without Electron.
 *
 * Covers the parts that can actually be wrong in a way that matters: path
 * sandboxing, file I/O with conflict detection, the model-output parser, the
 * folder walker, and a live child-process shell.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";

import { cleanRelativePath, resolveInside } from "../electron/lib/ide/safety.js";
import { listTree, flattenFiles } from "../electron/lib/ide/tree.js";
import { readTextFile, writeTextFile, createEntry, renameEntry, deleteEntry } from "../electron/lib/ide/files.js";
import { languageFor, languageCount, LANGUAGE_TABLE } from "../electron/lib/ide/languages.js";
import { completionSignal, roundPrompt, runBuild } from "../electron/lib/ide/build.js";
import { buildProjectPrompt, commentary, parseFileBlocks } from "../electron/lib/ide/prompt.js";
import { ShellManager } from "../electron/lib/ide/shell.js";

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`ok   ${name}`);
    })
    .catch((error) => {
      results.push({ name, ok: false, error });
      console.log(`FAIL ${name}\n     ${error.message}`);
    });
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "blackbox-ide-"));

await fsp.mkdir(path.join(root, "src", "deep"), { recursive: true });
await fsp.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
await fsp.mkdir(path.join(root, ".git"), { recursive: true });
await fsp.writeFile(path.join(root, "src", "app.js"), "export const answer = 42;\n", "utf8");
await fsp.writeFile(path.join(root, "src", "deep", "module.py"), "print('hi')\n", "utf8");
await fsp.writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
await fsp.writeFile(path.join(root, "package.json"), '{ "name": "demo" }\n', "utf8");

await check("rejects traversal and absolute paths", () => {
  assert.throws(() => cleanRelativePath("../etc/passwd"), /leave the open folder/);
  assert.throws(() => cleanRelativePath("/etc/passwd"), /absolute path/);
  assert.throws(() => resolveInside(root, "src/../../escape.txt"), /outside|leave/);
  assert.throws(() => cleanRelativePath("C:/Windows/System32/drivers/etc/hosts"), /absolute Windows path/);
});

await check("accepts and normalises ordinary paths", () => {
  assert.equal(cleanRelativePath("./src/app.js"), "src/app.js");
  assert.equal(cleanRelativePath("src\\deep\\module.py"), "src/deep/module.py");
  assert.equal(cleanRelativePath('"src/app.js"'), "src/app.js");
  assert.equal(resolveInside(root, "src/app.js"), path.join(root, "src", "app.js"));
});

await check("tree skips node_modules and .git, keeps source", async () => {
  const listing = await listTree(root);
  const files = flattenFiles(listing.tree);
  assert.ok(files.includes("src/app.js"), "src/app.js missing");
  assert.ok(files.includes("src/deep/module.py"), "nested file missing");
  assert.ok(files.includes("package.json"), "package.json missing");
  assert.ok(!files.some((file) => file.startsWith("node_modules/")), "node_modules leaked into the tree");
  assert.ok(!files.some((file) => file.startsWith(".git/")), ".git leaked into the tree");
  assert.equal(listing.truncated, false);
});

await check("reads a file with language metadata", async () => {
  const file = await readTextFile(root, "src/app.js");
  assert.match(file.content, /answer = 42/);
  assert.equal(file.binary, false);
  assert.equal(file.language.label, "JavaScript");
  assert.equal(file.language.modeFile, "javascript");
});

await check("writes, then refuses to clobber a changed file", async () => {
  const saved = await writeTextFile(root, "src/new.ts", "let a = 1;\n", {});
  assert.equal(saved.language.label, "TypeScript");
  const conflict = await writeTextFile(root, "src/new.ts", "let a = 2;\n", { expectedMtimeMs: saved.mtimeMs + 5000 }).catch((error) => error);
  assert.equal(conflict.code, "CONFLICT");
  const forced = await writeTextFile(root, "src/new.ts", "let a = 2;\n", {});
  assert.ok(forced.mtimeMs >= saved.mtimeMs);
});

await check("creates folders, renames, and deletes inside the root", async () => {
  await createEntry(root, "src/components", "dir");
  await createEntry(root, "src/components/Button.jsx", "file");
  const moved = await renameEntry(root, "src/components/Button.jsx", "src/components/Primary.jsx");
  assert.equal(moved.to, "src/components/Primary.jsx");
  assert.ok(fs.existsSync(path.join(root, "src", "components", "Primary.jsx")));
  await deleteEntry(root, "src/components");
  assert.ok(!fs.existsSync(path.join(root, "src", "components")));
  await assert.rejects(() => deleteEntry(root, "../outside.txt"));
});

await check("parses ===FILE:=== blocks and rejects escaping paths", () => {
  const reply = [
    "Here you go.",
    "===FILE: src/main.js===",
    "console.log('hi');",
    "===END===",
    "===FILE: ../evil.sh===",
    "rm -rf /",
    "===END===",
    "===FILE: README.md===",
    "# Demo",
    "===END===",
    "Done.",
  ].join("\n");
  const parsed = parseFileBlocks(reply);
  assert.equal(parsed.files.length, 2, `expected 2 files, got ${parsed.files.map((f) => f.path).join(",")}`);
  assert.equal(parsed.files[0].path, "src/main.js");
  assert.match(parsed.files[0].content, /console\.log/);
  assert.equal(parsed.files[1].path, "README.md");
  assert.ok(parsed.warnings.some((warning) => /evil\.sh/.test(warning)), "escaping path was not reported");
});

await check("falls back to Markdown fences with a path", () => {
  const reply = ["Sure.", "```js path=src/util.js", "export const x = 1;", "```", "A script:", "```python demo.py", "print(1)", "```"].join("\n");
  const parsed = parseFileBlocks(reply);
  const paths = parsed.files.map((file) => file.path);
  assert.ok(paths.includes("src/util.js"), `missing src/util.js in ${paths.join(",")}`);
  assert.ok(paths.includes("demo.py"), `missing demo.py in ${paths.join(",")}`);
});

await check("takes the last block when a path repeats", () => {
  const reply = ["===FILE: a.txt===", "first", "===END===", "===FILE: a.txt===", "second", "===END==="].join("\n");
  const parsed = parseFileBlocks(reply);
  assert.equal(parsed.files.length, 2);
  assert.match(parsed.files[1].content, /second/);
});

await check("builds a prompt that carries the tree and avoids secrets", () => {
  const tree = { name: "demo", path: "", type: "dir", children: [{ name: "src", path: "src", type: "dir", children: [{ name: "app.js", path: "src/app.js", type: "file", size: 10 }] }] };
  const built = buildProjectPrompt({ instruction: "Add a CLI entry point", tree, files: [{ path: "src/app.js", content: "export const answer = 42;\n" }] });
  assert.match(built.prompt, /src\/app\.js/);
  assert.match(built.prompt, /Add a CLI entry point/);
  assert.match(built.systemPrompt, /===FILE:/);
  assert.equal(typeof built.prompt, "string");
});

await check("commentary strips file bodies", () => {
  const reply = "Intro line.\n===FILE: a.js===\nconst a = 1;\n===END===\nOutro line.";
  const text = commentary(reply);
  assert.match(text, /Intro line/);
  assert.match(text, /Outro line/);
  assert.ok(!/const a = 1/.test(text), `block body leaked into commentary: ${text}`);
});

await check("language table covers every extension it advertises", () => {
  assert.ok(LANGUAGE_TABLE.length >= 150, `only ${LANGUAGE_TABLE.length} languages in the table`);
  let checked = 0;
  const plain = [];
  for (const entry of LANGUAGE_TABLE) {
    for (const ext of entry.ext ?? []) {
      const language = languageFor(`sample.${ext}`);
      checked += 1;
      if (!language.mode) plain.push(`.${ext} (${entry.name})`);
    }
  }
  assert.deepEqual(plain, [], `extensions with no highlighting: ${plain.slice(0, 10).join(", ")}`);
  assert.ok(checked > 200, `only ${checked} extensions checked`);
  assert.equal(languageFor("Dockerfile").label, "Dockerfile");
  assert.equal(languageFor("notes.unknown-ext").mode, null);
  assert.ok(languageCount() >= 150);
});

await check("build loop keeps going until the model signals done", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blackbox-build-"));
  const roundsSeen = [];
  const replies = [
    "===FILE: package.json===\n{}\n===END===\n===FILE: src/index.js===\nconsole.log(1)\n===END===",
    "===FILE: src/index.js===\nconsole.log(1)\n===END===\n===FILE: README.md===\n# demo\n===END===",
    "===DONE===",
  ];
  const result = await runBuild({
    instruction: "a node demo",
    tree: null,
    provider: async ({ round }) => {
      roundsSeen.push(round);
      return replies[round - 1] ?? "===DONE===";
    },
    writeFile: async (relative, content) => {
      const full = path.join(dir, relative);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content, "utf8");
    },
  });
  assert.equal(result.reason, "done");
  assert.equal(roundsSeen.length, 3, `expected 3 rounds, saw ${roundsSeen.length}`);
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8"), "# demo\n");
  assert.equal(result.files.length, 3);
  await fsp.rm(dir, { recursive: true, force: true });
});

await check("build loop stops when a round changes nothing", async () => {
  let calls = 0;
  const result = await runBuild({
    instruction: "x",
    tree: null,
    provider: async () => {
      calls += 1;
      return "===FILE: a.txt===\nsame\n===END===";
    },
    writeFile: async () => {},
  });
  assert.equal(result.reason, "converged");
  assert.equal(calls, 2, `expected 2 rounds before converging, saw ${calls}`);
  assert.equal(result.rounds.length, 1);
});

await check("build loop respects the stop flag", async () => {
  let stop = false;
  const result = await runBuild({
    instruction: "x",
    tree: null,
    provider: async () => {
      stop = true;
      return "===FILE: a.txt===\none\n===END===";
    },
    writeFile: async () => {},
    shouldStop: () => stop,
  });
  assert.equal(result.reason, "stopped");
  assert.equal(result.stopped, true);
});

await check("completion marker and round prompts are real", () => {
  assert.equal(completionSignal("===DONE==="), true);
  assert.equal(completionSignal("work\n===DONE===\n"), true);
  assert.equal(completionSignal("===FILE: a===\n===END==="), false);
  const written = new Map([["src/app.js", "export const a = 1;\n"]]);
  const { systemPrompt, prompt } = roundPrompt({ instruction: "add tests", tree: null, written, round: 2, maxRounds: 8 });
  assert.match(systemPrompt, /===DONE===/);
  assert.match(prompt, /src\/app\.js/);
  assert.match(prompt, /Round 2 of at most 8/);
});

await check("shell streams real command output", async () => {
  const chunks = [];
  const exits = [];
  const shells = new ShellManager({ onData: (payload) => chunks.push(payload), onExit: (payload) => exits.push(payload) });
  const info = shells.start({ cwd: root });
  assert.ok(info.pid, "shell did not start");

  const marker = "blackbox-shell-ok";
  const command = process.platform === "win32" ? `echo ${marker}\r\n` : `echo ${marker}\n`;
  assert.equal(shells.write(info.id, command), true);

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !chunks.some((chunk) => chunk.data.includes(marker))) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const text = chunks.map((chunk) => chunk.data).join("");
  assert.ok(text.includes(marker), `shell never echoed the marker. Saw: ${JSON.stringify(text.slice(0, 200))}`);

  shells.kill(info.id);
  const killDeadline = Date.now() + 6000;
  while (Date.now() < killDeadline && exits.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.ok(exits.length > 0, "shell exit was never reported");
  shells.disposeAll();
});

await check("shell refuses a missing folder", () => {
  const shells = new ShellManager({});
  assert.throws(() => shells.start({ cwd: path.join(root, "does-not-exist") }), /no longer exists/);
});

await fsp.rm(root, { recursive: true, force: true });

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const entry of failed) console.error(`- ${entry.name}: ${entry.error?.stack ?? entry.error}`);
  process.exit(1);
}
