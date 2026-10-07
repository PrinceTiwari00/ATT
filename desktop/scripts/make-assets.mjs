/**
 * Generates every binary visual asset from desktop/assets/icon-source.png:
 *
 *   build/icon.png          512×512 RGBA app icon (transparent corners)
 *   build/icon.ico          multi-size Windows icon (256 PNG + BMP entries)
 *   assets/tray/*.png       32×32 tray icons (online / offline / starting)
 *   ../web/public/favicon.png   favicon for the dashboard
 *
 * Pure JS + sharp (resize + SVG rasterise). The .ico is written here because no
 * small trustworthy npm package exists for multi-format ICO containers, and the
 * BMP/PNG entry encoding is ~40 lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const source = path.join(desktopRoot, 'assets', 'icon-source.png');
const buildDir = path.join(desktopRoot, 'build');
const trayDir = path.join(desktopRoot, 'assets', 'tray');
const webPublic = path.resolve(desktopRoot, '..', 'web', 'public');

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(trayDir, { recursive: true });
fs.mkdirSync(webPublic, { recursive: true });

/* ── 1. crop to the artwork and key out the light studio background ────── */

async function preparedSource() {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // Bounding box of saturated (purple/indigo) pixels = the squircle artwork.
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > 45) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('icon-source.png has no saturated artwork — cannot crop');
  const pad = Math.round((maxX - minX) * 0.015);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const width = Math.min(info.width - left, maxX - minX + pad * 2);
  const height = Math.min(info.height - top, maxY - minY + pad * 2);

  const cropped = await sharp(source)
    .extract({ left, top, width, height })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Drop the near-white studio background (including its soft shadow fringe).
  const px = cropped.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (r > 232 && g > 232 && b > 232 && sat < 18) px[i + 3] = 0;
    else if (r > 210 && g > 210 && b > 210 && sat < 12) px[i + 3] = Math.round(px[i + 3] * 0.35);
  }
  return { data: px, width: cropped.info.width, height: cropped.info.height };
}

async function toPng(raw, size) {
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function rawAt(raw, size) {
  const buf = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .resize(size, size, { kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return buf;
}

/* ── 2. ICO container (PNG entry for 256, BMP entries for the rest) ────── */

function bmpEntry(rgba, size) {
  const pixels = size * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = XOR + AND masks
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  // rest stays 0 (BI_RGB, no palette)

  const xor = Buffer.alloc(pixels * 4);
  for (let y = 0; y < size; y++) {
    // BMP rows are bottom-up
    const srcRow = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const andRowBytes = Math.ceil(size / 8);
  const andPadded = Math.ceil(andRowBytes / 4) * 4;
  const and = Buffer.alloc(andPadded * size); // all zero = fully opaque (alpha channel rules)
  return Buffer.concat([header, xor, and]);
}

function writeIco(file, entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon type
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  const chunks = [];
  let offset = 6 + entries.length * 16;
  entries.forEach((entry, index) => {
    const o = index * 16;
    directory[o] = entry.size >= 256 ? 0 : entry.size;
    directory[o + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[o + 2] = 0;
    directory[o + 3] = 0;
    directory.writeUInt16LE(1, o + 4); // planes
    directory.writeUInt16LE(32, o + 6); // bit count
    directory.writeUInt32LE(entry.data.length, o + 8);
    directory.writeUInt32LE(offset, o + 12);
    offset += entry.data.length;
    chunks.push(entry.data);
  });
  fs.writeFileSync(file, Buffer.concat([header, directory, ...chunks]));
}

/* ── 3. tray icons (SVG → PNG) ─────────────────────────────────────────── */

const TRAY_COLORS = {
  online: { bg: '#059669', glow: '#34d399' },
  offline: { bg: '#e11d48', glow: '#fb7185' },
  starting: { bg: '#4f46e5', glow: '#818cf8' },
};

function traySvg({ bg, glow }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect x="1" y="1" width="30" height="30" rx="8" fill="${bg}" stroke="#ffffff" stroke-opacity="0.85" stroke-width="1.5"/>
  <circle cx="16" cy="16" r="3.2" fill="#ffffff"/>
  <path d="M9.5 16a6.5 6.5 0 0 1 13 0" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
  <path d="M6.8 16a9.2 9.2 0 0 1 18.4 0" fill="none" stroke="${glow}" stroke-width="2" stroke-linecap="round" stroke-opacity="0.9"/>
  <path d="M12.4 20.2a3.7 3.7 0 0 0 7.2 0" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
</svg>`;
}

/* ── main ──────────────────────────────────────────────────────────────── */

const raw = await preparedSource();

// icon.png (installer/web source of truth)
const png512 = await toPng(raw, 512);
fs.writeFileSync(path.join(buildDir, 'icon.png'), png512);

// multi-size ICO
const sizes = [16, 24, 32, 48, 64, 128];
const entries = [];
for (const size of sizes) {
  entries.push({ size, data: bmpEntry(await rawAt(raw, size), size) });
}
entries.push({ size: 256, data: await toPng(raw, 256) });
writeIco(path.join(buildDir, 'icon.ico'), entries);

// tray icons
for (const [name, colors] of Object.entries(TRAY_COLORS)) {
  const buf = await sharp(Buffer.from(traySvg(colors))).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(path.join(trayDir, `${name}.png`), buf);
}

// dashboard favicon
fs.writeFileSync(path.join(webPublic, 'favicon.png'), await toPng(raw, 64));

const stat = (f) => fs.statSync(f).size;
console.log('[assets] icon.ico      ', stat(path.join(buildDir, 'icon.ico')), 'bytes,', entries.length, 'sizes');
console.log('[assets] icon.png      ', stat(path.join(buildDir, 'icon.png')), 'bytes');
for (const name of Object.keys(TRAY_COLORS)) {
  console.log(`[assets] tray/${name}.png`.padEnd(22), stat(path.join(trayDir, `${name}.png`)), 'bytes');
}
console.log('[assets] favicon.png   ', stat(path.join(webPublic, 'favicon.png')), 'bytes');
