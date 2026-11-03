/**
 * Fetch the Windows llama.cpp runtime into node_modules for cross-building the
 * installer from Linux or macOS.
 *
 *   node scripts/prepare-win.mjs                 # CPU runtime (default)
 *   node scripts/prepare-win.mjs --gpu vulkan    # add the Vulkan runtime
 *   node scripts/prepare-win.mjs --gpu cuda      # add the CUDA runtimes
 *
 * This deliberately does NOT use `npm install --os=win32`: that prunes the host
 * platform's optional dependencies. It downloads the published tarball for the
 * Windows package at the exact version node-llama-cpp expects and unpacks it.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const gpuIndex = args.indexOf("--gpu");
const gpu = gpuIndex !== -1 ? String(args[gpuIndex + 1] || "").toLowerCase() : null;

const packages = ["@node-llama-cpp/win-x64"];
if (gpu === "vulkan") packages.push("@node-llama-cpp/win-x64-vulkan");
if (gpu === "cuda") packages.push("@node-llama-cpp/win-x64-cuda", "@node-llama-cpp/win-x64-cuda-ext");
if (gpu && !["vulkan", "cuda"].includes(gpu)) {
  console.error(`Unknown --gpu value "${gpu}". Use vulkan or cuda.`);
  process.exit(1);
}

const projectRoot = process.cwd();
const nodeLlamaManifest = path.join(projectRoot, "node_modules", "node-llama-cpp", "package.json");
if (!fs.existsSync(nodeLlamaManifest)) {
  console.error("node-llama-cpp is not installed. Run `npm install` first.");
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(nodeLlamaManifest, "utf8")).version;
const targetRoot = path.join(projectRoot, "node_modules", "@node-llama-cpp");

function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeField = header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField || "0", 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;

    const isDirectory = type === "5" || fullName.endsWith("/");
    if (type === "0" || type === "\0" || type === "7" || type === "5") {
      entries.push({
        name: fullName,
        type: isDirectory ? "directory" : "file",
        data: buffer.subarray(dataStart, dataStart + size),
      });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function fetchPackage(name) {
  const short = name.split("/")[1];
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}/-/${short}-${version}.tgz`;
  const response = await fetch(url, { headers: { "User-Agent": "Blackbox/1.0 (build script)" } });
  if (!response.ok) {
    throw new Error(`${name}@${version} is not on the registry (HTTP ${response.status}).`);
  }
  const archive = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));
  const entries = parseTar(archive);

  const destination = path.join(targetRoot, short);
  fs.rmSync(destination, { recursive: true, force: true });
  for (const entry of entries) {
    const relative = entry.name.replace(/^package\//, "");
    if (!relative) continue;
    const full = path.join(destination, relative);
    if (entry.type === "directory") {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, entry.data);
    }
  }

  const bins = path.join(destination, "bins", "win-x64");
  const files = fs.existsSync(bins) ? fs.readdirSync(bins) : [];
  if (files.length === 0) {
    throw new Error(`${name} unpacked without a bins/win-x64 directory.`);
  }
  const bytes = files.reduce((total, file) => total + fs.statSync(path.join(bins, file)).size, 0);
  console.log(`  ${name}@${version} -> ${files.length} files, ${(bytes / 1024 / 1024).toFixed(0)} MB`);
}

console.log(`Preparing Windows runtime for node-llama-cpp ${version}`);
for (const name of packages) {
  await fetchPackage(name);
}
console.log("Windows runtime ready. Package with `npm run dist`.");
