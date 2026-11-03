/**
 * Proves the language coverage is real rather than a list in a README.
 *
 * 1. Every vendored mode package loads without throwing.
 * 2. Every MIME the table offers is registered by a mode that loaded.
 * 3. Every extension the table advertises resolves through languageFor() to a
 *    MIME that actually exists, so highlighting cannot silently do nothing.
 * 4. Filename-only languages (Dockerfile, CMakeLists.txt, Makefile) resolve too.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadModes } from "./lib/codemirror-sandbox.mjs";
import { languageFor, languageCount } from "../electron/lib/ide/languages.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const vendorRoot = path.join(projectRoot, "renderer", "vendor", "codemirror");
const modeDir = path.join(vendorRoot, "mode");
const table = JSON.parse(fs.readFileSync(path.join(vendorRoot, "mode-info.json"), "utf8"));

const modeFiles = fs.readdirSync(modeDir).filter((file) => file.endsWith(".js")).sort();
const { mimes, modes, byFile, errors } = loadModes({
  modeDir,
  files: modeFiles,
  preamble: [path.join(vendorRoot, "addon", "simple.js")],
});

// The editor accepts either a MIME string or a registered mode name here.
const validTargets = new Set([...mimes, ...modes]);
const failures = [];
const loaded = modeFiles.filter((file) => !errors.some((error) => error.file === file));

for (const error of errors) failures.push(`mode failed to load → ${error.file}: ${error.message}`);

for (const entry of table) {
  if (!modeFiles.includes(`${entry.mode}.js`)) failures.push(`no vendored file for mode "${entry.mode}" (${entry.name})`);
  for (const mime of entry.mimes) {
    if (!validTargets.has(mime)) failures.push(`"${mime}" (${entry.name}) is neither a MIME nor a mode any package registered`);
  }
}

let extensionChecks = 0;
for (const entry of table) {
  for (const ext of entry.ext) {
    const language = languageFor(`sample.${ext}`);
    extensionChecks += 1;
    if (!language.mode) {
      failures.push(`.${ext} (${entry.name}) resolved to plain text`);
      continue;
    }
    if (!validTargets.has(language.mode)) {
      failures.push(`.${ext} (${entry.name}) asks for "${language.mode}", which no mode registered`);
    }
  }
}

// A filename pattern needs a filename that actually matches it.
const FILENAME_SAMPLES = {
  Asterisk: "extensions.conf",
  CMake: "CMakeLists.txt",
  Dockerfile: "Dockerfile",
  "GitHub Flavored Markdown": "README.md",
  Groovy: "Jenkinsfile",
  Nginx: "nginx.conf",
  Python: "BUILD",
  Shell: "PKGBUILD",
};

let filenameChecks = 0;
for (const entry of table) {
  if (!entry.file) continue;
  const sample = FILENAME_SAMPLES[entry.name] ?? Object.keys(FILENAME_SAMPLES).map((key) => key)[0];
  const language = languageFor(sample);
  filenameChecks += 1;
  if (!language.mode) failures.push(`filename rule for ${entry.name} resolved "${sample}" to plain text`);
}

const expectedCount = new Set(table.map((entry) => entry.name)).size;
if (languageCount() !== expectedCount) failures.push(`languageCount() reports ${languageCount()}, table has ${expectedCount}`);

console.log(`languages in table: ${table.length}`);
console.log(`mode packages loaded: ${loaded.length}/${modeFiles.length}`);
console.log(`MIME types registered: ${mimes.size} (mode names available: ${modes.size})`);
console.log(`extensions checked: ${extensionChecks}`);
console.log(`filename rules checked: ${filenameChecks}`);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures.slice(0, 30)) console.error(`- ${failure}`);
  if (failures.length > 30) console.error(`… and ${failures.length - 30} more`);
  process.exit(1);
}

console.log("\nevery advertised language resolves to a loaded mode");
