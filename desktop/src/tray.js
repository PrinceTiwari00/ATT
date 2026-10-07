/**
 * System tray presence: the school office PC keeps ATT running all day, so the
 * tray icon is the at-a-glance answer to "is it still collecting punches?".
 * It polls the local backend for device/circuit-breaker state and repaints
 * itself (icon + tooltip + menu) without ever blocking the UI.
 */
const path = require('path');
const fs = require('fs');
const { Tray, Menu, nativeImage, shell } = require('electron');
const service = require('./service');

const POLL_MS = 20000;

function loadIcon(assetsDir, name, fallbackColor) {
  const file = path.join(assetsDir, 'tray', name);
  if (fs.existsSync(file)) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  // Dev fallback: a small solid square so the tray still works without assets.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = fallbackColor;
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createTray({ assetsDir, backend, getWindow, log, onQuit, autostart }) {
  let tray = null;
  let timer = null;
  let last = null;
  let serviceState = { installed: false, running: false, state: 'unknown' };

  const icons = {
    online: loadIcon(assetsDir, 'online.png', [16, 185, 129]),
    offline: loadIcon(assetsDir, 'offline.png', [244, 63, 94]),
    starting: loadIcon(assetsDir, 'starting.png', [99, 102, 241]),
  };

  const show = () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const buildMenu = () => {
    const status = last;
    const device = status?.device || null;
    const online = Boolean(device && device.circuit !== 'open' && !status?.backendDown);
    const target = device?.target ? `${device.target.ip}:${device.target.port}` : 'not configured';
    const lastSync = device?.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString() : 'never';

    const template = [
      { label: 'ATT Attendance', enabled: false },
      {
        label: online ? `● Device online — ${target}` : `○ Device offline — ${target}`,
        enabled: false,
      },
      { label: `Last sync: ${lastSync}`, enabled: false },
      { type: 'separator' },
      { label: 'Open ATT', click: show, accelerator: 'CommandOrControl+Shift+A' },
      {
        label: 'Sync now',
        click: async () => {
          try {
            await backend.api('POST', '/device/sync-now');
            await refresh();
          } catch (err) {
            log('warn', `tray sync failed: ${err.message}`);
          }
        },
      },
      {
        label: 'Run connection diagnostics',
        click: () => {
          show();
          const win = getWindow();
          win?.webContents.send('att:navigate', '/connect?diagnose=1');
        },
      },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: Boolean(autostart.get()),
        click: (item) => autostart.set(item.checked),
      },
      {
        label: 'Background service (runs when signed out)',
        submenu: [
          {
            label: serviceState.installed
              ? `Status: ${serviceState.running ? 'running' : serviceState.state?.toLowerCase() || 'installed'}`
              : 'Status: not installed',
            enabled: false,
          },
          { type: 'separator' },
          {
            label: 'Install & start…',
            enabled: service.isWindows(),
            click: async () => {
              const res = await service.control('install', { paths: backend.paths, log });
              if (res.ok) await service.control('start', { paths: backend.paths, log });
              await refreshService();
            },
          },
          {
            label: 'Start',
            enabled: service.isWindows() && serviceState.installed,
            click: async () => { await service.control('start', { paths: backend.paths, log }); refreshService(); },
          },
          {
            label: 'Stop',
            enabled: service.isWindows() && serviceState.running,
            click: async () => { await service.control('stop', { paths: backend.paths, log }); refreshService(); },
          },
          {
            label: 'Uninstall',
            enabled: service.isWindows() && serviceState.installed,
            click: async () => { await service.control('uninstall', { paths: backend.paths, log }); refreshService(); },
          },
        ],
      },
      { type: 'separator' },
      { label: 'Open data folder', click: () => shell.openPath(backend.paths.home) },
      { label: 'Open log folder', click: () => shell.openPath(backend.paths.logDir) },
      { type: 'separator' },
      { label: 'Quit ATT', click: () => onQuit() },
    ];
    return Menu.buildFromTemplate(template);
  };

  async function refreshService() {
    serviceState = await service.status().catch(() => serviceState);
    if (tray) tray.setContextMenu(buildMenu());
  }

  async function refresh() {
    let device = null;
    let backendDown = false;
    try {
      const res = await backend.api('GET', '/device/status');
      device = res?.data || null;
    } catch (_) {
      backendDown = true;
    }
    last = { device, backendDown, at: Date.now() };
    if (!tray) return last;

    const online = Boolean(device && !backendDown && device.circuit !== 'open');
    const icon = backendDown || !device ? icons.starting : online ? icons.online : icons.offline;
    tray.setImage(icon);
    const target = device?.target ? `${device.target.ip}` : 'device not configured';
    const detail = backendDown
      ? 'backend offline'
      : device?.circuit === 'open'
        ? `circuit open — retrying`
        : device?.lastSyncAt
          ? `synced ${new Date(device.lastSyncAt).toLocaleTimeString()}`
          : 'waiting for first sync';
    tray.setToolTip(`ATT Attendance — ${target}\n${detail}`);
    tray.setContextMenu(buildMenu());
    return last;
  }

  function create() {
    tray = new Tray(icons.starting);
    tray.setToolTip('ATT Attendance — starting…');
    tray.setContextMenu(buildMenu());
    tray.on('click', show);
    tray.on('double-click', show);
    timer = setInterval(() => { refresh().catch(() => {}); }, POLL_MS);
    refreshService().catch(() => {});
    refresh().catch(() => {});
    return tray;
  }

  function destroy() {
    if (timer) clearInterval(timer);
    timer = null;
    if (tray) {
      tray.destroy();
      tray = null;
    }
  }

  return { create, refresh, refreshService, destroy, show, get lastStatus() { return last; } };
}

module.exports = { createTray };
