# ATT — ZKTeco·Integrated Attendance Tracking System

A complete web-based attendance tracker for schools: it polls a **ZKTeco
biometric terminal** over TCP/IP, turns raw fingerprint punches into daily
check-in / check-out summaries, and flags **late arrivals** and **early
departures ("fast going")** against configurable shifts — with a live
dashboard, teacher management, enrollment sync, and CSV reporting.

> No device handy? The built-in **hardware simulator** (`ZK_MODE=mock`) serves
> a fully deterministic synthetic day over the same pipeline, so you can run,
> demo, and test everything without a terminal.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 · Vite 7 · Tailwind CSS v4 · Recharts · lucide-react |
| Backend | Node.js 22 · Express 4 |
| Hardware | `node-zklib` (ZKTeco PUSH/TCP protocol on port 4370) |
| Database | SQLite (`node:sqlite`, zero native deps — swappable for Postgres/MySQL) |

## Quickstart

```bash
npm run install:all     # install server + web deps
npm run dev             # API on :4000 + UI on :5173 (UI proxies /api)
```

Open http://localhost:5173 — the first boot auto-migrates and seeds a demo
roster (15 teachers, 9 days of realistic punches + today). Run the unit tests
with `npm test`.

## Connecting a real ZKTeco terminal

1. Put the API host machine on the same LAN as the device.
2. On the terminal: **Menu → COMM → Ethernet** — static IP `192.168.1.201`
   (or your IP), **Comm Key = 0**, and note the TCP port (default **4370**).
3. Add a firewall/NAT pass for TCP 4370 to the API host if needed.
4. Configure the server and restart:

```bash
export ZK_MODE=real
export ZK_IP=192.168.1.201
export ZK_PORT=4370
npm --prefix server run dev
```

5. Open **Device & Sync** in the UI → **Test link** → then
   **Push all teachers → device** or **Fetch device users** to enroll/import.

The poller pulls `get_attendance()` every `POLL_INTERVAL_MINUTES` (default 1).
Reads are non-destructive — logs are never wiped from the terminal. For
push-mode / multi-site deployments see **ADMS** in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

## Configuration

All env vars (with defaults) are documented in
[server/.env.example](server/.env.example) — most useful: `ZK_MODE`,
`ZK_IP`/`ZK_PORT`, `POLL_INTERVAL_MINUTES`, `SEED_DEMO`, circuit-breaker
tunables, and `ZK_MOCK_DAY_MODE=live|complete` for simulator realism.

## Project docs

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — system topology, poll→
  process→present sequence, resilience model, ER diagram, ADMS notes.
- `server/src/utils/attendanceLogic.js` — the pure, unit-tested status algorithm.
- `server/src/zk/realDevice.js` — production device client (timeouts,
  guaranteed disconnects, defensive firmware field parsing).
