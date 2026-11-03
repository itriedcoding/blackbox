import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/* Generates build/icon.ico (multi-size) and build/icon.png from code.
   Pure Node, no image dependency: a monochrome ring-on-square mark, 4x supersampled. */

const OUT_DIR = path.join(process.cwd(), "build");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedRectSignedDistance(x, y, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x) - (halfWidth - radius);
  const qy = Math.abs(y) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function sampleMark(u, v) {
  // u, v in [-0.5, 0.5]
  const bg = roundedRectSignedDistance(u, v, 0.452, 0.452, 0.24);
  if (bg > 0) return [0, 0, 0, 0];

  const radius = Math.hypot(u, v);
  const ring = Math.abs(radius - 0.245) < 0.052;
  const core = radius < 0.093;
  if (ring || core) return [245, 245, 243, 255];
  return [10, 10, 10, 255];
}

function renderIcon(size) {
  const samples = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          const [cr, cg, cb, ca] = sampleMark(px / size - 0.5, py / size - 0.5);
          const alpha = ca / 255;
          r += cr * alpha;
          g += cg * alpha;
          b += cb * alpha;
          a += ca;
        }
      }
      const count = samples * samples;
      const alphaAvg = a / count;
      const weight = alphaAvg / 255 || 1;
      const offset = (y * size + x) * 4;
      out[offset] = Math.round(r / count / weight);
      out[offset + 1] = Math.round(g / count / weight);
      out[offset + 2] = Math.round(b / count / weight);
      out[offset + 3] = Math.round(alphaAvg);
    }
  }
  return out;
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: encodePng(size, renderIcon(size)) }));

fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), encodeIco(images));
const png256 = images[images.length - 1].png;
fs.writeFileSync(path.join(OUT_DIR, "icon.png"), png256);

console.log(`icon.ico written (${sizes.join(", ")} px) → ${path.relative(process.cwd(), OUT_DIR)}`);
