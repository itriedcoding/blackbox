/**
 * Discord Rich Presence over Discord's local RPC socket.
 *
 * No bot token and no gateway are involved: Discord runs a small IPC server on
 * the machine, and an app identifies itself with its application ID and pushes
 * an activity. This module speaks that protocol directly, so it adds no
 * dependency and can be tested against a stand-in socket.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const OP_HANDSHAKE = 0;
export const OP_FRAME = 1;
export const OP_CLOSE = 2;

export function encodeFrame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.allocUnsafe(8 + body.length);
  frame.writeInt32LE(op, 0);
  frame.writeInt32LE(body.length, 4);
  body.copy(frame, 8);
  return frame;
}

/** Reassembles Discord frames from a stream that may split or merge chunks. */
export class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > 8 * 1024 * 1024) throw new Error("Discord sent an impossible frame length.");
      if (this.buffer.length < 8 + length) break;
      const raw = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      frames.push({ op, payload });
    }
    return frames;
  }
}

export function socketCandidates({ platform = process.platform, env = process.env, basePath = null } = {}) {
  if (basePath) return [basePath];
  const indexes = Array.from({ length: 10 }, (_unused, index) => index);
  if (platform === "win32") {
    return indexes.map((index) => `\\\\.\\pipe\\discord-ipc-${index}`);
  }
  const dirs = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, os.tmpdir()].filter(Boolean);
  const paths = [];
  for (const dir of dirs) {
    for (const index of indexes) paths.push(path.join(dir, `discord-ipc-${index}`));
  }
  return [...new Set(paths)];
}

/** Discord shows an error for empty or one-character fields, so clamp and pad. */
export function sanitizeActivity(activity = {}) {
  const clamp = (value, fallback) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return fallback;
    return text.length > 128 ? `${text.slice(0, 127)}…` : text;
  };
  const clean = {
    details: clamp(activity.details, "Blackbox"),
    state: clamp(activity.state, "Running locally"),
    instance: false,
  };
  if (activity.timestamps?.start) clean.timestamps = { start: Math.round(Number(activity.timestamps.start)) };
  const large = activity.assets?.large_image ? String(activity.assets.large_image).trim() : "";
  if (large) {
    clean.assets = { large_image: large.slice(0, 256), large_text: clamp(activity.assets.large_text, "Blackbox") };
  }
  if (Array.isArray(activity.buttons) && activity.buttons.length) {
    clean.buttons = activity.buttons
      .filter((button) => button && button.label && /^https:\/\//i.test(String(button.url)))
      .slice(0, 2)
      .map((button) => ({ label: String(button.label).slice(0, 32), url: String(button.url).slice(0, 256) }));
    if (!clean.buttons.length) delete clean.buttons;
  }
  return clean;
}

export class DiscordPresence {
  constructor({ clientId, logoUrl = "", socketPath = null, onState = () => {} } = {}) {
    this.clientId = String(clientId ?? "").trim();
    this.logoUrl = logoUrl;
    this.socketPath = socketPath;
    this.onState = onState;
    this.socket = null;
    this.reader = new FrameReader();
    this.pending = new Map();
    this.connected = false;
    this.lastError = null;
    this.startedAt = null;
  }

  get status() {
    return {
      connected: this.connected,
      clientId: this.clientId || null,
      socket: this.socketPath,
      lastError: this.lastError,
      since: this.startedAt,
    };
  }

  #emit() {
    try {
      this.onState(this.status);
    } catch {
      /* a listener must never break the socket */
    }
  }

  async connect() {
    if (!this.clientId) throw new Error("A Discord application ID is needed for Rich Presence.");
    if (this.connected) return this.status;

    const candidates = socketCandidates({ basePath: this.socketPath });
    let lastError = null;

    for (const candidate of candidates) {
      try {
        await this.#open(candidate);
        this.socketPath = candidate;
        this.connected = true;
        this.startedAt = Date.now();
        this.lastError = null;
        this.#emit();
        return this.status;
      } catch (error) {
        lastError = error;
      }
    }

    this.lastError = lastError?.message ?? "Discord is not running on this machine.";
    this.#emit();
    throw new Error(
      `Could not reach the Discord client (${this.lastError}). Rich Presence needs the Discord desktop app running and signed in.`,
    );
  }

  #open(candidate) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(candidate);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Discord did not answer the handshake."));
      }, 4000);

      const onError = (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        clearTimeout(timer);
        this.socket = socket;
        this.reader = new FrameReader();
        socket.on("data", (chunk) => this.#onData(chunk));
        socket.on("error", (error) => {
          this.lastError = error.message;
        });
        socket.on("close", () => {
          this.connected = false;
          this.#emit();
        });
        socket.write(encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
        // Discord answers the handshake with a READY dispatch on this socket.
        setTimeout(() => resolve(), 120);
      });
    });
  }

  #onData(chunk) {
    let frames = [];
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      this.lastError = error.message;
      return;
    }
    for (const frame of frames) {
      const payload = frame.payload;
      if (!payload) continue;
      if (payload.evt === "ERROR") {
        const message = payload.data?.message ?? "Discord rejected the activity.";
        this.lastError = message;
        const waiter = payload.nonce ? this.pending.get(payload.nonce) : null;
        if (waiter) {
          this.pending.delete(payload.nonce);
          waiter.reject(new Error(message));
        }
        continue;
      }
      if (payload.nonce && this.pending.has(payload.nonce)) {
        const waiter = this.pending.get(payload.nonce);
        this.pending.delete(payload.nonce);
        waiter.resolve(payload.data);
      }
    }
  }

  #request(command, args, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error("Discord is not connected."));
        return;
      }
      const nonce = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error("Discord did not answer the activity update."));
      }, timeoutMs);
      this.pending.set(nonce, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(encodeFrame(OP_FRAME, { cmd: command, args, nonce }));
    });
  }

  async setActivity(activity) {
    // Every activity carries the app logo unless the caller chose another one.
    const withLogo = { ...activity };
    if (!withLogo.assets?.large_image && this.logoUrl) {
      withLogo.assets = { ...(withLogo.assets ?? {}), large_image: this.logoUrl };
    }
    const clean = sanitizeActivity(withLogo);
    await this.#request("SET_ACTIVITY", { pid: process.pid, activity: clean });
    return clean;
  }

  async clearActivity() {
    await this.#request("SET_ACTIVITY", { pid: process.pid, activity: null });
  }

  close() {
    for (const waiter of this.pending.values()) waiter.reject(new Error("Discord presence closed."));
    this.pending.clear();
    if (this.socket) {
      try {
        this.socket.end(encodeFrame(OP_CLOSE, {}));
      } catch {
        /* already gone */
      }
      this.socket.destroy();
    }
    this.socket = null;
    this.connected = false;
    this.#emit();
  }
}
