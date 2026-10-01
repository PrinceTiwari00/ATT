# Deploying ATT — School Machine + Access from Anywhere

## The topology (why the cloud preview can't reach your K14)

```
INTERNET                         SCHOOL LAN (private)
─────────                        ─────────────────────
cloud preview ☁️   ✗✗✗           K14 @ 192.168.1.110
                                  ↕ TCP 4370
                                 ATT server ← must live here
                                  ↑
                open UI from: school PCs (LAN address)
                              your phone/laptop (via Tailscale, Option A)
                              anyone (port-forward, Option B — only with a password set)
```

The K14 lives on a **private** `192.168.x.x` address that cannot be routed to
from the public internet — no cloud-hosted instance can ever reach it. The
server must run **inside the school network**; you then reach *the server*
remotely (not the device).

---

## Option A (recommended): school machine + Tailscale

Secure, no router changes, works around dynamic school IPs.

### A.1 Run the server at school (any always-on machine)

An office Windows PC, old laptop, or a $35 Raspberry Pi — anything always
powered and on the school LAN.

```powershell
# 1. Install Node.js 22 LTS (nodejs.org) and Git (git-scm.com), then:
git clone https://github.com/PrinceTiwari00/ATT.git
cd ATT
git checkout arena/01a0f110-att
npm run install:all
npm run build
npm --prefix server start
```

The server is preconfigured for your device (`server/.env`: `192.168.1.110:4370`).

### A.2 Verify the device link (school machine)

```powershell
Test-NetConnection 192.168.1.110 -Port 4370     # TcpTestSucceeded : True
```
Open `http://localhost:4000` → **Device & Sync → Test link** → you should see
`SN ONP6080486080200092`. Staff on school PCs use
`http://<school-machine-lan-ip>:4000`.

### A.3 Access it from anywhere (phone, home laptop) — Tailscale

1. On the school machine: install **Tailscale** (tailscale.com → "Get Started"
   → sign in with any Google/Microsoft account). Note its `100.x.x.x` IP
   (system tray icon, or `tailscale ip -4`).
2. On your phone/laptop: install the Tailscale app, sign in with the **same
   account**.
3. From anywhere: open `http://100.x.x.x:4000`. Done — encrypted, private,
   no router config, immune to the school's dynamic IP.

*(Want a public https URL without installing Tailscale on each device? Use
**Tailscale Funnel**: `tailscale funnel --bg 4000` gives you an
`https://<machine>.<tailnet>.ts.net` URL. Set `APP_PASSWORD` first — below.)*

### A.4 Auto-start on boot

- **Windows:** Task Scheduler → Create Task → *At log on* →
  Action: `C:\Program Files\nodejs\node.exe`
  Arguments: `C:\ATT\server\src\index.js`, Start in: `C:\ATT\server`.
  (Or `npm i -g pm2` + `pm2 start src/index.js --name att` + `pm2 startup`.)
- **Linux:** use the systemd unit in [HARDWARE_SETUP.md §8](HARDWARE_SETUP.md).

---

## Option B: public exposure via router port-forward

Works, but your school router gets a hole punched in it — **only do this with
a password set.**

```bash
# server/.env
APP_PASSWORD=a-strong-password-here
```

With `APP_PASSWORD` set, the UI greets visitors with a login screen and every
API call requires the session token. Then on the school router
(`192.168.1.254`):

- Forward `external 8443 → <school-machine>:4000` (the **app**, *never* 4370 —
  the device's protocol must stay LAN-only, it has no encryption).
- If the school's public IP is dynamic (almost always is), add a free **DDNS**
  hostname (DuckDNS etc.) on the router, or just use Option A and skip this
  whole section.

For HTTPS instead of plain HTTP, put Caddy/Nginx in front:

```
att.yourschool.example {
    reverse_proxy 127.0.0.1:4000
}
```

---

## Never do these

- ❌ Forward **4370** to the internet (unencrypted, unauthenticated protocol)
- ❌ Expose the app publicly **without `APP_PASSWORD`** set
- ❌ Try to reach the K14 directly from a cloud/external location

## FAQ

**Multi-branch schools?** Run one ATT server per branch (each on its LAN), or
put a tiny TCP relay (`socat TCP-LISTEN:4370,fork TCP:192.168.1.110:4370`) +
Tailscale on a small machine at each branch and point `ZK_IP` at the relay.

**K14 and ADMS?** This K14 firmware (4.0.1) has no cloud/ADMS push — pull
mode from an on-LAN server is the correct and only protocol path.

**Forgot the password / locked out?** Remove `APP_PASSWORD` from
`server/.env` and restart — or rotate it with `APP_TOKEN_SALT`.
