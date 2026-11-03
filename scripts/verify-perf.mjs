#!/usr/bin/env node
/**
 * Checks the RAM optimizer without Electron: thread sizing, context fitting
 * against the budget, the model's own context ceiling, the no-model default and
 * the change list the UI reports. Runs on any machine.
 */

import assert from "node:assert/strict";
import {
  HEADROOM,
  recommendSettings,
  recommendThreads,
  describeChanges,
} from "../electron/lib/optimize.js";

const GB = 1_000_000_000;
const MB = 1_000_000;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

console.log("performance optimizer checks");

await check("threads leave one core for the UI and never exceed eight", () => {
  assert.equal(recommendThreads(1), 2);
  assert.equal(recommendThreads(4), 3);
  assert.equal(recommendThreads(8), 7);
  assert.equal(recommendThreads(16), 8);
  assert.equal(recommendThreads(64), 8);
  assert.equal(recommendThreads(0), 3, "missing core count falls back to four cores");
});

await check("a small model on a roomy machine gets the largest window", () => {
  const rec = recommendSettings({
    budget: 6 * GB,
    fileSize: 2 * GB,
    fileInfo: { kvBytesPerToken: 128_000, contextLength: 32768 },
    cores: 8,
    gpuDetected: false,
  });
  assert.equal(rec.contextSize, 8192);
  assert.equal(rec.threads, 7);
  assert.equal(rec.gpu, "cpu");
  assert.equal(rec.fits, true);
  assert.ok(rec.estimate <= 6 * GB * HEADROOM, `estimate ${rec.estimate} must stay inside the usable budget`);
});

await check("a big model is stepped down until it fits", () => {
  const rec = recommendSettings({
    budget: 4 * GB,
    fileSize: 2.5 * GB,
    fileInfo: { kvBytesPerToken: 128_000, contextLength: 32768 },
    cores: 6,
  });
  assert.equal(rec.contextSize, 4096, "8192 does not fit, 4096 does");
  assert.equal(rec.fits, true);
  assert.ok(rec.headroomBytes > 0);
});

await check("a model that cannot fit even at 1024 is reported, not hidden", () => {
  const rec = recommendSettings({
    budget: 2 * GB,
    fileSize: 1.9 * GB,
    fileInfo: { kvBytesPerToken: 128_000, contextLength: 32768 },
    cores: 4,
  });
  assert.equal(rec.contextSize, 1024);
  assert.equal(rec.fits, false);
  assert.match(rec.reason, /more than the/);
});

await check("the window never exceeds the model's trained context", () => {
  const rec = recommendSettings({
    budget: 64 * GB,
    fileSize: 1 * GB,
    fileInfo: { kvBytesPerToken: 128_000, contextLength: 2048 },
    cores: 16,
  });
  assert.equal(rec.contextSize, 2048);
  assert.equal(rec.nativeContext, 2048);
});

await check("no model chosen falls back to a safe default and says so", () => {
  const rec = recommendSettings({ budget: 5 * GB, fileSize: 0, fileInfo: null, cores: 8 });
  assert.equal(rec.contextSize, 4096);
  assert.equal(rec.fits, true);
  assert.equal(rec.estimate, null);
  assert.equal(rec.threads, 7);
  assert.match(rec.reason, /No model chosen/);
});

await check("a detected GPU is recommended as auto, otherwise CPU only", () => {
  const withGpu = recommendSettings({ budget: 8 * GB, fileSize: 1 * GB, fileInfo: null, cores: 8, gpuDetected: true });
  const without = recommendSettings({ budget: 8 * GB, fileSize: 1 * GB, fileInfo: null, cores: 8 });
  assert.equal(withGpu.gpu, "auto");
  assert.equal(without.gpu, "cpu");
});

await check("the change list names only what actually moved", () => {
  const changes = describeChanges(
    { threads: 4, contextSize: 4096, gpu: "auto" },
    { threads: 7, contextSize: 2048, gpu: "auto" },
  );
  assert.deepEqual(changes, ["threads 4 → 7", "context 4096 → 2048 tokens"]);
  assert.deepEqual(describeChanges({ threads: 7, contextSize: 2048, gpu: "cpu" }, { threads: 7, contextSize: 2048, gpu: "cpu" }), []);
});

await check("weights and KV in the result add up to the estimate", () => {
  const rec = recommendSettings({
    budget: 8 * GB,
    fileSize: 3 * GB,
    fileInfo: { kvBytesPerToken: 200_000, contextLength: 32768 },
    cores: 8,
  });
  assert.equal(rec.weights + rec.kv, rec.estimate);
  assert.ok(rec.kv > 0 && rec.kv < MB * 10_000);
  assert.ok(Number.isInteger(rec.headroomBytes));
});

console.log(`\n${passed}/${passed + failed} performance checks passed`);
process.exit(failed === 0 ? 0 : 1);
