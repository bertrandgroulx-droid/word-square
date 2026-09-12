// Draw the app icons. No image libraries in the toolchain, so this writes the
// PNGs directly: RGBA pixels -> zlib -> PNG chunks.
// Run: npm run icons
import fs from "node:fs";
import zlib from "node:zlib";

const OUT = new URL("../", import.meta.url).pathname;

const BG = [0x1b, 0x17, 0x40];
const TILE = [0xf2, 0xf0, 0xff];
const HILITE = [0xfb, 0xbf, 0x24];
const N = 3;                 // a 3x3 nod to the grid
const HILITE_CELL = [1, 1];  // the "selected" square, centre

// ---- PNG plumbing ----------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte (0 = None) in front of every scanline.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- drawing ---------------------------------------------------------------
// Coverage of a rounded rect at a point, sampled 2x2 for cheap antialiasing.
function roundRectCoverage(x, y, rx0, ry0, rx1, ry1, r) {
  let hits = 0;
  for (const dx of [0.25, 0.75]) {
    for (const dy of [0.25, 0.75]) {
      const px = x + dx, py = y + dy;
      if (px < rx0 || px > rx1 || py < ry0 || py > ry1) continue;
      const cx = Math.min(Math.max(px, rx0 + r), rx1 - r);
      const cy = Math.min(Math.max(py, ry0 + r), ry1 - r);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) hits++;
    }
  }
  return hits / 4;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const pad = size * 0.15;
  const gap = size * 0.055;
  const tile = (size - 2 * pad - (N - 1) * gap) / N;
  const radius = tile * 0.22;

  const tiles = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      tiles.push({
        x0: pad + c * (tile + gap), y0: pad + r * (tile + gap),
        x1: pad + c * (tile + gap) + tile, y1: pad + r * (tile + gap) + tile,
        color: r === HILITE_CELL[0] && c === HILITE_CELL[1] ? HILITE : TILE,
        alpha: r === HILITE_CELL[0] && c === HILITE_CELL[1] ? 1 : 0.92
      });
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b] = BG;
      for (const t of tiles) {
        if (x + 1 < t.x0 || x > t.x1 || y + 1 < t.y0 || y > t.y1) continue;
        const a = roundRectCoverage(x, y, t.x0, t.y0, t.x1, t.y1, radius) * t.alpha;
        if (a <= 0) continue;
        r = Math.round(r * (1 - a) + t.color[0] * a);
        g = Math.round(g * (1 - a) + t.color[1] * a);
        b = Math.round(b * (1 - a) + t.color[2] * a);
      }
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return png(size, size, buf);
}

// 120/152/167 are the iPad and older-iPhone home-screen sizes. 48 isn't here:
// it exists only inside favicon.ico, so it needs no file of its own.
for (const size of [32, 120, 152, 167, 180, 192, 512]) {
  const file = `${OUT}icon-${size}.png`;
  fs.writeFileSync(file, render(size));
  console.log(`${file} — ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}

// ---- favicon.ico -----------------------------------------------------------
// Safari reaches for a .ico when picking a bookmark icon and skips SVG, so ship
// one. An .ico is just a small directory followed by the images; PNG payloads
// are allowed, so the renders above go in as-is.
function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, data: render(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const at = i * 16;
    dir[at] = img.size >= 256 ? 0 : img.size;      // 0 means 256
    dir[at + 1] = img.size >= 256 ? 0 : img.size;
    dir[at + 2] = 0;                                // palette size
    dir[at + 3] = 0;                                // reserved
    dir.writeUInt16LE(1, at + 4);                   // colour planes
    dir.writeUInt16LE(32, at + 6);                  // bits per pixel
    dir.writeUInt32LE(img.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

const icoFile = OUT + "favicon.ico";
fs.writeFileSync(icoFile, ico([32, 48]));
console.log(`${icoFile} — ${(fs.statSync(icoFile).size / 1024).toFixed(1)} KB`);

// The favicon is the same mark as scalable SVG.
const pad = 15, gap = 5.5, tile = (100 - 2 * pad - 2 * gap) / 3;
let rects = "";
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 3; c++) {
    const hi = r === 1 && c === 1;
    rects += `\n  <rect x="${(pad + c * (tile + gap)).toFixed(2)}" y="${(pad + r * (tile + gap)).toFixed(2)}" ` +
      `width="${tile.toFixed(2)}" height="${tile.toFixed(2)}" rx="${(tile * 0.22).toFixed(2)}" ` +
      `fill="${hi ? "#fbbf24" : "#f2f0ff"}"${hi ? "" : ' opacity="0.92"'} />`;
  }
}
fs.writeFileSync(OUT + "icon.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect width="100" height="100" rx="18" fill="#1b1740" />${rects}
</svg>\n`);
console.log(`${OUT}icon.svg`);
