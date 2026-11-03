/**
 * Preflight: verifies the llama.cpp runtime before the app is started.
 * Run with `npm run preflight` after a fresh install (and once on a Windows build machine,
 * so the Windows CPU binaries are present before packaging).
 */

import { getLlama, getLlamaGpuTypes } from "node-llama-cpp";
import os from "node:os";

const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);

console.log("Blackbox preflight");
console.log(`  platform   ${process.platform} ${process.arch}`);
console.log(`  node       ${process.version}`);
console.log(`  cpu        ${os.cpus()[0]?.model?.trim() ?? "unknown"} (${os.cpus().length} threads)`);
console.log(`  memory     ${totalGb} GB`);

try {
  const gpuTypes = await getLlamaGpuTypes();
  console.log(`  gpu types  ${gpuTypes.length ? gpuTypes.join(", ") : "none (CPU only)"}`);
} catch (error) {
  console.log(`  gpu types  detection failed: ${error.message}`);
}

const llama = await getLlama({ gpu: "auto", logLevel: "error", progressLogs: true });
console.log(`  backend    ${llama.gpu ? llama.gpu + " acceleration" : "CPU"}`);
console.log(`  build type ${llama.buildType ?? "prebuilt"}`);
console.log("  ready      llama.cpp loaded successfully");
await llama.dispose();
