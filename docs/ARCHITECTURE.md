# ATT — Architecture Overview

## 1. System topology

```mermaid
flowchart LR
    subgraph SchoolLAN["School LAN (192.168.1.0/24)"]
        ZK["🖐️ ZKTeco Terminal<br/>192.168.1.201 : 4370<br/>(fingerprint / RFID punches)"]
    end

    subgraph Server["ATT Server (Node.js)"]
        direction TB
        AD["Device Adapter<br/><i>RealZKDevice · MockZKDevice</i>"]
        CM["Connection Manager<br/>retries · backoff · circuit breaker"]
        PL["Background Poller<br/>every N minutes → get_attendance()"]
        PE["Processing Engine<br/>first/last punch → late & early calc"]
        DB[("SQLite<br/>attendance.db")]
        API["REST API<br/>Express /api/*"]
        ZK <--> |"TCP 4370<br/>ZK binary protocol"| AD
        AD --- CM --> PL --> PE
        PE --> DB
        PL --> DB
        DB --> API
    end

    subgraph Browser["Staff Browser"]
        UI["React SPA<br/>Dashboard · Attendance · Teachers · Shifts · Device"]
    end

    UI -->|"HTTP /api (proxied)"| API
```

## 2. Poll → Process → Present pipeline

```mermaid
sequenceDiagram
    participant D as ZKTeco Device
    participant M as Connection Manager
    participant P as Poller
    participant DB as SQLite
    participant E as Processing Engine
    participant U as React UI

    loop every N minutes (POLL_INTERVAL_MINUTES)
        P->>M: getAttendance()
        M->>D: TCP connect :4370 → pull log → disconnect (always)
        D-->>M: raw punches [{user_id, timestamp, punch_type}]
        M-->>P: normalized records
        P->>DB: INSERT OR IGNORE attendance_logs<br/>(unique: zk_user_id+punch_time+punch_type)
        P->>E: recompute affected (teacher, date)
        E->>DB: upsert processed_attendance<br/>check-in/out, late/early mins, status
    end
    U->>DB: GET /api/attendance/daily → badges & KPIs
```

## 3. Resilience model

| Concern | Mechanism | Where |
|---|---|---|
| Hung device / half-open socket | Hard timeout around every op | `zk/realDevice.js` → `withTimeout` |
| Device accepts few concurrent sessions | Connect → operate → **always disconnect** | `zk/realDevice.js` → `withConnection` |
| Transient network faults | Exponential backoff + jitter (3 attempts) | `zk/manager.js` → `call()` |
| Dead device hammering the network | Circuit breaker: opens after 5 consecutive failures, half-open probe after cool-down | `zk/manager.js` |
| Duplicate punches on re-poll | `UNIQUE(zk_user_id, punch_time, punch_type)` + `INSERT OR IGNORE` | `db/migrate.js`, `services/poller.js` |
| Unknown enrollment IDs punching | Stored with `teacher_id = NULL`, surfaced for import | `routes/device.js` → `/unknown-users` |
| Service downtime gaps | `ensureProcessed()` lazily back-fills missing days on view | `services/processor.js` |
| Shift edited after-the-fact | Last-30-days rebuild triggers automatically | `routes/shifts.js`, `routes/teachers.js` |

## 4. Data model (spec § 3)

```mermaid
erDiagram
    SHIFTS ||--o{ TEACHERS : assigned
    TEACHERS ||--o{ ATTENDANCE_LOGS : punches
    TEACHERS ||--o{ PROCESSED_ATTENDANCE : "daily summary"
    SHIFTS ||--o{ PROCESSED_ATTENDANCE : evaluated_against

    SHIFTS {
        int id PK
        text name
        text start_time      "HH:MM"
        text end_time        "HH:MM (end<start ⇒ overnight)"
        int grace_period_minutes
        int is_default
    }
    TEACHERS {
        int id PK
        text zk_user_id UK   "device Enrollment ID"
        text full_name
        text department
        text designation     "Teacher | Staff"
        int shift_id FK
        text email
        text phone
        text status          "active | inactive"
    }
    ATTENDANCE_LOGS {
        int id PK
        int teacher_id FK    "NULL when unmatched"
        text zk_user_id
        text punch_time      "device-local ISO"
        int punch_type       "raw device code"
        text source          "device | seed | manual"
    }
    PROCESSED_ATTENDANCE {
        int id PK
        int teacher_id FK
        text work_date       "YYYY-MM-DD"
        int shift_id FK
        text check_in        "first punch"
        text check_out       "last punch"
        int punch_count
        int late_minutes
        int early_minutes
        int work_minutes
        text status          "on_time | late | early | late_early | absent"
    }
```

## 5. Status algorithm (spec § C)

```
punches = sorted device punches for (teacher, date)
absent                if punches = ∅
checkIn  = first punch          checkOut = last punch (if ≥ 2 punches)
late     ⟺ checkIn  > start + grace        lateMinutes  = checkIn − start
early    ⟺ checkOut < end                  earlyMinutes = end    − checkOut
status = late_early | late | early | on_time
```

Tested in `server/test/attendanceLogic.test.js` (13 cases incl. overnight shifts,
stray mid-day punches, single-punch days, grace-boundary inclusivity).

## 6. ADMS alternative (push mode)

This build uses **pull mode** (server → device :4370), ideal for one site on the
same LAN. For multi-branch schools or NAT'd devices, run an ADMS push receiver
(device → server over HTTP): point the terminal's *Cloud/ADMS* server setting at
the API host and ingest `/iclock/cdata` pushes into the same
`attendance_logs` ingestion function used by the poller (`ingestDeviceRecords`),
so the processing engine, UI, and reports stay identical.

## 7. Project layout

```
ATT/
├── server/
│   ├── src/
│   │   ├── index.js                  boot: migrate→seed→manager→poller→API
│   │   ├── config.js                 env-driven configuration
│   │   ├── db/{connection,migrate,seed}.js
│   │   ├── utils/attendanceLogic.js  ★ pure status algorithm
│   │   ├── zk/{deviceContract,realDevice,mockDevice,manager}.js
│   │   ├── services/{poller,processor}.js
│   │   └── routes/{teachers,shifts,attendance,dashboard,device}.js
│   └── test/attendanceLogic.test.js
├── web/
│   └── src/{App.jsx, api/client.js, components/, pages/}
└── docs/ARCHITECTURE.md
```
