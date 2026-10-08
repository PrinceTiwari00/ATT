/**
 * Downloads the WinSW service wrapper (MIT licensed) and places it where the
 * installer expects it:
 *
 *      desktop/service/att-service.exe      (WinSW v2.12.0, self-contained x64)
 *
 * The wrapper is never committed to Git; CI fetches it from the official
 * GitHub release and the installer ships it inside resources\service\.
 * `att-service.xml` (in this folder, committed) configures it.
 *
 * Integrity: the byte size published by the release is verified after download.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const RELEASE = 'v2.12.0';
const ASSET = 'WinSW-x64.exe';
const EXPECTED_SIZE = 18_243_033; // published by the v2.12.0 release
const URL = `https://github.com/winsw/winsw/releases/download/${RELEASE}/${ASSET}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', 'service', 'att-service.exe');

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

if (fs.existsSync(target) && fs.statSync(target).size === EXPECTED_SIZE && process.argv.includes('--cached')) {
  console.log('[service] att-service.exe already present (cached)');
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
const tmp = `${target}.download`;
console.log(`[service] downloading ${URL}`);
try {
  await download(URL, tmp);
  const size = fs.statSync(tmp).size;
  if (size !== EXPECTED_SIZE) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`unexpected size ${size} (expected ${EXPECTED_SIZE}) — refusing to ship it`);
  }
  fs.renameSync(tmp, target);
  console.log(`[service] ${target} (${(size / 1048576).toFixed(1)} MB) — wrapper ${RELEASE}`);
} catch (err) {
  fs.rmSync(tmp, { force: true });
  console.error(`[service] could not fetch the service wrapper: ${err.message}`);
  if (process.argv.includes('--optional')) process.exit(0);
  process.exit(1);
}
