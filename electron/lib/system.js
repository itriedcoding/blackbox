import os from "node:os";

export function systemInfo() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() ?? "Unknown CPU",
    cores: cpus.length,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    defaultThreads: defaultThreads(),
    versions: {
      app: process.env.npm_package_version ?? "1.0.0",
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      chrome: process.versions.chrome ?? null,
    },
  };
}

export function defaultThreads() {
  const cores = os.cpus().length || 4;
  // Leave one core for the UI and the OS; cap at 8 because small models do not scale further.
  return Math.max(2, Math.min(8, cores - 1));
}

/** Physical threads recommended for a given model size bucket. */
export function threadOptions() {
  const cores = os.cpus().length || 4;
  const options = new Set([2, 4, 6, 8]);
  if (cores - 1 >= 2) options.add(Math.min(16, cores - 1));
  if (cores >= 2) options.add(Math.min(16, cores));
  return [...options].sort((a, b) => a - b);
}
