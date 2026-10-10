# Deployment options

ATT can run beside the ZKTeco terminal or in the cloud. The terminal itself
stays on the private school LAN in both cases; **never expose TCP 4370 to the
internet**.

## Option 0 (recommended for a single school PC): the Windows desktop app

Install `ATT-Attendance-Setup-<version>.exe` (see
[WINDOWS_APP.md](WINDOWS_APP.md)) on any Windows 10/11 x64 computer that can
reach the terminal. The installer bundles the Node runtime, the sync engine and
the dashboard; a first-run wizard connects the machine to the terminal (with a
LAN scan and full diagnostics), and an optional Windows service keeps syncing at
boot, while locked, and when nobody is signed in. Data stays in
`C:\ProgramData\ATT`; other staff PCs may open `http://<this-pc>:4000`.

This is the same backend as Option 1, packaged: one `server.cjs` bundle, one
SQLite file, one instance per computer (enforced by
`<ATT_HOME>/runtime.json`).

## Option 1 (simplest): run ATT on the school LAN

Use this when an always-on school machine can run the web app and reach the
terminal directly. Configure `ZK_MODE=real`, `ZK_IP` and `ZK_PORT`, then follow
[HARDWARE_SETUP.md](HARDWARE_SETUP.md). Staff can open the app at the school
machine's LAN address. For secure remote staff access, use Tailscale or a
proper HTTPS reverse proxy and set `APP_PASSWORD`.

## Option 2: Render cloud app + on-site device bridge

Use this when the app should have a public HTTPS URL. Render cannot route to a
private `192.168.x.x` device IP. ATT therefore includes a small LAN-side agent:

```text
staff browser ──HTTPS──> Render (ATT UI + API + persistent SQLite)
                              ▲
                              │ outbound HTTPS polling / commands
                              │
school PC running agent ──TCP 4370──> ZKTeco terminal
```

Deploy with the checked-in [`render.yaml`](../render.yaml) Blueprint and follow
[RENDER.md](RENDER.md). The agent runs on an always-on machine that can reach
the terminal. It polls punches and enrollments through the existing ATT
adapter, and executes enrollment pushes requested from the cloud UI. It only
makes outbound HTTPS connections; there is no router port-forward and no
inbound connection to the school network.

### Cloud security and persistence

- The Render Blueprint creates a paid Starter web service with a 1 GB
  persistent disk mounted at `/var/data`; SQLite uses `/var/data/attendance.db`.
  Do not scale this single-disk SQLite service to multiple instances.
- Render generates both `APP_PASSWORD` (for staff sign-in) and
  `DEVICE_BRIDGE_TOKEN` (for the LAN agent). Keep these secrets out of Git and
  share the bridge token only with the trusted school machine.
- Keep TCP 4370 LAN-only. The bridge protocol is protected with HTTPS and a
  separate shared secret; do not substitute an unencrypted public URL.

## Public exposure from a school-hosted server

If using Option 1 with a public IP or tunnel, set `APP_PASSWORD` before
exposing the app. For a tunnel, prefer Tailscale Funnel or a TLS reverse proxy.
Never forward the device's TCP 4370 port. See [HARDWARE_SETUP.md](HARDWARE_SETUP.md)
for local-server setup and the Render bridge guide for cloud hosting.
