# Connecting Your ZKTeco Device to ATT

> **✅ This site's device (verified 2026-09-30):** ZKTeco **K14** @
> **`192.168.1.110:4370`** · firmware 4.0.1 (build 74) · ZKFinger VX10.0 ·
> SN `ONP6080486080200092` · DHCP **Off** · Comm Key (Password) **= 0**.
> Configuration screens below show exactly these values — the only remaining
> requirement is that the machine running the server is on the same
> `192.168.1.0/24` network (§ “Make the server reach the device”).

This system talks to the terminal over **TCP/IP pull mode** (server → device,
default port **4370**) using the same protocol as the official ZKTeco
management software. Follow the steps in order — each has a quick test.

---

## Make the server reach the device (the one hard requirement)

The ATT server must run on a machine **on the same LAN** as the terminal
(`192.168.1.0/24`) — e.g. the school office PC, a small always-on machine, or
any server with a route to that subnet. A cloud-hosted server cannot reach a
private `192.168.x.x` address; in that case use ADMS push mode (§7) or a VPN.

Verify from the server machine before starting the app:

```bash
# Linux / macOS
ping 192.168.1.110
nc -zv 192.168.1.110 4370
```
```powershell
# Windows PowerShell
ping 192.168.1.110
Test-NetConnection 192.168.1.110 -Port 4370      # TcpTestSucceeded : True
```

---

## 0. What you need

- A ZKTeco terminal with Ethernet/Wi-Fi (K40, iClock, MB/iface series, uFace, etc.)
- The machine running the ATT server on a network that can **route** to the device
- 5 minutes on the terminal's keypad (admin access required)

```
┌──────────────┐   ping / TCP 4370   ┌─────────────────┐
│ ATT server   │ ◄─────────────────► │ ZKTeco terminal │
│ (this app)   │                     │ 192.168.1.201   │
└──────────────┘                     └─────────────────┘
```

---

## 1. Configure the terminal (on the keypad screen)

Menu labels vary slightly by firmware — the setting names are the constants.

### 1.1 Give the device a **static IP**
`Menu → COMM → Ethernet` (or `Network → TCP/IP`):

| Setting | Value | Notes |
|---|---|---|
| IP Address | `192.168.1.201` | any free address on your LAN — keep this one |
| Subnet Mask | `255.255.255.0` | match your LAN |
| Gateway | `192.168.1.1` | your router |
| DHCP | **OFF** | a static IP that survives reboots is essential |

### 1.2 Set **Comm Key = 0**
`Menu → COMM → Comm Key` (some firmware: `Cloud/Security → Comm Key` or
`Connection → PC Connection → Comm Key`).

A non-zero comm key makes the device accept TCP connections and then
**reject every protocol command** — the classic symptom of
“connects but returns nothing”. Keep it `0` (LAN-trusted) and see §6 for
securing the network side instead.

### 1.3 Confirm the **TCP/IP port**
`Menu → COMM → Connection` — default **4370**. If you change it, set
`ZK_PORT` to match.

### 1.4 Set the **date & time**
`Menu → System → Date/Time`. Every punch is timestamped by the device’s own
clock — a drifting clock produces wrong “Late/Early” minutes.

✅ **Test:** from the server machine —
```bash
ping 192.168.1.201
nc -zv 192.168.1.201 4370        # or: telnet 192.168.1.201 4370
```
Both must succeed before touching the app.

---

## 2. Point the ATT server at the device

Set the environment (copy `server/.env.example` → `server/.env`, or export):

```bash
ZK_MODE=real                # production mode — talk to real hardware
ZK_IP=192.168.1.201
ZK_PORT=4370
POLL_INTERVAL_MINUTES=5     # how often logs are pulled
```

Restart the server. On boot you'll see `ZKTeco mode: real @ 192.168.1.201:4370`.

---

## 3. Verify the link from the UI

Open **Device & Sync** and click **Test link**:

- ✅ Handshake OK → you should see firmware + serial number.
- ❌ Failure → the on-screen checklist covers the usual causes
  (also see the Troubleshooting Matrix below).

Then click **Fetch logs now** — existing punches on the device appear in the
raw ledger within seconds. The background poller keeps pulling every
`POLL_INTERVAL_MINUTES` automatically; re-polls can never duplicate a punch
(database-enforced uniqueness).

> ⚠️ ZKTeco terminals allow very few concurrent management connections
> (often just one). **Close ZKTime/Attendance Management software** (and any
> other instance of this app) while ATT polls, or one side will win and the
> other will see timeouts.

---

## 4. Get teacher IDs onto / off the device

Every teacher profile carries `zk_user_id`, which must equal the terminal’s
**Enrollment ID** for that person. There are two synchronization directions:

**A. Device already has enrolled staff (typical):**
Device & Sync → **Fetch device users** → select → **Import**. Profiles are
created and bound to those IDs; their historical punches link automatically
(orphan punches are re-linked on import).

**B. You manage staff in the UI:**
Teachers & Staff → **Add Teacher/Staff** → tick
*“Also enroll this ID on the ZKTeco device”*, or use the fingerprint button
per row, or **Push all teachers → device** on the Device page. After that,
enroll fingerprints on the terminal under that same User ID
(`Menu → User Mgt → New User`, enter the ID shown in ATT).

---

## 5. Networking gotchas (90% of “it doesn’t connect” cases)

| Issue | Fix |
|---|---|
| Wi-Fi AP *client isolation* | Disable it, or wire the terminal via Ethernet |
| DHCP reservation changed the IP | Assign static IP on the device (§1.1) or reserve in the router |
| Different subnet/VLAN | Add a route or move the server to the same VLAN |
| Windows firewall on the server | Allow inbound TCP 4370 to Node |
| Device was just reconfigured | **Reboot the terminal** — network changes often need it |
| Another ZK software connected | Close it; the single session belongs to ATT |

---

## 6. Security notes (production)

- Never expose TCP 4370 to the internet — LAN/VLAN only.
- If you must cross untrusted networks, use **ADMS push mode** (§7) through a
  TLS reverse proxy instead of opening 4370 inbound.
- The permissive Comm Key = 0 is standard for LAN pull mode; compensate with
  network isolation (dedicated management VLAN is ideal).
- Keep `server/data/attendance.db` backed up (it's a single file).

---

## 7. Multi-branch / NAT — ADMS push mode

For devices outside the server’s LAN (other campuses behind NAT), use the
terminal's built-in **push** instead: `Menu → Cloud Server Settings` →
enable **ADMS**, set Server Address = your server's public IP/domain and its
port. The device then *pushes* punches over HTTP to endpoints
(`/iclock/cdata…`). This build ships pull mode; the ingestion point for
ADMS pushes feeds the same `attendance_logs` table — the processing engine
and UI are unchanged. See `docs/ARCHITECTURE.md → ADMS alternative`.

---

## 8. Production deployment (single server)

```bash
npm run install:all
npm run build            # builds web/dist (served by the API on :4000)
# systemd unit example:
#   [Service]
#   WorkingDirectory=/opt/att/server
#   Environment=ZK_MODE=real ZK_IP=192.168.1.201 ZK_PORT=4370
#   Environment=PORT=4000 DB_PATH=/var/lib/att/attendance.db POLL_INTERVAL_MINUTES=5
#   ExecStart=/usr/bin/node src/index.js
#   Restart=always
systemctl enable --now att
```

With `web/dist` present, the API serves the UI on the same port
(`http://<server-ip>:4000`) — no separate web server required.

---

## 9. Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| `ETIMEDOUT` / `EHOSTUNREACH` | Wrong IP, different subnet, no route, client isolation | §1.1, §5 ping test |
| `ECONNREFUSED` | Wrong port, or device needs reboot after config | §1.3, reboot terminal |
| Connects, then silent / errors on commands | Comm Key ≠ 0 | §1.2 |
| `getAttendance` returns 0 rows | Device memory genuinely empty, or logs were cleared | Enroll & punch on the terminal, then Fetch logs now |
| Push enrollment fails | `uid` field constraints vary by firmware | Enroll on the keypad instead, then Import (§4A) — always works |
| Wrong late/early minutes | Device clock drift | §1.4, then *Recompute* from the Attendance API |
| Everything was fine, now timeouts | Another management client stole the session | Close ZKTime/etc.; circuit breaker self-recovers in 1 min |
