// Generates a 128x128 marketplace icon (media/icon.png): the same IC/chip
// motif as media/icon.svg (a die with pins on all four sides) on a teal ->
// indigo gradient with rounded corners, rendered at 4x and box-downsampled
// for anti-aliasing, then PNG-encoded via zlib. No external image libraries
// (no rsvg/imagemagick/inkscape available in this environment) -- same
// technique as the sibling Fizzim extension's scripts/generate-icon.js.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 128;
const S = 4;
const BIG = SIZE * S; // 512
const buf = new Float64Array(BIG * BIG * 4); // straight-alpha RGBA, 0..255

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function comp(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= BIG || y >= BIG || a <= 0) return;
  const i = (y * BIG + x) * 4;
  const ia = 1 - a;
  buf[i] = r * a + buf[i] * ia;
  buf[i + 1] = g * a + buf[i + 1] * ia;
  buf[i + 2] = b * a + buf[i + 2] * ia;
  buf[i + 3] = clamp(a * 255 + buf[i + 3] * ia, 0, 255);
}

function fillBackground() {
  const rad = BIG * 0.17;
  for (let y = 0; y < BIG; y++) {
    for (let x = 0; x < BIG; x++) {
      const rx = Math.max(rad - x, x - (BIG - 1 - rad), 0);
      const ry = Math.max(rad - y, y - (BIG - 1 - rad), 0);
      if (Math.hypot(rx, ry) > rad) continue;
      const t = (x + y) / (2 * BIG); // diagonal gradient
      // teal (13,148,136) -> indigo (67,56,202)
      const r = lerp(13, 67, t);
      const g = lerp(148, 56, t);
      const b = lerp(136, 202, t);
      comp(x, y, r, g, b, 1);
    }
  }
}

function strokeRect(x0, y0, x1, y1, half, r, g, b, a) {
  for (let y = Math.floor(y0 - half); y <= Math.ceil(y1 + half); y++) {
    for (let x = Math.floor(x0 - half); x <= Math.ceil(x1 + half); x++) {
      const dx = Math.max(x0 - x, x - x1, 0);
      const dy = Math.max(y0 - y, y - y1, 0);
      const d = dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
      // Distance to the rectangle's border (inside: negative-ish via a second check)
      const inside = x > x0 && x < x1 && y > y0 && y < y1;
      const distToEdge = inside
        ? Math.min(x - x0, x1 - x, y - y0, y1 - y)
        : d;
      if (distToEdge <= half) comp(x, y, r, g, b, a);
    }
  }
}

function fillRect(x0, y0, x1, y1, r, g, b, a) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      comp(x, y, r, g, b, a);
    }
  }
}

function thickSeg(ax, ay, bx, by, half, r, g, b, a) {
  const x0 = Math.floor(Math.min(ax, bx) - half), x1 = Math.ceil(Math.max(ax, bx) + half);
  const y0 = Math.floor(Math.min(ay, by) - half), y1 = Math.ceil(Math.max(ay, by) + half);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let t = ((x - ax) * dx + (y - ay) * dy) / len2;
      t = clamp(t, 0, 1);
      const cx = ax + t * dx, cy = ay + t * dy;
      if (Math.hypot(x - cx, y - cy) <= half) comp(x, y, r, g, b, a);
    }
  }
}

// --- compose the icon: same motif as media/icon.svg's 24x24 viewBox ---
fillBackground();

const W = 255, WA = 1; // white, full opacity
const stroke = BIG * 0.028;

// Outer die outline: rect x=7 y=7 w=10 h=10 in a 24x24 box -> fractions:
const OX0 = BIG * (7 / 24), OY0 = BIG * (7 / 24);
const OX1 = BIG * (17 / 24), OY1 = BIG * (17 / 24);
strokeRect(OX0, OY0, OX1, OY1, stroke, W, W, W, WA);

// Inner filled square: rect x=10 y=10 w=4 h=4
fillRect(BIG * (10 / 24), BIG * (10 / 24), BIG * (14 / 24), BIG * (14 / 24), W, W, W, WA);

// Pins: vertical ticks at x=9,12,15 (top: y 2->5, bottom: y 19->22),
// horizontal ticks at y=9,12,15 (left: x 2->5, right: x 19->22).
const pinHalf = stroke * 0.85;
for (const xf of [9, 12, 15]) {
  const x = BIG * (xf / 24);
  thickSeg(x, BIG * (2 / 24), x, BIG * (5 / 24), pinHalf, W, W, W, WA);
  thickSeg(x, BIG * (19 / 24), x, BIG * (22 / 24), pinHalf, W, W, W, WA);
}
for (const yf of [9, 12, 15]) {
  const y = BIG * (yf / 24);
  thickSeg(BIG * (2 / 24), y, BIG * (5 / 24), y, pinHalf, W, W, W, WA);
  thickSeg(BIG * (19 / 24), y, BIG * (22 / 24), y, pinHalf, W, W, W, WA);
}

// --- downsample BIG -> SIZE (box filter) ---
const out = Buffer.alloc(SIZE * (1 + SIZE * 4));
let p = 0;
for (let y = 0; y < SIZE; y++) {
  out[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < S; dy++) {
      for (let dx = 0; dx < S; dx++) {
        const i = ((y * S + dy) * BIG + (x * S + dx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    }
    const n = S * S;
    out[p++] = Math.round(r / n);
    out[p++] = Math.round(g / n);
    out[p++] = Math.round(b / n);
    out[p++] = Math.round(a / n);
  }
}

// --- PNG encode ---
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const dest = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(dest, png);
console.log(`wrote ${dest} (${png.length} bytes, ${SIZE}x${SIZE})`);
