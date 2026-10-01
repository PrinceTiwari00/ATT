# ATT — ZKTeco·Integrated Attendance Tracking System

A complete web-based attendance tracker for schools: it polls a **ZKTeco
biometric terminal** over TCP/IP, turns raw fingerprint punches into daily
check-in / check-out summaries, and flags **late arrivals** and **early
departures ("fast going")** against configurable shifts — with a live
dashboard, teacher management, enrollment sync, and CSV reporting.

**This repository is production-configured by default**: it connects to real
hardware and never creates fake data. No demo seeding, no simulation — the
first boot gives you a clean database and a guided 3-step setup.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 · Vite 7 · Tailwind CSS v4 · Recharts · lucide-react |
| Backend | Node.js 22 · Express 4 |
| Hardware | `node-zklib` (ZKTeco PUSH/TCP protocol on port 4370) |
| Database | SQLite (`node:sqlite`, zero native deps — swappable for Postgres/MySQL) |

---

## Production setup

### 1. Configure & connect your ZKTeco terminal — **[docs/HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md)** ← start here

TL;DR: static IP on the terminal (`192.168.1.201`), **Comm Key = 0**, port
4370 reachable from the server, accurate device clock. Then:

```bash
cd server
cp .env.example .env          # set ZK_IP / ZK_PORT to your terminal
```

### 2. Install & run

```bash
npm run install:all           # web + server dependencies
npm run build                 # builds web/dist (API will serve it on :4000)
npm --prefix server start     # API on :4000 — UI + API on ONE port
```

First boot auto-migrates an empty database and opens on the guided setup:
**Shifts → Teachers (Add or Import-from-device) → Device & Sync (Test link,
push/pull enrollments)**. The poller pulls new punches every
`POLL_INTERVAL_MINUTES` (default 1).

For development hot-reload instead: `npm run dev` (API :4000 + Vite :5173).
A systemd unit and reverse-proxy notes are in
[HARDWARE_SETUP.md §8](docs/HARDWARE_SETUP.md).

## How statuses are computed

For each teacher and day (from `processed_attendance`):

| Status | Rule (shift `start`–`end`, grace `g`) |
|---|---|
| 🟢 On time | first punch ≤ start+g **and** last punch ≥ end |
| 🔴 Late | first punch > start+g — badge shows lateness from scheduled start |
| 🟣 Early departure | last punch < end — badge shows minutes under end |
| ⚫ Absent | no punches that day |

Middle-of-day stray punches are ignored (first/last rule); single-punch days
are flagged **OPEN**. Overnight shifts (end ≤ start) roll to the next day.
The raw punch ledger is never modified or wiped — reports are always
rebuildable (`POST /api/attendance/recompute`).

## Developing without a device (optional)

A hardware simulator is included strictly for development/demos — it is
**OFF by default**. To run the whole stack with a fake terminal and fake
roster on an empty DB:

```bash
export ZK_MODE=mock SEED_DEMO=true
npm run dev
# or on an existing install: npm run seed:demo
```

## REST API (selected)

```
GET    /api/dashboard/summary?date=YYYY-MM-DD
GET    /api/attendance/daily?from&to&q&department&status
GET    /api/attendance/logs?date&zk_user_id          # raw punch ledger
POST   /api/attendance/recompute  {from,to}
GET|POST/PUT|DELETE /api/teachers[/:id]
POST   /api/teachers/:id/push-to-device
GET|POST/PUT|DELETE /api/shifts[/:id]
GET    /api/device/status                            # circuit breaker, poller, counts
POST   /api/device/test · /api/device/sync-now
GET    /api/device/users                             → device memory
POST   /api/device/users/import   {users:[{userId,name}]}
POST   /api/device/users/push-all
GET    /api/device/unknown-users                     # unmapped punching IDs
```

## Project docs

- **[docs/HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md)** — device keypad config,
  network gotchas, enrollment workflows, ADMS push mode, troubleshooting matrix.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — topology, sequence
  diagrams, resilience model (retries, circuit breaker, idempotent ingestion),
  ER diagram.
- `server/src/utils/attendanceLogic.js` — pure, unit-tested status algorithm
  (13 cases: `npm test`).
- `server/.env.example` — every configuration knob, documented.
