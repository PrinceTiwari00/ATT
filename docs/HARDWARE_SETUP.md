# Connecting Your ZKTeco Device to ATT

> **💡 Installed Windows app?** Skip the manual §2: open **Connect Device** in
> ATT. It shows this PC's networks, *scans the LAN for terminals on port 4370*,
> runs the checklist below as an interactive report (with the fix for each
> failure), and applies the new address without a restart.

> **✅ This site's device (verified 2026-09-30):** ZKTeco **K14** @
> **`192.168.1.110:4370`** · firmware 4.0.1 (build 74) · ZKFinger VX10.0 ·
> SN `ONP6080486080200092` · DHCP **Off** · Comm Key (Password) **= 0** as
> delivered — see §1.2 for why setting one is now recommended.
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

### 1.2 Set the **Comm Key** (the terminal's connection password)
`Menu → COMM → Comm Key` (some firmware: `Cloud/Security → Comm Key` or
`Connection → PC Connection → Comm Key`).

The Comm Key is the password a program must present after connecting. The
terminal serves **one management session**, so this setting decides what
happens when something *else* on the LAN tries to talk to it:

| Comm Key | Effect |
|---|---|
| `0` (factory) | The terminal answers **any** program: ZKTime, a vendor demo tool, a second ATT install. Whoever connects second kills the first session — `ECONNRESET` / *“Another device is connecting to the device so the connection is interrupted”*. |
| non-zero (e.g. `1`) | Every client that does not know the key is **refused at the handshake** and cannot take the session away from ATT. |

**Recommended for a school:** set a short key (`1`–`999999`, keep it typeable
on the keypad in case you ever need to recover the device) and save the same
value in ATT.

ATT supports a non-zero key natively — it performs the `CMD_CONNECT` →
`CMD_AUTH` handshake itself — and can change it for you:
**Device & Sync → Terminal password (Comm Key) → Set a key**. That flow reads
the current key from the device, writes the new one, then **logs in again to
verify**, and rolls the device back if verification fails, so it cannot lock
you out. “Check against terminal” compares the two sides without changing
anything.

> ⚠️ **Write the key down.** If ATT's copy and the device's copy disagree,
> every command is refused with `TIMEOUT_ON_WRITING_MESSAGE` or
> *“the terminal REJECTED Comm Key N”*. Recovery is on the keypad:
> `Menu → COMM → Comm Key` → set it to `0` (or to the number ATT has), then
> **Device & Sync → Check against terminal**.
>
> If the key was typed on the keypad and ATT does not know it yet, use
> **“ATT only”** in the same dialog — it saves the key without touching the
> device.

Changing the key does not affect anything already stored on the terminal, and
punches keep flowing. Reboot the device once after the change so any client
still holding a session under the old key is dropped.

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

> ⚠️ **One session at a time.** A ZKTeco terminal serves a single management
> connection. ATT enforces this on itself: every path to the hardware (poller,
> *Fetch logs now*, *Test link*, LAN discovery, teacher push, the bridge agent)
> goes through one process-wide **device session lock**, so ATT can never
> collide with itself. A second caller is refused instantly with
> `DEVICE_BUSY` / HTTP 409 *“the terminal is busy”* — that is protection
> working, not a failure — and the poller records it as a *skipped* cycle
> rather than a device error, so the circuit breaker is never tripped by it.
>
> The lock cannot see **other programs**. Close ZKTime / ZKAccess / vendor demo
> tools, and run only **one** ATT instance against a given terminal (if a cloud
> ATT and a local ATT both poll the same device, one of them must be switched
> to bridge mode). To lock other software out permanently, set a Comm Key
> (§1.2) — they will be refused at the handshake instead of stealing the
> session mid-sync.
>
> Tuning (env, rarely needed): `ZK_SESSION_GAP_MS` (default `350` — pause
> between sessions so the device can release the socket),
> `ZK_LOCK_STALE_MS` (default `120000` — a wedged session is force-released
> after this), `ZK_LOCK_WAIT_MS` (default `0` = refuse immediately; `>0` makes
> callers queue instead).

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
| Another ZK software connected | Close it; the single session belongs to ATT. Better: set a Comm Key (§1.2) so it is refused at the handshake |

---

## 6. Security notes (production)

- Never expose TCP 4370 to the internet — LAN/VLAN only.
- For a cloud-hosted ATT server, use the authenticated **LAN bridge agent**
  (§7 / [RENDER.md](RENDER.md)); do not try to route or forward port 4370.
- **Set a Comm Key** (§1.2) rather than leaving the factory `0`. It is the
  device's only authentication: with `0`, anything that can reach TCP 4370 can
  read every punch on the terminal *and* interrupt ATT's session. A key also
  stops other management software from stealing the single session.
  Combine it with network isolation (a dedicated management VLAN is ideal).
- The key is a shared secret — store it in `server/.env` (`ZK_COMM_KEY`) or in
  ATT settings, keep it out of version control, and treat it like a password.
  In bridge mode the cloud service sends the key with each queued command, so
  the LAN agent authenticates even when its own `.env` has none.
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
| Connects, then silent on every command (`TIMEOUT_ON_WRITING_MESSAGE`) | The terminal is waiting for a Comm Key ATT does not have, or another client owns the single session | §1.2 — *Device & Sync → Terminal password → Check against terminal*, then close other ZK software |
| *“the terminal REJECTED Comm Key N”* | ATT has a key, the device has a different one | Read the value on the keypad (`Menu → COMM → Comm Key`) and save it with **“ATT only”**, or write a fresh key from ATT |
| `ECONNRESET` / *“Another device is connecting to the device so the connection is interrupted”* | Another program (or a second ATT) took the terminal's only session mid-command | Close ZKTime/ZKAccess and any second ATT; set a Comm Key (§1.2) so they are refused instead. ATT's own paths are already serialised by the device lock |
| `DEVICE_BUSY` / HTTP 409 *“the terminal is busy”* in the UI | Working as designed — another ATT operation holds the session (the banner shows which one and for how long) | Wait a few seconds and retry; the poller skips the cycle and picks up on the next one |
| `zk.getAttendance is not a function` | Old build calling a method the library never had (`node-zklib` ships the plural `getAttendances`) | Update to ATT 1.0.1 or newer — the adapter now resolves the name the installed library actually exposes |
| Log pull returns 0 rows | Device memory genuinely empty, or logs were cleared | Enroll & punch on the terminal, then Fetch logs now |
| `[object Object]` in a device error | Old build stringified `node-zklib`'s `ZKError`, which is not an `Error` (its cause lives in `.err`) | Update to ATT 1.0.1 or newer — errors read e.g. *“IP of the device is refused (ECONNREFUSED)”* |
| “Push all teachers → device” is greyed out | The installed `node-zklib` (1.x) has no user-writing API, so ATT cannot enroll from software | That is expected: enroll on the terminal keypad, then **Fetch device users → Import** (§4A). Pulling punches is unaffected |
| Push enrollment fails on an older build | `uid` field constraints vary by firmware | Enroll on the keypad instead, then Import (§4A) — always works |
| Wrong late/early minutes | Device clock drift | §1.4, then *Recompute* from the Attendance API |
| Everything was fine, now timeouts | Another management client stole the session | Close ZKTime/etc. and set a Comm Key (§1.2); circuit breaker self-recovers in 1 min |
| Every ATT operation says the device is busy, forever | A wedged session was never released | The stale-holder watchdog force-releases after `ZK_LOCK_STALE_MS` (2 min). Restarting the ATT service clears it immediately; reboot the terminal if it still refuses connections |
