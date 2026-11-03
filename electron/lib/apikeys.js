/**
 * API keys for the local OpenAI-compatible server.
 *
 * Only a SHA-256 hash and a short prefix are stored on disk, so a leaked
 * settings folder does not leak usable keys. The plaintext key is returned
 * exactly once, when it is created.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "bb_";

function hash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class ApiKeyStore {
  constructor(file) {
    this.file = file;
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { keys: Array.isArray(parsed?.keys) ? parsed.keys : [] };
    } catch {
      return { keys: [] };
    }
  }

  #write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.#read().keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt ?? null,
      requests: key.requests ?? 0,
    }));
  }

  create(name) {
    const label = String(name ?? "").trim().slice(0, 60) || "Untitled key";
    const token = PREFIX + crypto.randomBytes(24).toString("base64url");
    const record = {
      id: crypto.randomUUID(),
      name: label,
      prefix: token.slice(0, PREFIX.length + 6),
      hash: hash(token),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      requests: 0,
    };
    const db = this.#read();
    db.keys.push(record);
    this.#write(db);
    return { key: token, id: record.id, name: record.name, prefix: record.prefix };
  }

  revoke(id) {
    const db = this.#read();
    const before = db.keys.length;
    db.keys = db.keys.filter((key) => key.id !== id);
    if (db.keys.length === before) return false;
    this.#write(db);
    return true;
  }

  verify(token) {
    if (!token) return null;
    const digest = hash(token);
    let match = null;
    for (const key of this.#read().keys) {
      if (safeEqual(key.hash, digest)) {
        match = key;
        break;
      }
    }
    if (!match) return null;
    return { id: match.id, name: match.name };
  }

  recordUse(id) {
    const db = this.#read();
    const key = db.keys.find((entry) => entry.id === id);
    if (!key) return;
    key.requests = (key.requests ?? 0) + 1;
    key.lastUsedAt = new Date().toISOString();
    this.#write(db);
  }
}
