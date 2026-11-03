/**
 * Hugging Face GGUF downloader.
 *
 * - Follows the /resolve/ redirect to the CDN and preserves the Range header.
 * - Writes into a .part file so an interrupted download resumes instead of restarting.
 * - Reports real byte counts and speed; verifies the final size against the Hub's tree API.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveUrl } from "./hf.js";

const CHUNK_FLUSH_MS = 180;

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export function modelFileName(repo, filePath) {
  const repoSlug = repo.replace("/", "--");
  const base = filePath.split("/").pop();
  return `${repoSlug}__${safeSegment(base)}`;
}

export class DownloadManager {
  constructor({ onProgress, onComplete }) {
    this.active = new Map();
    this.onProgress = onProgress ?? (() => {});
    this.onComplete = onComplete ?? (() => {});
  }

  list() {
    return [...this.active.values()].map((job) => ({
      id: job.id,
      repo: job.repo,
      path: job.path,
      filename: job.filename,
      received: job.received,
      total: job.total,
      status: job.status,
      error: job.error ?? null,
    }));
  }

  cancel(id) {
    const job = this.active.get(id);
    if (!job) return false;
    job.cancelled = true;
    job.controller.abort();
    return true;
  }

  async start({ repo, path: filePath, size, token, modelsDir }) {
    if (!repo || !filePath) throw new Error("Missing repository or file");
    const id = `${repo}@${filePath}`;
    const existing = this.active.get(id);
    if (existing && existing.status === "downloading") {
      return { id, status: "downloading", filename: existing.filename };
    }

    const dir = path.join(modelsDir, repo.replace("/", "--"));
    fs.mkdirSync(dir, { recursive: true });

    const filename = modelFileName(repo, filePath);
    const target = path.join(dir, filename);
    const part = `${target}.part`;
    const controller = new AbortController();

    const job = {
      id,
      repo,
      path: filePath,
      filename,
      target,
      received: 0,
      total: Number(size) || 0,
      status: "downloading",
      cancelled: false,
      controller,
      startedAt: Date.now(),
    };
    this.active.set(id, job);

    // Already complete from a previous run: advertise it and stop.
    if (fs.existsSync(target) && (!size || fs.statSync(target).size === Number(size))) {
      job.received = fs.statSync(target).size;
      job.total = job.received;
      job.status = "done";
      this.onProgress(this.snapshot(job));
      this.onComplete(this.snapshot(job));
      return { id, status: "done", filename };
    }

    this.run(job, { token, part, target }).catch((error) => {
      if (job.cancelled || error?.name === "AbortError") {
        job.status = "cancelled";
        job.error = null;
      } else {
        job.status = "error";
        job.error = error?.message ?? String(error);
      }
      this.onProgress(this.snapshot(job));
    });

    return { id, status: "downloading", filename };
  }

  snapshot(job) {
    const elapsed = Math.max((Date.now() - job.startedAt) / 1000, 0.001);
    const speed = job.received / elapsed;
    const remaining = job.total > 0 ? Math.max(job.total - job.received, 0) : 0;
    return {
      id: job.id,
      repo: job.repo,
      path: job.path,
      filename: job.filename,
      target: job.target,
      received: job.received,
      total: job.total,
      percent: job.total > 0 ? Math.min(100, (job.received / job.total) * 100) : null,
      bytesPerSecond: speed,
      etaSeconds: job.total > 0 && speed > 0 ? remaining / speed : null,
      status: job.status,
      error: job.error ?? null,
    };
  }

  async run(job, { token, part, target }) {
    let start = 0;
    if (fs.existsSync(part)) {
      start = fs.statSync(part).size;
      if (job.total && start > job.total) {
        fs.rmSync(part, { force: true });
        start = 0;
      }
    }

    const headers = {
      "User-Agent": "Blackbox/1.0 (local desktop client)",
      Accept: "*/*",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (start > 0) headers.Range = `bytes=${start}-`;

    const url = resolveUrl(job.repo, job.path);
    const response = await fetch(url, {
      headers,
      signal: job.controller.signal,
      redirect: "follow",
    });

    if (!response.ok && response.status !== 206) {
      const messages = {
        401: "Repository is private or gated. Add a Hugging Face token in Settings.",
        403: "Access denied by Hugging Face. Accept the repo terms and add a token in Settings.",
        404: "File not found on Hugging Face.",
        429: "Hugging Face is rate limiting this machine. Try again in a minute.",
      };
      throw new Error(messages[response.status] ?? `Download failed with HTTP ${response.status}`);
    }

    // Server ignored Range and is sending the whole file again.
    let resumeFrom = start;
    if (start > 0 && response.status === 200) {
      resumeFrom = 0;
      fs.rmSync(part, { force: true });
    }

    const contentLength = Number(response.headers.get("content-length")) || 0;
    const rangeStart = /bytes (\d+)-/i.exec(response.headers.get("content-range") ?? "");
    const baseOffset = rangeStart ? Number(rangeStart[1]) : resumeFrom;

    job.total = contentLength > 0 ? baseOffset + contentLength : job.total;
    job.received = baseOffset;
    job.startedAt = Date.now();

    const writeStream = fs.createWriteStream(part, { flags: resumeFrom > 0 ? "a" : "w" });
    let lastFlush = 0;

    const body = Readable.fromWeb(response.body);
    body.on("data", (chunk) => {
      job.received += chunk.length;
      const now = Date.now();
      if (now - lastFlush > CHUNK_FLUSH_MS) {
        lastFlush = now;
        this.onProgress(this.snapshot(job));
      }
    });

    try {
      await pipeline(body, writeStream);
    } catch (error) {
      if (job.cancelled || error?.name === "AbortError") {
        const cancelError = new Error("cancelled");
        cancelError.name = "AbortError";
        throw cancelError;
      }
      throw error;
    }

    const finalSize = fs.statSync(part).size;
    if (job.total > 0 && finalSize !== job.total) {
      throw new Error(
        `Download incomplete: received ${finalSize} of ${job.total} bytes. Press retry to resume.`,
      );
    }

    fs.renameSync(part, target);
    job.received = finalSize;
    job.total = finalSize;
    job.status = "done";

    fs.writeFileSync(
      `${target}.json`,
      JSON.stringify(
        {
          repo: job.repo,
          path: job.path,
          size: finalSize,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    this.onProgress(this.snapshot(job));
    this.onComplete(this.snapshot(job));
  }
}
