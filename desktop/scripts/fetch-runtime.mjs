/**
 * Fetches the official Node.js LTS runtime for Windows so the installed app is
 * completely self-contained: no Node on the target PC, no PATH assumptions, and
 * a guaranteed `node:sqlite` (the attendance database).
 *
 *      desktop/dist/payload/runtime/node.exe
 *
 * The version is read from the repo's .node-version (single source of truth
 * with CI, Render and the docs). On Windows the zip is extracted with
 * PowerShell; elsewhere with `unzip`. Pass --optional to tolerate failure when
 * you only want a development payload.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..');

const argVersion = process.argv.find((a) => a.startsWith('--version='))?.slice('--version='.length);
const version = (argVersion || fs.readFileSync(path.join(repoRoot, '.node-version'), 'utf8').trim()).replace(/^v/, '');
const URL = `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`;

const runtimeDir = path.join(desktopRoot, 'dist', 'payload', 'runtime');
const cacheDir = path.join(desktopRoot, 'dist', 'cache');
const target = path.join(runtimeDir, 'node.exe');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'user-agent': 'att-desktop-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
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

function extractNodeExe(zip, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
          `$z=[System.IO.Compression.ZipFile]::OpenRead('${zip}'); ` +
          `$e=$z.Entries | Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1; ` +
          `if (-not $e) { exit 2 }; ` +
          `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${path.join(outDir, 'node.exe')}', $true); ` +
          `$z.Dispose()`,
      ],
      { stdio: 'inherit' }
    );
    if (res.status !== 0) throw new Error(`PowerShell extraction failed (exit ${res.status})`);
    return;
  }
  const res = spawnSync('unzip', ['-o', '-j', zip, `node-v${version}-win-x64/node.exe`, '-d', outDir], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`unzip failed (exit ${res.status}) — install unzip or build on Windows`);
}

if (fs.existsSync(target)) {
  console.log(`[runtime] node.exe already present (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`);
  process.exit(0);
}

fs.mkdirSync(cacheDir, { recursive: true });
const zip = path.join(cacheDir, `node-v${version}-win-x64.zip`);

try {
  if (!fs.existsSync(zip)) {
    console.log(`[runtime] downloading ${URL}`);
    await download(URL, `${zip}.part`);
    fs.renameSync(`${zip}.part`, zip);
  }
  console.log(`[runtime] extracting node.exe (v${version})`);
  extractNodeExe(zip, runtimeDir);
  const size = fs.statSync(target).size;
  if (size < 10 * 1048576) throw new Error(`extracted node.exe looks wrong (${size} bytes)`);
  console.log(`[runtime] ${target} (${(size / 1048576).toFixed(1)} MB)`);
} catch (err) {
  fs.rmSync(`${zip}.part`, { force: true });
  console.error(`[runtime] could not fetch the Node runtime: ${err.message}`);
  console.error('[runtime] the installer bundles its own runtime; without it the app would need Node 22+ on the PC.');
  if (process.argv.includes('--optional')) process.exit(0);
  process.exit(1);
}
