# ATT for Windows — the installable desktop application

> **What this is:** the whole attendance system (ZKTeco sync engine, SQLite
> database, dashboard UI) packaged as one Windows installer,
> `ATT-Attendance-Setup-<version>.exe`. Install it on any Windows 10/11 x64
> computer on the school network — nothing else to install, no Node.js, no
> database server, no browser setup. The computer then **connects directly to
> your ZKTeco terminal** over TCP 4370 and keeps pulling punches all day.

```text
┌─────────────────────────────── this computer ───────────────────────────────┐
│  ATT Attendance.exe   (window + tray)                                        │
│        │                                                                     │
│        ├─ bundled Node runtime ── server.cjs ── SQLite (C:\ProgramData\ATT)  │
│        │                                  │                                  │
│        └─ dashboard UI (served on :4000)  │  TCP 4370                        │
│                                           ▼                                  │
│                                   🖐️ ZKTeco terminal                         │
└──────────────────────────────────────────────────────────────────────────────┘
        other staff PCs can open http://<this-computer>:4000 (optional)
```

---

## 1. Get the installer

| Source | How |
|---|---|
| **GitHub Release** (recommended) | Every tag `v*` is built by GitHub Actions → *Releases → ATT for Windows → `ATT-Attendance-Setup-*.exe`* |
| **Build it yourself** | On any Windows machine: see §9 |

The build is reproducible from this repository: the workflow
[`.github/workflows/windows-installer.yml`](../.github/workflows/windows-installer.yml)
assembles the payload (backend bundle + built dashboard + bundled Node runtime +
WinSW service wrapper), runs the test suite on Windows, and packs the NSIS
installer.

## 2. Install

1. Run `ATT-Attendance-Setup-<version>.exe` (per-machine install, ~1 minute).
2. Choose the install directory (default `C:\Program Files\ATT Attendance`).
3. **Background sync & network** page:
   - ☑ *Run ATT in the background as a Windows service* — keeps syncing at boot,
     while the PC is locked and when nobody is signed in. Recommended. Can be
     changed later in **ATT → Settings → Windows app**.
   - ☑ *Let other computers on the school network open this dashboard* — adds a
     Windows Firewall rule (private/domain profiles only, TCP 4000 inbound).
4. Finish → ATT launches and opens the **connection wizard** on first run.

What the installer writes:

| Location | Contents |
|---|---|
| `C:\Program Files\ATT Attendance\` | the app, bundled Node runtime, `server.cjs`, dashboard, service wrapper |
| `C:\ProgramData\ATT\` | `config.json` (settings), `attendance.db`, `logs\`, `backups\` — **shared by the app and the service** |
| Start menu + desktop | shortcuts |
| Windows service | `ATT Attendance Sync` (optional, automatic start) |
| Firewall rule | `ATT Attendance` (optional) |

> Permissions: the installer grants *Modify* on `C:\ProgramData\ATT` to standard
> users (`icacls … *S-1-5-32-545:(OI)(CI)M`). Without that, the database created
> by the LocalSystem service would be read-only for the signed-in user.

## 3. Connect the computer to the attendance device

First run lands on **Connect Device** (also: sidebar → *Connect Device*). It is
three steps, each with its own verification:

1. **This computer on the network** — shows every IPv4 address of the PC with its
   subnet and gateway, and whether the terminal's IP is on the same network.
   (The terminal wants a static IP on the same subnet: keypad
   `Menu → COMM → Ethernet`, DHCP **off** — see
   [HARDWARE_SETUP.md](HARDWARE_SETUP.md).)
2. **Locate the ZKTeco terminal** — type the IP, or press **Scan my network**:
   ATT sweeps your subnet for anything answering on port 4370 and shows model,
   serial and firmware of every real terminal it finds. *Use this device* fills
   the form.
3. **Verify, then connect** —
   - **Diagnostics** runs the full checklist: local interface → subnet relation →
     ICMP → TCP 4370 → ZKTeco handshake. Every failed step lists the exact fix
     (Comm Key mismatch, AP client isolation, missing route, stolen session…).
     Diagnostics never opens a second session while a sync is running — it
     reports the terminal as busy instead.
   - **Test handshake** confirms the protocol answers before anything is saved.
   - **Save & connect** persists the settings, re-points the poller *live* (no
     restart), and pulls the first batch of punches immediately.

The tray icon then shows the truth at a glance: 🟢 device online (with last sync
time) or 🔴 offline. Right-click → *Sync now*, *Run connection diagnostics*.

## 4. Day-to-day operation

- **Window** — the dashboard: today's KPIs, attendance log, teachers, shifts,
  device page, and the new *Connect Device* / *Settings* pages.
- **Tray** — ATT lives here. Closing the window keeps it running
  (Settings → *Keep running when the window is closed*).
- **Start with Windows** — on by default; toggle in Settings or the tray menu.
- **Other staff PCs** — open `http://<this-computer>:4000` in any browser when the
  firewall rule is enabled. Set **Settings → Access control → password** before
  exposing the PC beyond the school LAN.
- **Backups** — Settings → *Backup now* snapshots the database into
  `C:\ProgramData\ATT\backups` (last 10 kept). Restoring = stop ATT, copy the
  file back over `attendance.db`, start ATT.

## 5. The background Windows service

`ATT Attendance Sync` (WinSW wrapper) runs the **same** `server.cjs` as the
desktop app, as LocalSystem:

| Question | Answer |
|---|---|
| Starts when? | At boot (delayed auto-start), before sign-in |
| Survives crashes? | Yes — restarts after 10 s, then 60 s |
| Who owns the device link? | Whoever started first. `C:\ProgramData\ATT\runtime.json` is the lock: a second backend refuses to boot (exit code 3) and the desktop app attaches to the running one instead |
| Logs | `C:\ProgramData\ATT\logs\att.log` (engine) and `C:\Program Files\ATT Attendance\logs\att-service.out.log` (wrapper) |
| Control | tray menu, Settings page, or an elevated terminal: `att-service.exe install|start|stop|restart|uninstall` in `C:\Program Files\ATT Attendance\resources\service\` |

Because the desktop app detects a running service, **only one poller ever runs**
— the terminal's single management session is never fought over.

## 6. Where everything lives

```text
C:\ProgramData\ATT\
├── config.json        settings written by the UI (device, poller, desktop prefs)
├── attendance.db      the attendance database (SQLite, WAL)
├── runtime.json       which backend owns the port (instance lock + local token)
├── logs\att.log       rotating engine log (Settings → Engine log)
├── logs\desktop.log   Electron shell log
└── backups\           attendance-<timestamp>-<label>.db snapshots
```

Precedence of configuration: real environment variables → `config.json` →
defaults. On a cloud/systemd deployment an explicit env var is therefore still
the operator's decision and the UI refuses to shadow it.

## 7. Updates

1. Download the new `ATT-Attendance-Setup-<version>.exe` and run it over the old
   install. The installer stops the service first, replaces the payload, and
   restarts it; **your database and settings are untouched**.
2. The app links to the release page from *Help → Check for updates…*
   (there is no silent auto-updater; school IT keeps control of when a machine
   changes).

## 8. Uninstall

*Settings → Apps → ATT Attendance → Uninstall* (or the Start-menu entry).
The uninstaller stops and removes the service and the firewall rule, then asks
whether to delete `C:\ProgramData\ATT`. **Choosing "No" keeps all attendance
history** — reinstalling later picks it up again.

## 9. Build the installer yourself

On any Windows 10/11 x64 machine with Node 22+ and Git:

```powershell
git clone https://github.com/PrinceTiwari00/ATT.git
cd ATT
npm ci --prefix server
npm ci --prefix web   && npm run build --prefix web
npm ci --prefix desktop                       # downloads Electron + esbuild + sharp
node desktop/scripts/prepare-payload.mjs      # assets + bundle + Node runtime + WinSW
npm --prefix desktop run dist:win             # → desktop/release/ATT-Attendance-Setup-*.exe
```

`prepare-payload.mjs` downloads the official Node.js LTS runtime (version pinned
by `.node-version`) and the WinSW service wrapper, bundles the backend into a
single `server.cjs` (esbuild), builds the tray/icon assets and copies the
dashboard. The CI workflow runs exactly these steps plus the test suite.

Signing: builds are unsigned by default. With a code-signing certificate set
`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` in the workflow environment and
electron-builder will sign the installer and the app.

## 10. Troubleshooting (Windows-specific)

| Symptom | Fix |
|---|---|
| Splash says *no usable Node.js runtime* | Reinstall (the installer bundles `runtime\node.exe`), or set `ATT_NODE_BIN` to a Node ≥ 22 `node.exe` |
| Second window says ATT is already running | Correct — one backend per PC. Use the existing window, or stop the service first |
| Tray icon red after a reboot with the service installed | `sc query ATTAttendance`, then *Settings → Windows app → Start*; check `att-service.out.log` |
| Dashboard fine but *Device Offline* | Connect Device → Diagnostics; most causes are listed in [HARDWARE_SETUP.md §5](HARDWARE_SETUP.md) |
| Another PC cannot open `http://<this-pc>:4000` | Re-run the installer and tick the firewall checkbox, or add the rule manually: `netsh advfirewall firewall add rule name="ATT Attendance" dir=in action=allow protocol=TCP localport=4000 profile=private,domain` |
| `C:\ProgramData\ATT` is read-only for a user | `icacls "C:\ProgramData\ATT" /grant *S-1-5-32-545:(OI)(CI)M /T` (the installer does this) |
| Everything was fine, now timeouts | Another ZK software took the terminal's single session — close it; the circuit breaker recovers on its own |
