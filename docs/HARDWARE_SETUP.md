# Connecting Your ZKTeco Device to ATT

> **💡 Installed Windows app?** Skip the manual §2: open **Connect Device** in
> ATT. It shows this PC's networks, *scans the LAN for terminals on port 4370*,
> runs the checklist below as an interactive report (with the fix for each
> failure), and applies the new address without a restart.

> **✅ This site's device (verified 2026-09-30):** ZKTeco **K14** @
> **`192.168.1.110:4370`** · firmware 4.0.1 (build 74) · ZKFinger VX10.0 ·
> SN `ONP6080486080200092` · DHCP **Off** · Comm Key (Password) **= 0**.
> Configuration screens below show the verified device values. In direct
> mode the server needs a route to `192.168.1.0/24`; for Render/cloud mode run
> the bridge agent on a school-LAN machine that has that route.

This system talks to the terminal over **TCP/IP pull mode** (server → device,
default port **4370**) using the same protocol as the official ZKTeco
management software. Follow the steps in order — each has a quick test.

---

## Choose how the app reaches the device

For direct mode (`ZK_MODE=real`), the ATT server must run on a machine that can
route to the terminal's private LAN address (`192.168.1.0/24`). Verify from
that server machine before starting the app:

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

For a cloud-hosted app such as Render, do **not** expect the cloud server to
reach that private address. Run the included `server/src/agent.js` on an
always-on school machine that passes this test; set the cloud app to
`ZK_MODE=bridge` and follow [RENDER.md](RENDER.md). The agent makes outbound
HTTPS requests, so no port-forward or ADMS support is required.

---

## 0. What you need

- A ZKTeco terminal with Ethernet/Wi-Fi (K40, iClock, MB/iface series, uFace, etc.)
- Direct mode: the ATT server host can **route** to the device; cloud mode: the LAN agent host can **route** to it
- 5 minutes on the terminal's keypad (admin access required)

```
┌──────────────┐   ping / TCP 4370   ┌─────────────────┐
│ ATT server   │ ◄─────────────────► │ ZKTeco terminal │
│ (this app)   │                     │ 192.168.1.110   │
└──────────────┘                     └─────────────────┘
```

---

## 1. Configure the terminal (on the keypad screen)

Menu labels vary slightly by firmware — the setting names are the constants.

### 1.1 Give the device a **static IP**
`Menu → COMM → Ethernet` (or `Network → TCP/IP`):

| Setting | Value | Notes |
|---|---|---|
| IP Address | `192.168.1.110` | any free address on your LAN — keep this one |
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
ping 192.168.1.110
nc -zv 192.168.1.110 4370        # or: telnet 192.168.1.110 4370
```
Both must succeed before touching the app.

---

## 2. Point the ATT server at the device

Set the environment (copy `server/.env.example` → `server/.env`, or export):

```bash
ZK_MODE=real                # direct mode — server runs on the device LAN
ZK_IP=192.168.1.110
ZK_PORT=4370
POLL_INTERVAL_MINUTES=5     # how often logs are pulled
```

For Render/cloud hosting, set `ZK_MODE=bridge` and a shared
`DEVICE_BRIDGE_TOKEN` on the cloud service, then run the `agent` script on the
LAN machine with `ATT_API_URL`, the same token, and its local `ZK_IP`/`ZK_PORT`.
See [RENDER.md](RENDER.md) for complete setup.

Restart the direct-mode server. On boot you'll see `ZKTeco mode: real @ 192.168.1.110:4370`.

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
| Firewall / endpoint security | Allow the server or bridge host to open outbound TCP 4370 to the terminal |
| Device was just reconfigured | **Reboot the terminal** — network changes often need it |
| Another ZK software connected | Close it; the single session belongs to ATT |

---

## 6. Security notes (production)

- Never expose TCP 4370 to the internet — LAN/VLAN only.
- For a cloud-hosted ATT server, use the authenticated **LAN bridge agent**
  (§7 / [RENDER.md](RENDER.md)); do not try to route or forward port 4370.
- The permissive Comm Key = 0 is standard for LAN pull mode; compensate with
  network isolation (dedicated management VLAN is ideal).
- Keep `server/data/attendance.db` backed up (it's a single file).

---

## 7. Cloud / NAT — outbound LAN bridge

This K14 firmware (4.0.1) has no ADMS push mode. For a cloud-hosted ATT
instance, keep the device private and run the included bridge agent on a
machine on the school LAN. The cloud service queues allowed operations and the
agent polls over outbound HTTPS, then reads punches and user records over TCP
4370 locally. No inbound port-forward is needed.

See [RENDER.md](RENDER.md) for the Render deployment and agent setup. Other
ZKTeco families may have ADMS support, but this repository does not currently
include an ADMS receiver; use the LAN bridge unless a device-specific receiver
has been added and tested.

---

## 8. Production deployment (single server)

```bash
npm run install:all
npm run build            # builds web/dist (served by the API on :4000)
# systemd unit example:
#   [Service]
#   WorkingDirectory=/opt/att/server
#   Environment=ZK_MODE=real ZK_IP=192.168.1.110 ZK_PORT=4370
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
