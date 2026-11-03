/**
 * Minimal GGUF metadata reader.
 *
 * Used to size the KV cache before loading a model, so Blackbox can refuse to
 * start something that will not fit in RAM instead of swapping the machine to death.
 * Only the header key/value block is parsed; tensors are never touched.
 */

import fs from "node:fs";

const TYPE_UINT8 = 0;
const TYPE_INT8 = 1;
const TYPE_UINT16 = 2;
const TYPE_INT16 = 3;
const TYPE_UINT32 = 4;
const TYPE_INT32 = 5;
const TYPE_FLOAT32 = 6;
const TYPE_BOOL = 7;
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;
const TYPE_UINT64 = 10;
const TYPE_INT64 = 11;
const TYPE_FLOAT64 = 12;

const FIXED_SIZES = {
  [TYPE_UINT8]: 1,
  [TYPE_INT8]: 1,
  [TYPE_UINT16]: 2,
  [TYPE_INT16]: 2,
  [TYPE_UINT32]: 4,
  [TYPE_INT32]: 4,
  [TYPE_FLOAT32]: 4,
  [TYPE_BOOL]: 1,
  [TYPE_UINT64]: 8,
  [TYPE_INT64]: 8,
  [TYPE_FLOAT64]: 8,
};

const MAX_HEADER_BYTES = 32 * 1024 * 1024;

class BufferReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  ensure(bytes) {
    if (this.offset + bytes > this.buffer.length) {
      throw new Error("GGUF metadata extends past the read window");
    }
  }

  u8() {
    this.ensure(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u32() {
    this.ensure(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64() {
    this.ensure(8);
    const value = Number(this.buffer.readBigUInt64LE(this.offset));
    this.offset += 8;
    return value;
  }

  i64() {
    this.ensure(8);
    const value = Number(this.buffer.readBigInt64LE(this.offset));
    this.offset += 8;
    return value;
  }

  string() {
    const length = this.u64();
    this.ensure(length);
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skipValue(type) {
    if (type === TYPE_STRING) {
      this.string();
      return;
    }
    if (type === TYPE_ARRAY) {
      const itemType = this.u32();
      const count = this.u64();
      if (itemType === TYPE_STRING) {
        for (let i = 0; i < count; i += 1) this.string();
      } else {
        const itemSize = FIXED_SIZES[itemType];
        if (!itemSize) throw new Error(`Unsupported GGUF array item type ${itemType}`);
        this.ensure(count * itemSize);
        this.offset += count * itemSize;
      }
      return;
    }
    const size = FIXED_SIZES[type];
    if (!size) throw new Error(`Unsupported GGUF value type ${type}`);
    this.ensure(size);
    this.offset += size;
  }

  readScalar(type) {
    switch (type) {
      case TYPE_UINT8:
        return this.u8();
      case TYPE_INT8: {
        this.ensure(1);
        const value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        return value;
      }
      case TYPE_UINT16:
        this.ensure(2);
        this.offset += 2;
        return this.buffer.readUInt16LE(this.offset - 2);
      case TYPE_INT16:
        this.ensure(2);
        this.offset += 2;
        return this.buffer.readInt16LE(this.offset - 2);
      case TYPE_UINT32:
        return this.u32();
      case TYPE_INT32: {
        this.ensure(4);
        const value = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return value;
      }
      case TYPE_FLOAT32: {
        this.ensure(4);
        const value = this.buffer.readFloatLE(this.offset);
        this.offset += 4;
        return value;
      }
      case TYPE_BOOL:
        return this.u8() !== 0;
      case TYPE_STRING:
        return this.string();
      case TYPE_UINT64:
        return this.u64();
      case TYPE_INT64:
        return this.i64();
      case TYPE_FLOAT64: {
        this.ensure(8);
        const value = this.buffer.readDoubleLE(this.offset);
        this.offset += 8;
        return value;
      }
      default:
        this.skipValue(type);
        return null;
    }
  }
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (Array.isArray(value) && value.length > 0) {
    // Per-layer arrays (some models store head_count_kv per block). Use the max.
    return value.reduce((max, entry) => (typeof entry === "number" && entry > max ? entry : max), 0);
  }
  return null;
}

export function readGgufInfo(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 24) throw new Error("File is too small to be a GGUF model");

  const headerSize = Math.min(stat.size, MAX_HEADER_BYTES);
  const buffer = Buffer.alloc(headerSize);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, headerSize, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (buffer.toString("utf8", 0, 4) !== "GGUF") {
    throw new Error("Not a GGUF file (missing magic header)");
  }

  const reader = new BufferReader(buffer);
  reader.offset = 4;
  const version = reader.u32();
  const tensorCount = reader.u64();
  const kvCount = reader.u64();

  const metadata = Object.create(null);
  for (let i = 0; i < kvCount; i += 1) {
    const key = reader.string();
    const type = reader.u32();
    if (type === TYPE_ARRAY) {
      reader.skipValue(TYPE_ARRAY);
      continue;
    }
    metadata[key] = reader.readScalar(type);
  }

  const architecture = metadata["general.architecture"] ?? null;
  const get = (suffix) => (architecture ? metadata[`${architecture}.${suffix}`] : undefined);

  const blockCount = toNumber(get("block_count"));
  const headCount = toNumber(get("attention.head_count"));
  const headCountKv = toNumber(get("attention.head_count_kv")) ?? headCount;
  const embeddingLength = toNumber(get("embedding_length"));
  const contextLength = toNumber(get("context_length"));

  let keyLength = toNumber(get("attention.key_length"));
  if (!keyLength && headCount && embeddingLength) keyLength = Math.floor(embeddingLength / headCount);
  const valueLength = toNumber(get("attention.value_length")) ?? keyLength;

  let kvBytesPerToken = null;
  if (blockCount && headCountKv && keyLength) {
    const perElement = 2; // f16 KV cache
    kvBytesPerToken = 2 * blockCount * headCountKv * keyLength * perElement;
  }

  const displayName = metadata["general.name"] ?? null;

  return {
    version,
    tensorCount,
    architecture,
    displayName,
    blockCount,
    headCount,
    headCountKv,
    embeddingLength,
    keyLength,
    valueLength,
    contextLength,
    kvBytesPerToken,
    fileSize: stat.size,
    estimated: kvBytesPerToken === null,
  };
}
