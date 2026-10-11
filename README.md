# ATT — ZKTeco·Integrated Attendance Tracking System

A complete attendance tracker for schools: it polls a **ZKTeco biometric
terminal** over TCP/IP, turns raw fingerprint punches into daily check-in /
check-out summaries, and flags **late arrivals** and **early departures
("fast going")** against configurable shifts — with a live dashboard, teacher
management, enrollment sync, and CSV reporting.

Ships as an **installable Windows application**: one installer puts the sync
engine, the database and the dashboard on any Windows 10/11 PC, connects that PC
to the terminal (with a guided wizard that scans your LAN for it), and keeps
pulling punches in the background — even as a Windows service before anyone
signs in. See **[docs/WINDOWS_APP.md](docs/WINDOWS_APP.md)**.

**This repository is production-configured by default**: it connects to real
hardware and never creates fake data. No demo seeding, no simulation — the
first boot gives you a clean database and a guided 3-step setup.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 · Vite 7 · Tailwind CSS v4 · Recharts · lucide-react |
| Backend | Node.js 22 · Express 4 |
| Hardware | `node-zklib` (ZKTeco TCP protocol on port 4370; direct or LAN-bridge mode) |
| Database | SQLite (`node:sqlite`, zero native deps — swappable for Postgres/MySQL) |
| Nepal calendar | Bikram Sambat (BS) conversion with Gregorian dates retained for device records |
| Windows app | Electron 44 · electron-builder (NSIS installer) · bundled Node LTS runtime · WinSW background service |

---

## Windows desktop app (install on any school PC)

1. Grab `ATT-Attendance-Setup-<version>.exe` from
   [GitHub Releases](https://github.com/PrinceTiwari00/ATT/releases) (built by
   GitHub Actions on every tag), or build it yourself with
   `node desktop/scripts/prepare-payload.mjs && npm --prefix desktop run dist:win`.
2. Install, tick *"run as a background service"* if you want sync before sign-in.
3. First launch opens the **Connect Device** wizard: it shows this PC's network,
   **scans the LAN for ZKTeco terminals**, verifies the link step-by-step
   (subnet → ping → TCP 4370 → handshake, with the exact fix for each failure)
   and then connects and starts syncing.

Everything is documented in **[docs/WINDOWS_APP.md](docs/WINDOWS_APP.md)** —
data lives in `C:\ProgramData\ATT`, one backend per PC is enforced by an
instance lock, and the tray icon shows device status all day.

## Production setup

### 1. Configure & connect your ZKTeco terminal — **[docs/HARDWARE_SETUP.md](docs/HARDWARE_SETUP.md)** ← start here

TL;DR: static IP on the terminal (`192.168.1.110`), port 4370 reachable from
the server, accurate device clock, and a **Comm Key both sides agree on**
(`0` works, a non-zero key is recommended — it stops other software from
stealing the terminal's single session; set it from *Device & Sync → Terminal
password*). Then:

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
pull logs, pull/import device users)**. The poller pulls new punches every
`POLL_INTERVAL_MINUTES` (default 1).

Enrollment flow: `node-zklib` 1.x can read users and logs but has **no API to
write users**, so people are enrolled on the terminal keypad and pulled in with
*Fetch device users → Import* (punches already in the ledger are linked and
their days rebuilt automatically). The Device page detects this and disables
the push button with the same explanation; if a future library version adds a
write API, `GET /api/device/status` reports it and the button re-enables.

For development hot-reload instead: `npm run dev` (API :4000 + Vite :5173).
A systemd unit and reverse-proxy notes are in
[HARDWARE_SETUP.md §8](docs/HARDWARE_SETUP.md).

### Render cloud deployment

This repo includes a Render Blueprint at [`render.yaml`](render.yaml) and a
LAN-side device agent. Render cannot connect directly to a private school
address, so deploy in bridge mode and run `npm --prefix server run agent` on an
always-on school machine that can reach the terminal. The agent uses outbound
HTTPS to sync punches, device users, and enrollment commands; no device port
is exposed publicly. Follow **[docs/RENDER.md](docs/RENDER.md)** to deploy and
pair it. The Blueprint creates a persistent disk and generates separate staff
login and bridge secrets.

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

## Monthly reports and the Nepal school calendar

ATT displays dates in **Bikram Sambat (BS)** alongside Gregorian (AD) dates;
ZKTeco punch timestamps and database keys remain Gregorian internally. The
**Monthly Reports** page selects a BS month and totals each staff member's
present/absent workdays, late arrivals and minutes, early departures and
minutes, and overtime. It also downloads a CSV. Future working days are not
counted as absences.

**Calendar & Holidays** lets the school set its weekly workdays (new installs
default to Monday–Friday) and maintain both one-off holidays and holidays that
repeat on a BS month/day each year. Weekends and named holidays are excluded
from absence totals. Holiday punches, if any, remain visible separately as
off-day work.

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
GET    /api/reports/monthly?bsYear&bsMonth            # BS monthly staff totals
GET    /api/calendar                                 # workweek + holiday definitions
PUT    /api/calendar/workdays {workingDays:[1,2,3,4,5]}
POST|PUT|DELETE /api/calendar/holidays[/:id]          # one-off or annual BS holiday
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
  network gotchas, enrollment workflows, and troubleshooting.
- **[docs/RENDER.md](docs/RENDER.md)** — Render Blueprint, persistent disk,
  secure LAN agent setup, and end-to-end device sync.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — choose a local or cloud topology.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — topology, sequence
  diagrams, resilience model (retries, circuit breaker, idempotent ingestion),
  ER diagram.
- `server/src/utils/attendanceLogic.js` — pure, unit-tested status algorithm
  (13 cases: `npm test`).
- `server/.env.example` — every configuration knob, documented.

Copyright © 2026 Prince Tiwari. All rights reserved.
