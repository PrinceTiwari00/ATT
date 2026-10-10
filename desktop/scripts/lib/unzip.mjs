/**
 * Minimal ZIP reader — extract ONE entry without shelling out.
 *
 * The build needs `node.exe` out of the official Node.js win-x64 zip. Doing that
 * with PowerShell or `unzip` makes the build depend on the host OS (PowerShell
 * Core removed System.IO.Compression.FileSystem; Linux runners may lack unzip;
 * quoting Windows paths into a shell is a classic source of red builds). Reading
 * the zip in pure Node makes the step identical on Windows, Linux and macOS.
 *
 * Implements just enough of APPNOTE 4.5: end-of-central-directory → central
 * directory → local header → stored (0) or deflate (8) payload. Zip64 is
 * detected and rejected with a clear message (the Node zip is ~30 MB / ~2k
 * entries, so it never needs it).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Locate the End Of Central Directory record (it may be followed by a comment). */
function findEocd(buf) {
  const min = buf.length - 22;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = min; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

/**
 * List the archive's entries.
 * @returns {{name:string, method:number, compressedSize:number, size:number, localHeaderOffset:number}[]}
 */
export function listEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const tailSize = Math.min(stat.size, 22 + 0xffff);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);

    const eocdInTail = findEocd(tail);
    const totalEntries = tail.readUInt16LE(eocdInTail + 10);
    const cdSize = tail.readUInt32LE(eocdInTail + 12);
    const cdOffset = tail.readUInt32LE(eocdInTail + 16);

    if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error('zip64 archives are not supported (this zip needs one)');
    }

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      entries.push({ name, method, compressedSize, size, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (entries.length !== totalEntries) {
      throw new Error(`central directory is truncated (read ${entries.length} of ${totalEntries} entries)`);
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

const basename = (name) => name.replace(/\\/g, '/').split('/').pop();

/**
 * Read one entry's bytes.
 * @param {string} zipPath
 * @param {(name:string)=>boolean} match  predicate on the entry name
 */
export function readEntry(zipPath, match) {
  const entries = listEntries(zipPath);
  const entry = entries.find((e) => match(e.name));
  if (!entry) {
    throw new Error(
      `no matching entry in ${zipPath.split(/[\\/]/).pop()} — looked at ${entries.length} entries ` +
        `(e.g. ${entries.slice(0, 3).map((e) => e.name).join(', ')})`
    );
  }

  const fd = fs.openSync(zipPath, 'r');
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.localHeaderOffset);
    if (head.readUInt32LE(0) !== LOCAL_SIG) {
      throw new Error(`corrupt local header for ${entry.name}`);
    }
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;

    const raw = Buffer.alloc(entry.compressedSize);
    fs.readSync(fd, raw, 0, entry.compressedSize, dataOffset);

    if (entry.method === 0) return raw; // stored
    if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
    throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Extract the first entry whose basename equals `fileName`, writing it to `destPath`. */
export function extractFile(zipPath, fileName, destPath) {
  const data = readEntry(zipPath, (name) => basename(name) === fileName);
  if (!data || data.length === 0) throw new Error(`extracted ${fileName} is empty`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, data);
  return { bytes: data.length, destPath };
}
