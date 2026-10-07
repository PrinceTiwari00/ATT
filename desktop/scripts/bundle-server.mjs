/**
 * Bundles the ENTIRE backend (Express API, SQLite layer, ZKTeco protocol,
 * poller, diagnostics) plus the built React dashboard into the payload that the
 * Windows app ships:
 *
 *   desktop/dist/payload/
 *       server.cjs          ← one file, runnable by a bare node.exe
 *       packaged.json       ← marker that switches config.js to installed mode
 *       web/                ← built SPA served by server.cjs on one port
 *       assets/             ← tray icons + window icon for the shell
 *
 * No node_modules on the target machine, no npm install at the school, no
 * native addons (the database is node:sqlite, built into Node itself).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const payloadDir = path.join(desktopRoot, 'dist', 'payload');

const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'package.json'), 'utf8')).version;

fs.mkdirSync(payloadDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(repoRoot, 'server', 'src', 'index.js')],
  outfile: path.join(payloadDir, 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false, // stack traces must stay readable in the school's log file
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  // The bundle has no package.json beside it, so stamp the version in.
  define: {
    'process.env.ATT_APP_VERSION': JSON.stringify(version),
  },
  banner: {
    js: [
      '/*!',
      ` * ATT Attendance — bundled backend ${version}`,
      ' * Single-file build: Express API + SQLite (node:sqlite) + ZKTeco TCP/4370',
      ' * protocol + poller + LAN discovery. Run with Node 22+:',
      ' *     node server.cjs            start the API (+ built dashboard)',
      ' *     node server.cjs --service  Windows background service mode',
      ' *     node server.cjs --doctor   connectivity / health report',
      ' */',
    ].join('\n'),
  },
});

if (result.errors?.length) process.exit(1);

// Marker the server looks for next to its own file (works for the WinSW
// service, which cannot pass environment variables reliably).
fs.writeFileSync(
  path.join(payloadDir, 'packaged.json'),
  `${JSON.stringify({ packaged: true, version, builtAt: new Date().toISOString() }, null, 2)}\n`
);

// ── built dashboard ───────────────────────────────────────────────────────
const webDist = path.join(repoRoot, 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('[bundle] web/dist is missing — run: npm --prefix ../web ci && npm --prefix ../web run build');
  process.exit(1);
}
fs.cpSync(webDist, path.join(payloadDir, 'web'), { recursive: true });

// ── shell assets the packaged app reads from the payload ──────────────────
fs.mkdirSync(path.join(payloadDir, 'assets', 'tray'), { recursive: true });
fs.cpSync(path.join(desktopRoot, 'assets', 'tray'), path.join(payloadDir, 'assets', 'tray'), { recursive: true });
for (const icon of ['icon.ico', 'icon.png']) {
  const src = path.join(desktopRoot, 'build', icon);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(payloadDir, 'assets', icon));
}

const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(2);
console.log(`[bundle] server.cjs   ${mb(path.join(payloadDir, 'server.cjs'))} MB`);
console.log(`[bundle] web/         ${fs.readdirSync(path.join(payloadDir, 'web')).length} files`);
console.log('[bundle] payload ready at', payloadDir);
