/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  DATABASE BACKUPS
 * ─────────────────────────────────────────────────────────────────────────────
 *  The whole product lives in one SQLite file. A school that loses it loses
 *  years of attendance history, so the app offers a one-click backup that
 *  checkpoints the WAL and copies the database into <ATT_HOME>/backups,
 *  keeping the most recent N. Restoring is a documented file copy — never an
 *  automatic overwrite.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db/connection');

const KEEP = 10;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupDir() {
  fs.mkdirSync(config.paths.backupDir, { recursive: true });
  return config.paths.backupDir;
}

/** Copy the live database (WAL included) to a timestamped backup file. */
function createBackup({ label = 'manual' } = {}) {
  const dbFile = config.dbPath;
  if (!fs.existsSync(dbFile)) {
    const err = new Error(`No database to back up at ${dbFile}`);
    err.status = 404;
    throw err;
  }
  // Flush WAL so the copy is a self-contained snapshot.
  try {
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (err) {
    console.warn(`[backup] WAL checkpoint failed: ${err.message}`);
  }

  const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'manual';
  const target = path.join(backupDir(), `attendance-${stamp()}-${safeLabel}.db`);
  fs.copyFileSync(dbFile, target);

  // Sidecar files are only meaningful if the checkpoint failed; copy if present.
  for (const suffix of ['-wal', '-shm']) {
    const side = dbFile + suffix;
    if (fs.existsSync(side) && fs.statSync(side).size > 0) {
      try { fs.copyFileSync(side, target + suffix); } catch (_) { /* best effort */ }
    }
  }

  prune();
  return {
    ok: true,
    file: target,
    bytes: fs.statSync(target).size,
    at: new Date().toISOString(),
  };
}

function listBackups() {
  const dir = backupDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      return { file: full, name: f, bytes: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function prune() {
  const backups = listBackups();
  for (const old of backups.slice(KEEP)) {
    try {
      fs.rmSync(old.file, { force: true });
      for (const suffix of ['-wal', '-shm']) fs.rmSync(old.file + suffix, { force: true });
    } catch (_) { /* ignore */ }
  }
}

module.exports = { createBackup, listBackups, prune, backupDir };
