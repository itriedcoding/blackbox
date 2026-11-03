/**
 * Shared harness that loads the vendored CodeMirror mode packages the way the
 * browser would, inside a VM, so both the table generator and the verifier work
 * from what the files actually register instead of what metadata claims.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

function fakeCodeMirror({ mimes, modes }) {
  return {
    modeInfo: [],
    mimeModes: {},
    modes: {},
    modeExtensions: {},
    helpers: {},
    commands: {},
    keyMap: {},
    defineMode(name, factory) {
      if (!name) throw new Error("defineMode called without a name");
      if (typeof factory !== "function") throw new Error(`defineMode(${name}) got a non-function`);
      modes.add(name);
    },
    defineMIME(mime, spec) {
      if (!mime || mime === "null") return;
      mimes.add(String(mime));
      if (typeof spec === "string") modes.add(spec);
    },
    registerHelper() {},
    registerGlobalHelper() {},
    defineOption() {},
    defineExtension() {},
    normalizeKeyMap() {},
    StringStream: class StringStream {},
    Pos: class Pos {},
    resolveMode() {
      return {};
    },
  };
}

/**
 * Runs `preamble` files (the simple-mode addon) once and then each mode file,
 * attributing registrations to the file that made them.
 */
export function loadModes({ modeDir, files, preamble = [] }) {
  const mimes = new Set();
  const modes = new Set();
  const byFile = new Map();
  const errors = [];

  const CodeMirror = fakeCodeMirror({ mimes, modes });
  const sandbox = { CodeMirror, window: { CodeMirror }, navigator: { userAgent: "" }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const run = (file, fullPath) => {
    const before = { mimes: new Set(mimes), modes: new Set(modes) };
    try {
      vm.runInContext(fs.readFileSync(fullPath, "utf8"), sandbox, { filename: file, timeout: 5000 });
    } catch (error) {
      errors.push({ file, message: error.message });
    }
    byFile.set(file, {
      mimes: [...mimes].filter((mime) => !before.mimes.has(mime)),
      modes: [...modes].filter((mode) => !before.modes.has(mode)),
    });
  };

  for (const file of preamble) run(path.basename(file), file);
  for (const file of files) run(file, path.join(modeDir, file));

  return { mimes, modes, byFile, errors };
}
