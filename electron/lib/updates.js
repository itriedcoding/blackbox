/**
 * In-app updates from GitHub Releases.
 *
 * The release workflow publishes a small `latest.json` next to the installer:
 *
 *   https://github.com/<owner>/<repo>/releases/latest/download/latest.json
 *
 * That URL always points at the newest release, so the app needs no GitHub API
 * token and no API rate limit. The manifest names the installer, its exact byte
 * size and its SHA-256; the download is refused unless both match, so a partial
 * transfer or a swapped file cannot be executed.
 *
 * Everything here is plain Node and takes its fetch/URLs as parameters, which is
 * what lets the whole path be exercised against a local server.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const UPDATE_REPO = { owner: "itriedcoding", repo: "locally-uncensored-ai" };

const REQUEST_TIMEOUT_MS = 20_000;

export function releaseBase(repo = UPDATE_REPO) {
  return `https://github.com/${repo.owner}/${repo.repo}/releases`;
}

export function defaultManifestUrl(repo = UPDATE_REPO) {
  return `${releaseBase(repo)}/latest/download/latest.json`;
}

export function installerUrl(manifest, repo = UPDATE_REPO) {
  return `${releaseBase(repo)}/download/v${manifest.version}/${encodeURIComponent(manifest.asset)}`;
}

/** "1.7.0" or "1.7.0-beta.1" -> comparable parts. */
export function parseVersion(value) {
  const match = String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Negative when a < b, positive when a > b, 0 when equal. A release version
 * sorts above any prerelease of the same number, as semver requires.
 */
export function compareVersions(a, b) {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  if (!left || !right) throw new Error(`Cannot compare versions: ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease.localeCompare(right.prerelease, "en", { numeric: true });
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/** Rejects anything the updater could not safely install. */
export function normalizeManifest(raw) {
  if (!raw || typeof raw !== "object") throw new Error("The update manifest is not an object.");
  const version = String(raw.version ?? "").trim().replace(/^v/i, "");
  if (!parseVersion(version)) throw new Error(`The update manifest has an unusable version: ${JSON.stringify(raw.version)}`);

  const asset = String(raw.asset ?? "").trim();
  if (!/^[A-Za-z0-9._-]+\.exe$/i.test(asset)) throw new Error(`The update manifest names an unusable installer: ${JSON.stringify(raw.asset)}`);

  if (!/^[a-f0-9]{64}$/i.test(String(raw.sha256 ?? ""))) throw new Error("The update manifest has no valid SHA-256.");
  const size = Number(raw.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error("The update manifest has no usable size.");

  return {
    version,
    asset,
    sha256: String(raw.sha256).toLowerCase(),
    size,
    publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : null,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 4000) : null,
  };
}

/**
 * Reads the newest published manifest and decides whether it is an upgrade.
 * A missing manifest (older releases, or a brand-new repo) is not an error.
 */
export async function checkForUpdate({
  currentVersion,
  repo = UPDATE_REPO,
  manifestUrl = defaultManifestUrl(repo),
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${manifestUrl}${manifestUrl.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      redirect: "follow",
      headers: { Accept: "application/json", "User-Agent": "Blackbox-updater" },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return { available: false, current: currentVersion, latest: null, manifest: null, reason: "no-manifest" };
    }
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for the update manifest.`);

    const text = String(await response.text()).replace(/^\uFEFF/, "");
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("The update manifest is not valid JSON.");
    }
    const manifest = normalizeManifest(raw);
    return {
      available: isNewer(manifest.version, currentVersion),
      current: currentVersion,
      latest: manifest.version,
      manifest,
      reason: isNewer(manifest.version, currentVersion) ? "newer" : "current",
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The update check timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sizeOnDisk(file) {
  try {
    return (await fs.promises.stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Streams the installer to a `.part` file, hashing as it goes, and resumes from
 * whatever already arrived when a connection drops instead of starting the
 * whole download over. The file only moves into place once the size and SHA-256
 * match the manifest; anything else is deleted, so a half transfer can never be
 * run.
 */
export async function downloadUpdate({
  manifest,
  destination,
  url,
  repo = UPDATE_REPO,
  onProgress = () => {},
  signal,
  fetchImpl = fetch,
  attempts = MAX_ATTEMPTS,
} = {}) {
  const verified = normalizeManifest(manifest);
  // A URL may be supplied by the caller (mirrors, tests); otherwise it is built
  // from the manifest's version and asset name. A URL inside the manifest is
  // never trusted, because normalizeManifest drops everything it does not check.
  const target = url ?? installerUrl(verified, repo);
  const part = `${destination}.part`;
  const cancelled = () => new Error("The download was cancelled.");

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.rm(part, { force: true });

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw cancelled();

    let resumeFrom = await sizeOnDisk(part);
    if (resumeFrom >= verified.size) {
      // Something the full size is already sitting there; never trust it.
      await fs.promises.rm(part, { force: true });
      resumeFrom = 0;
    }

    const headers = { "User-Agent": "Blackbox-updater" };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    let response;
    try {
      response = await fetchImpl(target, { redirect: "follow", headers, signal });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      lastError = error;
      if (attempt === attempts) break;
      await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }

    if (!response.ok) {
      // 416 means the partial file does not line up with this asset; drop it and
      // let the next attempt start from zero.
      if (response.status === 416 && resumeFrom > 0) {
        await fs.promises.rm(part, { force: true });
        lastError = new Error("The server rejected the resume offset.");
        if (attempt === attempts) break;
        continue;
      }
      throw new Error(`The installer download failed with HTTP ${response.status}.`);
    }
    if (!response.body) throw new Error("The installer download returned no body.");

    // A server that ignores the range sends the whole file; appending it to the
    // bytes already on disk would corrupt the result, so start over instead.
    const resumed = response.status === 206 && resumeFrom > 0;
    if (resumeFrom > 0 && !resumed) {
      await fs.promises.rm(part, { force: true });
      resumeFrom = 0;
    }

    const hash = createHash("sha256");
    if (resumed) {
      for await (const chunk of fs.createReadStream(part)) hash.update(chunk);
    }

    let received = resumeFrom;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        hash.update(chunk);
        onProgress({
          received,
          total: verified.size,
          percent: verified.size > 0 ? Math.min(100, (received / verified.size) * 100) : null,
        });
        callback(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(part, { flags: "a" }));
    } catch (error) {
      if (signal?.aborted) {
        await fs.promises.rm(part, { force: true });
        throw cancelled();
      }
      lastError = error;
      if (attempt === attempts) break;
      // Keep the partial file so the next attempt only asks for the remainder.
      await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }

    const digest = hash.digest("hex");
    if (received !== verified.size) {
      await fs.promises.rm(part, { force: true });
      throw new Error(`The download is ${received} bytes but the release says ${verified.size}. Try again.`);
    }
    if (digest !== verified.sha256) {
      await fs.promises.rm(part, { force: true });
      throw new Error("The installer did not match the published SHA-256, so it was deleted. Try again, or download it from the release page.");
    }

    // Windows refuses to rename onto an existing file, so clear the target first.
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(part, destination);
    onProgress({ received, total: verified.size, percent: 100 });
    return { path: destination, bytes: received, sha256: digest };
  }

  await fs.promises.rm(part, { force: true });
  throw new Error(`The download failed after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`);
}
