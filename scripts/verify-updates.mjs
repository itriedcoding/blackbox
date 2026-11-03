/**
 * Exercises the update client: version comparison, manifest validation, and a
 * full download against a local HTTP server, including the failure paths that
 * decide whether an installer is allowed to run.
 *
 * The server here stands in for GitHub's release CDN, but the bytes, the
 * streaming, the hashing and the rejection logic are the shipping code.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  isNewer,
  normalizeManifest,
  parseVersion,
  sha256File,
} from "../electron/lib/updates.js";

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const installer = Buffer.from("MZ fake installer payload for the update test");
const installerSha = createHash("sha256").update(installer).digest("hex");
const manifest = { version: "9.9.9", asset: "Blackbox-9.9.9-win-x64.exe", size: installer.length, sha256: installerSha };

const serverState = {
  manifest: { ...manifest },
  body: installer,
  manifestBom: true,
  downloadStatus: 200,
  // When set, the first installer request is cut off half way through so the
  // client has to resume rather than start again.
  dropFirstTransfer: false,
  rangeRequests: [],
};

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/latest.json")) {
    const json = JSON.stringify(serverState.manifest);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(serverState.manifestBom ? `\uFEFF${json}` : json);
    return;
  }
  if (req.url.startsWith("/installer.exe")) {
    if (serverState.downloadStatus !== 200) {
      res.writeHead(serverState.downloadStatus);
      res.end("nope");
      return;
    }
    const range = req.headers.range;
    if (range) serverState.rangeRequests.push(range);
    const body = serverState.body;
    const match = range ? /^bytes=(\d+)-/.exec(range) : null;
    const start = match ? Number(match[1]) : 0;
    if (start >= body.length) {
      res.writeHead(416, { "Content-Range": `bytes */${body.length}` });
      res.end();
      return;
    }
    const slice = body.subarray(start);
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(slice.length),
      "Accept-Ranges": "bytes",
    };
    if (match) headers["Content-Range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
    res.writeHead(match ? 206 : 200, headers);
    if (serverState.dropFirstTransfer) {
      // Deliver half, then kill the socket the way a dropped Wi-Fi link does.
      serverState.dropFirstTransfer = false;
      res.write(slice.subarray(0, Math.max(1, Math.floor(slice.length / 2))));
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.end(slice);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blackbox-update-test-"));

try {
  await check("parseVersion accepts releases and prereleases, rejects junk", () => {
    assertEqual(parseVersion("1.7.0")?.patch, 0, "patch");
    assertEqual(parseVersion("v1.7.0")?.minor, 7, "v prefix");
    assertEqual(parseVersion("1.7.0-beta.2")?.prerelease, "beta.2", "prerelease");
    assert(parseVersion("1.7") === null, "1.7 must be rejected");
    assert(parseVersion("") === null, "empty must be rejected");
  });

  await check("compareVersions orders numeric parts, not strings", () => {
    assert(compareVersions("1.10.0", "1.9.0") > 0, "1.10.0 must beat 1.9.0");
    assert(compareVersions("1.7.0", "1.7.0") === 0, "equal versions");
    assert(compareVersions("1.7.0", "1.7.0-beta.1") > 0, "a release beats its prerelease");
    assert(compareVersions("1.7.0-beta.2", "1.7.0-beta.10") < 0, "beta.10 beats beta.2");
  });

  await check("isNewer only upgrades forwards", () => {
    assert(isNewer("1.7.0", "1.6.0"), "1.7.0 is newer than 1.6.0");
    assert(!isNewer("1.6.0", "1.6.0"), "same version is not newer");
    assert(!isNewer("1.5.9", "1.6.0"), "older is not newer");
  });

  await check("normalizeManifest rejects installers it cannot verify", () => {
    const bad = [
      { ...manifest, sha256: "abc" },
      { ...manifest, sha256: undefined },
      { ...manifest, size: 0 },
      { ...manifest, size: "big" },
      { ...manifest, asset: "../../evil.exe" },
      { ...manifest, asset: "Blackbox.zip" },
      { ...manifest, version: "soon" },
      null,
    ];
    for (const candidate of bad) {
      let threw = false;
      try {
        normalizeManifest(candidate);
      } catch {
        threw = true;
      }
      assert(threw, `expected rejection for ${JSON.stringify(candidate)}`);
    }
    const good = normalizeManifest({ ...manifest, sha256: installerSha.toUpperCase() });
    assertEqual(good.sha256, installerSha, "hash is normalised to lowercase");
    assertEqual(good.version, "9.9.9", "version");
  });

  await check("checkForUpdate reads a BOM-prefixed manifest and reports an upgrade", async () => {
    const result = await checkForUpdate({ currentVersion: "1.6.0", manifestUrl: `${base}/latest.json` });
    assertEqual(result.available, true, "available");
    assertEqual(result.latest, "9.9.9", "latest");
    assertEqual(result.manifest.size, installer.length, "size");
  });

  await check("checkForUpdate reports no upgrade when already current", async () => {
    const result = await checkForUpdate({ currentVersion: "9.9.9", manifestUrl: `${base}/latest.json` });
    assertEqual(result.available, false, "available");
    assertEqual(result.reason, "current", "reason");
  });

  await check("a missing manifest is not an error (older releases)", async () => {
    const result = await checkForUpdate({ currentVersion: "1.0.0", manifestUrl: `${base}/nothing-here.json` });
    assertEqual(result.available, false, "available");
    assertEqual(result.reason, "no-manifest", "reason");
  });

  await check("a broken manifest is reported, not guessed around", async () => {
    const saved = { ...serverState.manifest };
    serverState.manifest = { ...manifest, sha256: "not-a-hash" };
    let message = "";
    try {
      await checkForUpdate({ currentVersion: "1.0.0", manifestUrl: `${base}/latest.json` });
    } catch (error) {
      message = error.message;
    }
    serverState.manifest = saved;
    assert(/SHA-256/.test(message), `unexpected: ${message}`);
  });

  await check("downloadUpdate verifies and keeps a matching installer", async () => {
    const destination = path.join(tmpDir, "Blackbox-update-9.9.9.exe");
    const progress = [];
    const result = await downloadUpdate({
      manifest,
      destination,
      url: `${base}/installer.exe`,
      onProgress: (payload) => progress.push(payload),
    });
    assertEqual(result.sha256, installerSha, "digest");
    assertEqual(fs.readFileSync(destination).toString(), installer.toString(), "bytes on disk");
    assert(progress.length > 0, "progress was not reported");
    assert(progress.at(-1).percent === 100, "final progress should be 100");
  });

  await check("a dropped transfer resumes from the partial file", async () => {
    const destination = path.join(tmpDir, "resumed.exe");
    serverState.rangeRequests = [];
    serverState.dropFirstTransfer = true;
    const result = await downloadUpdate({
      manifest,
      destination,
      url: `${base}/installer.exe`,
    });
    assertEqual(result.sha256, installerSha, "digest after resume");
    assertEqual(fs.readFileSync(destination).toString(), installer.toString(), "bytes after resume");
    assert(serverState.rangeRequests.length > 0, "the retry must ask for the remaining bytes with a Range header");
    assert(/^bytes=\d+-$/.test(serverState.rangeRequests[0]), `unexpected range: ${serverState.rangeRequests[0]}`);
    assert(!fs.existsSync(`${destination}.part`), "the partial file must be gone once the download completes");
  });

  await check("a server that ignores Range still produces the right file", async () => {
    const destination = path.join(tmpDir, "ignored-range.exe");
    fs.writeFileSync(`${destination}.part`, installer.subarray(0, 10));
    const result = await downloadUpdate({
      manifest,
      destination,
      url: `${base}/installer.exe?no-range=1`,
      fetchImpl: (target, options) => {
        const headers = { ...(options.headers ?? {}) };
        delete headers.Range;
        return fetch(target, { ...options, headers });
      },
    });
    assertEqual(result.sha256, installerSha, "digest");
    assertEqual(fs.readFileSync(destination).toString(), installer.toString(), "no duplicated prefix");
  });

  await check("a wrong hash is deleted, never returned", async () => {
    const destination = path.join(tmpDir, "bad-hash.exe");
    let message = "";
    try {
      await downloadUpdate({
        manifest: { ...manifest, sha256: "0".repeat(64) },
        destination,
        url: `${base}/installer.exe`,
      });
    } catch (error) {
      message = error.message;
    }
    assert(/SHA-256/.test(message), `unexpected: ${message}`);
    assert(!fs.existsSync(destination), "the rejected file must be removed");
  });

  await check("a short body fails the size check and is removed", async () => {
    const saved = serverState.body;
    serverState.body = installer.subarray(0, 5);
    const destination = path.join(tmpDir, "short.exe");
    let message = "";
    try {
      await downloadUpdate({
        manifest,
        destination,
        url: `${base}/installer.exe`,
      });
    } catch (error) {
      message = error.message;
    }
    serverState.body = saved;
    assert(/bytes but the release says/.test(message), `unexpected: ${message}`);
    assert(!fs.existsSync(destination), "the truncated file must be removed");
  });

  await check("an HTTP error surfaces instead of writing a file", async () => {
    serverState.downloadStatus = 500;
    const destination = path.join(tmpDir, "http-error.exe");
    let message = "";
    try {
      await downloadUpdate({
        manifest,
        destination,
        url: `${base}/installer.exe`,
      });
    } catch (error) {
      message = error.message;
    }
    serverState.downloadStatus = 200;
    assert(/HTTP 500/.test(message), `unexpected: ${message}`);
    assert(!fs.existsSync(destination), "no file should be written");
  });

  await check("sha256File matches the digest the manifest carries", async () => {
    const file = path.join(tmpDir, "hash-me.bin");
    fs.writeFileSync(file, installer);
    assertEqual(await sha256File(file), installerSha, "file digest");
  });
} finally {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failures.length} update checks passed`);
if (failures.length) {
  console.error("failures:", failures.map((failure) => failure.name));
  process.exitCode = 1;
}
