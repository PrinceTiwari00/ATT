/**
 * One command that assembles the full Windows payload in dependency order:
 *
 *   1. visual assets   (icon.ico, tray icons, favicon)      make-assets.mjs
 *   2. backend bundle  (server.cjs + web/ + packaged.json)  bundle-server.mjs
 *   3. Node runtime    (runtime/node.exe)                   fetch-runtime.mjs
 *   4. service wrapper (service/att-service.exe)            fetch-service-wrapper.mjs
 *
 * Usage:
 *   node scripts/prepare-payload.mjs                strict (CI)
 *   node scripts/prepare-payload.mjs --optional     tolerate missing downloads
 *   node scripts/prepare-payload.mjs --skip-assets  reuse existing assets
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const optional = process.argv.includes('--optional') || process.argv.includes('--dev');
const skipAssets = process.argv.includes('--skip-assets');
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

function run(script, extra = []) {
  const res = spawnSync(process.execPath, [path.join(here, script), ...extra], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`[payload] ${script} failed (exit ${res.status})`);
    process.exit(res.status || 1);
  }
}

if (!skipAssets) {
  try {
    run('make-assets.mjs');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
} else {
  console.log('[payload] reusing existing assets');
}

run('bundle-server.mjs');
run('fetch-runtime.mjs', optional && !isCI ? ['--optional'] : []);
run('fetch-service-wrapper.mjs', optional && !isCI ? ['--optional'] : []);

/* ── manifest ──────────────────────────────────────────────────────────── */
const payloadDir = path.join(desktopRoot, 'dist', 'payload');
const rows = [];
const walk = (dir, prefix = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (['web', 'assets', 'runtime'].includes(entry.name) && prefix === '') {
        walk(path.join(dir, entry.name), rel);
      } else {
        const size = fs.readdirSync(path.join(dir, entry.name), { recursive: true }).length;
        rows.push([`${rel}/`, `${size} entries`]);
      }
    } else {
      rows.push([rel, `${(fs.statSync(path.join(dir, entry.name)).size / 1048576).toFixed(2)} MB`]);
    }
  }
};
walk(payloadDir);
console.log('\n[payload] manifest:');
for (const [name, size] of rows) console.log(`   ${name.padEnd(28)} ${size}`);

const haveRuntime = fs.existsSync(path.join(payloadDir, 'runtime', 'node.exe'));
const haveWrapper = fs.existsSync(path.join(desktopRoot, 'service', 'att-service.exe'));
if (!haveRuntime || !haveWrapper) {
  console.warn('\n[payload] WARNING: payload is incomplete:');
  if (!haveRuntime) console.warn('   - runtime/node.exe missing (installer would need Node on the PC)');
  if (!haveWrapper) console.warn('   - service/att-service.exe missing (background service unavailable)');
  if (isCI) process.exit(1);
}
console.log('\n[payload] OK — next: npm --prefix desktop run dist:win');
