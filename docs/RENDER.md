# Deploy ATT to Render and sync a school device

Render can host the ATT dashboard/API, but it cannot open a connection to a
terminal at a private address such as `192.168.1.110`. This repository uses a
small **LAN-side bridge agent** to connect the cloud app to the existing
ZKTeco pull-mode protocol. The K14 stays private; no ADMS firmware feature or
router port-forward is needed.

```text
Browser ──HTTPS──> Render: ATT web app + API + SQLite disk
                         ▲
                         │ outbound HTTPS (bridge token)
                         │
School PC ──TCP 4370──> ZKTeco terminal
  bridge agent
```

The cloud app queues device operations; the agent claims them, performs them
on the school LAN with the same `node-zklib` adapter, and posts the result
back. Attendance still goes through ATT's normal idempotent poller. User
imports, test-link, manual sync, and teacher enrollment pushes are bridged too.

## 1. Create the Render service

1. Push this repository to GitHub and choose **New → Blueprint** in Render.
2. Select the repository and apply the checked-in `render.yaml`.
3. The Blueprint builds the React UI and Node API together, pins Node 22,
   creates a paid Starter web service, and mounts a 1 GB persistent disk at
   `/var/data` for `attendance.db`.
4. Wait for the deploy and note the service URL, for example
   `https://att-attendance.onrender.com`.
5. In the service's **Environment** page, retrieve the generated
   `APP_PASSWORD` and `DEVICE_BRIDGE_TOKEN`. The password is for staff sign-in;
   the bridge token is only for the trusted school agent. Do not put either in
   Git, a browser, or a public support message.

The Blueprint sets `ZK_MODE=bridge`, `DB_PATH=/var/data/attendance.db`, and
`POLL_ENABLED=true`. If your terminal is not at `192.168.1.110`, update
`ZK_IP` in the Render service environment and in the local agent's environment.
The IP is shown in the UI; only the LAN agent actually opens a TCP connection
to it.

> Use a Render plan that supports persistent disks and does not regularly
> sleep. The included Starter plan is paid. A free/ephemeral service is not
> suitable for a live attendance database or reliable background polling.
> Keep this SQLite-backed service at one instance; one disk cannot be shared
> safely by multiple app instances.

## 2. Run the bridge agent at school

Choose an always-on Windows PC, Linux server, or Raspberry Pi that is on the
same LAN/VLAN as the terminal. Install Node.js 22 and verify that this machine
can reach the device (`Test-NetConnection 192.168.1.110 -Port 4370` on Windows,
or `nc -zv 192.168.1.110 4370` on Linux). Close other ZKTeco management
software while testing.

Get the same ATT repository version on that machine and install the server
dependencies:

```bash
npm ci --prefix server
```

Set these environment variables on the school machine. Copy the token from the
Render service environment; do not copy it into a committed `.env` file.

**Windows PowerShell:**

```powershell
$env:ATT_API_URL = "https://att-attendance.onrender.com"
$env:DEVICE_BRIDGE_TOKEN = "paste-the-Render-generated-token-here"
$env:ZK_IP = "192.168.1.110"
$env:ZK_PORT = "4370"
npm --prefix server run agent
```

**Linux/macOS:**

```bash
ATT_API_URL="https://att-attendance.onrender.com" \
DEVICE_BRIDGE_TOKEN="paste-the-Render-generated-token-here" \
ZK_IP="192.168.1.110" ZK_PORT=4370 \
npm --prefix server run agent
```

The agent should log that it has connected to ATT and poll the cloud every few
seconds. It only initiates outbound HTTPS to Render. The school firewall does
not need an inbound rule, and **TCP 4370 must never be forwarded to the
internet**.

### Keep the agent running after reboot (Linux/systemd)

Put the URL, token, and device IP in a root-protected environment file (do not
commit it):

```ini
# /etc/att-device-bridge.env (chmod 600; owner root)
ATT_API_URL=https://att-attendance.onrender.com
DEVICE_BRIDGE_TOKEN=copy-the-generated-secret-from-Render
ZK_IP=192.168.1.110
ZK_PORT=4370
```

Then create `/etc/systemd/system/att-device-bridge.service`:

```ini
[Unit]
Description=ATT ZKTeco LAN bridge agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=att
WorkingDirectory=/opt/att
EnvironmentFile=/etc/att-device-bridge.env
ExecStart=/usr/bin/node /opt/att/server/src/agent.js
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Adjust the `User`, checkout directory, and Node binary path for the school
machine, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now att-device-bridge
```

For Windows, create a Task Scheduler task **At startup** that runs
`node.exe C:\ATT\server\src\agent.js` with working directory
`C:\ATT\server`, under the same Windows account that holds `ATT_API_URL`,
`DEVICE_BRIDGE_TOKEN`, `ZK_IP`, and `ZK_PORT` environment variables.

## 3. Verify end-to-end sync

1. Open the Render URL and sign in with `APP_PASSWORD`.
2. Open **Device & Sync**. The **School LAN agent** row should say `online`.
3. Click **Test link**. The device firmware/serial details should appear.
4. Click **Fetch logs now** to import current device punches. Automatic polling
   continues at `POLL_INTERVAL_MINUTES` (one minute by default).
5. Use **Fetch device users** to import existing enrollment IDs, or add staff
   in ATT and choose **Push all teachers → device**.

Punches are read non-destructively and de-duplicated in the database. Keep the
terminal's clock accurate and Comm Key set to `0` for the tested K14; see
[HARDWARE_SETUP.md](HARDWARE_SETUP.md) for device configuration.

## Troubleshooting

| Symptom | Check |
|---|---|
| School LAN agent is offline | Agent process is running; `ATT_API_URL` is the HTTPS Render URL; the exact same `DEVICE_BRIDGE_TOKEN` is set on Render and the agent; Render service is awake/healthy. |
| Agent online, Test link fails | From the agent host, test `ZK_IP:ZK_PORT`; check static device IP, VLAN/client isolation, Comm Key `0`, and that ZKTime/another client is disconnected. |
| Attendance is empty | Click **Fetch logs now**; confirm punches exist in terminal memory and that its clock is correct. |
| Enrollment push fails | Check the ZKTeco firmware's user-ID constraints; some models require fingerprint capture on the keypad after ATT creates the user ID. |
| Agent reports unauthorized | Rotate/fix the token in Render and the local agent, then restart the agent. Do not share it with staff browsers. |

The public UI/API is protected by the generated `APP_PASSWORD`. The bridge API
uses a separate token and is mounted independently of interactive login.
`/api/health` is deliberately public for Render health checks; it returns no
school or device data.
