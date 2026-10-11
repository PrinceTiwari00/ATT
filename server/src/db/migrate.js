/**
 * Database schema blueprint — section 3 of the spec.
 *
 * Normalized schema (SQLite dialect; portable to PostgreSQL/MySQL with only
 * type-name tweaks). Four core tables + a small system table for sync cursors:
 *
 *   shifts                — working-shift definitions (start/end/grace)
 *   teachers              — teacher & staff profiles, mapped 1:1 to the
 *                           device's Enrollment/User ID via `zk_user_id`
 *   attendance_logs       — RAW, append-only punch events pulled from the
 *                           ZKTeco terminal (never mutated, idempotent unique key)
 *   processed_attendance  — one row per teacher per calendar day: resolved
 *                           check-in / check-out, late & early minutes, status
 *   sync_state            — key/value bookkeeping (last successful poll...)
 */
const { getDb } = require('./connection');

const MIGRATIONS = [
  {
    id: 1,
    name: 'init-schema',
    sql: `
      CREATE TABLE shifts (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        name                 TEXT    NOT NULL UNIQUE,
        start_time           TEXT    NOT NULL,              -- 'HH:MM' 24h, device-local
        end_time             TEXT    NOT NULL,              -- 'HH:MM' 24h (end < start => overnight)
        grace_period_minutes INTEGER NOT NULL DEFAULT 10 CHECK (grace_period_minutes >= 0),
        description          TEXT,
        is_default           INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE teachers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        zk_user_id  TEXT NOT NULL UNIQUE,                  -- ZKTeco Enrollment ID on the device
        full_name   TEXT NOT NULL,
        department  TEXT NOT NULL DEFAULT 'General',
        designation TEXT NOT NULL DEFAULT 'Teacher'
                    CHECK (designation IN ('Teacher', 'Staff')),
        shift_id    INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
        email       TEXT,
        phone       TEXT,
        status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX idx_teachers_department ON teachers(department);
      CREATE INDEX idx_teachers_status     ON teachers(status);

      CREATE TABLE attendance_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id  INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
        zk_user_id  TEXT    NOT NULL,             -- raw device user id (kept even if unmatched)
        device_sn   TEXT,                          -- device serial, when firmware reports it
        punch_time  TEXT    NOT NULL,              -- 'YYYY-MM-DDTHH:MM:SS' device-local
        punch_type  INTEGER NOT NULL DEFAULT 0,    -- raw device punch code (0=in,1=out,firmware-specific)
        source      TEXT    NOT NULL DEFAULT 'device',  -- device | manual | seed
        synced_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (zk_user_id, punch_time, punch_type)       -- idempotent re-polls
      );
      CREATE INDEX idx_logs_teacher_time ON attendance_logs(teacher_id, punch_time);
      CREATE INDEX idx_logs_zk_time      ON attendance_logs(zk_user_id, punch_time);

      CREATE TABLE processed_attendance (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id     INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
        work_date      TEXT    NOT NULL,          -- 'YYYY-MM-DD'
        shift_id       INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
        check_in       TEXT,                      -- first punch of the day
        check_out      TEXT,                      -- last punch of the day (NULL if single punch)
        punch_count    INTEGER NOT NULL DEFAULT 0,
        late_minutes   INTEGER NOT NULL DEFAULT 0,
        early_minutes  INTEGER NOT NULL DEFAULT 0,
        work_minutes   INTEGER,
        status         TEXT    NOT NULL
                       CHECK (status IN ('on_time','late','early','late_early','absent')),
        computed_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (teacher_id, work_date)
      );
      CREATE INDEX idx_processed_date   ON processed_attendance(work_date);
      CREATE INDEX idx_processed_status ON processed_attendance(status);

      CREATE TABLE sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `,
  },
  {
    id: 2,
    name: 'work-calendar',
    sql: `
      CREATE TABLE calendar_settings (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        working_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
        updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      INSERT INTO calendar_settings (id, working_days)
        VALUES (1, '[1,2,3,4,5]');

      CREATE TABLE calendar_holidays (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        name      TEXT NOT NULL,
        kind      TEXT NOT NULL CHECK (kind IN ('once', 'annual')),
        date      TEXT,
        bs_month  INTEGER,
        bs_day    INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        CHECK (
          (kind = 'once' AND date IS NOT NULL AND bs_month IS NULL AND bs_day IS NULL) OR
          (kind = 'annual' AND date IS NULL AND bs_month BETWEEN 1 AND 12 AND bs_day BETWEEN 1 AND 32)
        )
      );
      CREATE UNIQUE INDEX idx_calendar_holiday_once
        ON calendar_holidays(date) WHERE kind = 'once';
      CREATE UNIQUE INDEX idx_calendar_holiday_annual
        ON calendar_holidays(bs_month, bs_day) WHERE kind = 'annual';
    `,
  },
  {
    id: 3,
    name: 'calendar-day-overrides',
    sql: `
      -- A per-day school decision that beats every other rule: a regular
      -- holiday (or a weekly off) can be turned into a working day, and a
      -- working day can be pinned back to off. Holidays that carry a name keep
      -- living in calendar_holidays; this table only stores date exceptions.
      CREATE TABLE calendar_day_overrides (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        date       TEXT    NOT NULL UNIQUE,          -- 'YYYY-MM-DD'
        is_working INTEGER NOT NULL CHECK (is_working IN (0, 1)),
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `,
  },
];

function migrate() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );`);
  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((r) => r.id)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
      db.exec('COMMIT');
      console.log(`[db] migration applied: #${m.id} ${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

if (require.main === module) {
  migrate();
  console.log('[db] all migrations applied');
}

module.exports = { migrate };
