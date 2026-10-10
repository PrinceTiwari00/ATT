/**
 * Fetches the official Node.js LTS runtime for Windows so the installed app is
 * completely self-contained: no Node on the target PC, no PATH assumptions, and
 * a guaranteed `node:sqlite` (the attendance database).
 *
 *      desktop/dist/payload/runtime/node.exe
 *
 * The version is read from the repo's .node-version (single source of truth
 * with CI, Render and the docs). The zip is parsed in pure JS
 * (scripts/lib/unzip.mjs) — no PowerShell, no unzip, same behaviour on every OS.
 *
 * Fallback: on a Windows CI runner, actions/setup-node has already downloaded
 * this exact version, so if nodejs.org is unreachable we reuse the runner's own
 * node.exe instead of failing the installer build.
 *
 * Pass --optional to tolerate failure when you only want a development payload.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { extractFile, listEntries } from './lib/unzip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..');

const argVersion = process.argv.find((a) => a.startsWith('--version='))?.slice('--version='.length);
const version = (argVersion || fs.readFileSync(path.join(repoRoot, '.node-version'), 'utf8').trim()).replace(/^v/, '');
const DOWNLOAD_URL = `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`;

const runtimeDir = path.join(desktopRoot, 'dist', 'payload', 'runtime');
const cacheDir = path.join(desktopRoot, 'dist', 'cache');
const target = path.join(runtimeDir, 'node.exe');
const MIN_NODE_BYTES = 10 * 1048576; // a real win-x64 node.exe is ~80 MB

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'user-agent': 'att-desktop-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Reuse the Windows node.exe that actions/setup-node already put on this runner. */
function reuseHostNode() {
  if (process.platform !== 'win32') return null;
  const exe = process.execPath;
  if (!/node\.exe$/i.test(path.basename(exe))) return null;
  const size = fs.statSync(exe).size;
  if (size < MIN_NODE_BYTES) return null;
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(exe, target);
  return { source: exe, size, hostVersion: process.versions.node };
}

if (fs.existsSync(target) && fs.statSync(target).size >= MIN_NODE_BYTES) {
  console.log(`[runtime] node.exe already present (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`);
  process.exit(0);
}

fs.mkdirSync(cacheDir, { recursive: true });
const zip = path.join(cacheDir, `node-v${version}-win-x64.zip`);

try {
  if (!fs.existsSync(zip)) {
    console.log(`[runtime] downloading ${DOWNLOAD_URL}`);
    await download(DOWNLOAD_URL, `${zip}.part`);
    fs.renameSync(`${zip}.part`, zip);
    console.log(`[runtime] cached ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB`);
  }

  console.log(`[runtime] extracting node.exe (v${version}) from ${path.basename(zip)}`);
  const { bytes } = extractFile(zip, 'node.exe', target);
  if (bytes < MIN_NODE_BYTES) throw new Error(`extracted node.exe looks wrong (${bytes} bytes)`);
  console.log(`[runtime] ${target} (${(bytes / 1048576).toFixed(1)} MB)`);
  console.log(`[runtime] archive holds ${listEntries(zip).length} entries`);
} catch (err) {
  fs.rmSync(`${zip}.part`, { force: true });
  console.error(`[runtime] could not fetch the Node runtime: ${err.message}`);

  const reused = reuseHostNode();
  if (reused) {
    console.warn(
      `[runtime] FALLBACK: using this Windows runner's own node.exe (v${reused.hostVersion}) from ${reused.source}\n` +
        `[runtime]           ${(reused.size / 1048576).toFixed(1)} MB → ${target}`
    );
    process.exit(0);
  }

  console.error('[runtime] the installer bundles its own runtime; without it the app would need Node 22+ on the PC.');
  if (process.argv.includes('--optional')) process.exit(0);
  process.exit(1);
}
