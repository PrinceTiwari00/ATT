/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ATT for Windows — Electron main process
 * ─────────────────────────────────────────────────────────────────────────────
 *  Responsibilities:
 *    • one instance per computer (second launch focuses the existing window)
 *    • start / attach to the local attendance backend (Node runtime + SQLite +
 *      ZKTeco poller) and keep it alive
 *    • show the React UI in a native window, guarded against external navigation
 *    • live tray icon: device online/offline, last sync, sync-now, diagnostics
 *    • start with Windows, optional background service, data/log folders
 *    • clean shutdown (stop poller, release the instance lock, close the DB)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeImage } = require('electron');

const logger = require('./logger');
const { resolvePaths } = require('./paths');
const { resolveRuntime } = require('./runtime');
const { Backend } = require('./backend');
const { createTray } = require('./tray');
const service = require('./service');

const APP_NAME = 'ATT Attendance';
const RELEASES_URL = 'https://github.com/PrinceTiwari00/ATT/releases';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.att.attendance');

const argv = process.argv.slice(1);
const startHidden = argv.includes('--hidden') || argv.includes('--minimized');

let paths = null;
let backend = null;
let tray = null;
let mainWindow = null;
let splash = null;
let quitting = false;
let firstRun = false;
let localToken = '';
let runtimeInfo = null;

const log = (level, ...args) => logger[level]?.(...args);

/* ── single instance ───────────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) {
  // Another ATT window owns this computer — bring it forward and exit.
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  showWindow();
});

/* ── helpers ───────────────────────────────────────────────────────────── */

function showWindow() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
  } catch (_) {
    return {};
  }
}

function settingValue(key, fallback) {
  const cfg = readConfigFile();
  const value = key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), cfg);
  return value === undefined ? fallback : value;
}

function windowIcon() {
  for (const candidate of [
    path.join(paths.resourcesPath || '', 'payload', 'assets', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
  ]) {
    if (candidate && fs.existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) return img;
    }
  }
  return undefined;
}

/* ── splash (visible while the backend boots) ──────────────────────────── */

function createSplash() {
  splash = new BrowserWindow({
    width: 520,
    height: 320,
    frame: false,
    resizable: false,
    movable: true,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    show: false,
    backgroundColor: '#0f172a',
    icon: windowIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => { if (!quitting) splash.show(); });
  splash.webContents.once('did-finish-load', () => splashProgress('Starting ATT…'));
}

function splashProgress(message, detail) {
  if (!splash || splash.isDestroyed()) return;
  const safe = { message: String(message || ''), detail: String(detail || '') };
  splash.webContents
    .executeJavaScript(`window.attSplash && window.attSplash(${JSON.stringify(safe)})`)
    .catch(() => {});
}

function splashError(title, message) {
  if (splash && !splash.isDestroyed()) {
    splash.webContents
      .executeJavaScript(`window.attSplashError && window.attSplashError(${JSON.stringify({ title, message })})`)
      .catch(() => {});
  }
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.close();
  splash = null;
}

/* ── main window ───────────────────────────────────────────────────────── */

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f1f5f9',
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The backend is local and idle-sensitive: keep timers running when the
      // window is hidden in the tray so the poller never drifts.
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, target) => {
    const allowed = target.startsWith(url) || target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    }
  });

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    if (!startHidden) mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    if (settingValue('desktop.closeToTray', true)) {
      event.preventDefault();
      mainWindow.hide();
      if (process.platform === 'win32' && !tray) app.quit();
    }
  });

  mainWindow.on('minimize', () => {
    if (settingValue('desktop.minimizeToTray', false)) mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(url);
  return mainWindow;
}

/* ── application menu ──────────────────────────────────────────────────── */

function buildMenu() {
  const isWin = process.platform === 'win32';
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Sync now', accelerator: 'F5', click: () => backend?.api('POST', '/device/sync-now').catch(() => {}) },
        { label: 'Connection wizard', accelerator: 'CmdOrCtrl+Shift+C', click: () => { showWindow(); mainWindow?.webContents.send('att:navigate', '/connect'); } },
        { type: 'separator' },
        { label: 'Open data folder', click: () => shell.openPath(paths.home) },
        { label: 'Open log folder', click: () => shell.openPath(paths.logDir) },
        { type: 'separator' },
        { label: 'Quit ATT', accelerator: 'CmdOrCtrl+Q', click: () => quitApp() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: isWin ? 'close' : 'zoom' }],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About ATT', click: () => showAbout() },
        { label: 'Device setup guide', click: () => shell.openExternal(`${RELEASES_URL.replace('/releases', '')}/blob/main/docs/HARDWARE_SETUP.md`) },
        { label: 'Check for updates…', click: () => shell.openExternal(RELEASES_URL) },
        { type: 'separator' },
        { label: 'Open desktop log', click: () => shell.openPath(paths.desktopLog) },
        { label: 'Open backend log', click: () => shell.openPath(paths.serverLog) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [
      `ZKTeco integrated attendance tracking`,
      '',
      `Backend: ${runtimeInfo?.url || 'not running'} (pid ${runtimeInfo?.pid || '—'})`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
      `Data folder: ${paths.home}`,
      `Database: ${paths.dbFile}`,
    ].join('\n'),
    buttons: ['OK', 'Open data folder'],
  }).then(({ response }) => { if (response === 1) shell.openPath(paths.home); });
}

/* ── autostart ─────────────────────────────────────────────────────────── */

const autostart = {
  get() {
    try {
      return Boolean(app.getLoginItemSettings().openAtLogin);
    } catch (_) {
      return false;
    }
  },
  set(enabled) {
    try {
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        path: app.getPath('exe'),
        args: Boolean(enabled) && settingValue('desktop.minimizeToTray', false) ? ['--hidden'] : [],
      });
      backend?.api('PUT', '/system/settings', { 'desktop.autostart': Boolean(enabled) }).catch(() => {});
      tray?.refreshService?.();
      log('info', `autostart ${enabled ? 'enabled' : 'disabled'}`);
      return true;
    } catch (err) {
      log('error', `autostart failed: ${err.message}`);
      return false;
    }
  },
};

/** Apply the persisted preference once at launch (first run defaults to on). */
function syncAutostart() {
  const wanted = settingValue('desktop.autostart', true);
  if (autostart.get() !== Boolean(wanted)) autostart.set(Boolean(wanted));
}

/* ── IPC ───────────────────────────────────────────────────────────────── */

function registerIpc() {
  ipcMain.handle('att:info', () => ({
    app: {
      name: APP_NAME,
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hostname: require('os').hostname(),
      firstRun,
    },
    backend: runtimeInfo
      ? { url: runtimeInfo.url, port: runtimeInfo.port, pid: runtimeInfo.pid, mode: runtimeInfo.mode, attached: Boolean(runtimeInfo.attached) }
      : null,
    paths: {
      home: paths.home,
      configFile: paths.configFile,
      dbFile: paths.dbFile,
      logDir: paths.logDir,
      serverLog: paths.serverLog,
      desktopLog: paths.desktopLog,
      backupDir: paths.backupDir,
      installDir: paths.installDir,
      payloadDir: paths.payloadDir,
    },
    runtime: { node: backend?.runtime?.version, source: backend?.runtime?.source },
  }));

  ipcMain.handle('att:local-token', () => localToken);

  ipcMain.handle('att:settings-get', async () => backend.api('GET', '/system/settings'));
  ipcMain.handle('att:settings-set', async (_e, patch) => {
    const result = await backend.api('PUT', '/system/settings', patch);
    tray?.refresh?.();
    return result;
  });

  ipcMain.handle('att:backend-status', async () => ({
    state: backend.state,
    info: runtimeInfo,
    device: (await backend.api('GET', '/device/status').catch(() => null))?.data || null,
  }));
  ipcMain.handle('att:backend-restart', async () => {
    const info = await backend.restart();
    runtimeInfo = info;
    localToken = info?.token || localToken;
    mainWindow?.webContents.reload();
    return info;
  });
  ipcMain.handle('att:backend-sync', async () => backend.api('POST', '/device/sync-now'));

  ipcMain.handle('att:service-status', async () => {
    const state = await service.status();
    return { ...state, machineWideHome: service.machineWideHome(), homeIsMachineWide: service.homeIsMachineWide(paths), paths: { serviceExe: paths.serviceExe } };
  });
  ipcMain.handle('att:service-control', async (_e, action) => {
    const result = await service.control(String(action), { paths, log });
    tray?.refreshService?.();
    return result;
  });

  ipcMain.handle('att:autostart-get', () => autostart.get());
  ipcMain.handle('att:autostart-set', (_e, enabled) => autostart.set(Boolean(enabled)));

  ipcMain.handle('att:window-minimize', () => mainWindow?.minimize());
  ipcMain.handle('att:window-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('att:window-close', () => mainWindow?.close());
  ipcMain.handle('att:window-reload', () => mainWindow?.webContents.reload());

  ipcMain.handle('att:open-path', async (_e, which) => {
    const allowed = {
      home: paths.home,
      data: paths.home,
      logs: paths.logDir,
      desktopLog: paths.desktopLog,
      serverLog: paths.serverLog,
      backups: paths.backupDir,
      config: paths.configFile,
      install: paths.installDir,
    };
    const target = allowed[String(which)];
    if (!target) throw new Error(`Unknown path "${which}"`);
    if (!fs.existsSync(target)) fs.mkdirSync(path.dirname(target), { recursive: true });
    return shell.openPath(target);
  });

  ipcMain.handle('att:logs', async (_e, lines) => backend.api('GET', `/system/logs?lines=${Number(lines) || 300}`));
  ipcMain.handle('att:diagnostics', async (_e, target) => backend.api('POST', '/system/diagnostics', target || {}));
  ipcMain.handle('att:discover', async (_e, options) => backend.api('POST', '/system/discover', options || {}));

  ipcMain.handle('att:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    throw new Error('Only http(s) links can be opened');
  });

  ipcMain.handle('att:quit', () => quitApp());
}

/* ── shutdown ──────────────────────────────────────────────────────────── */

async function quitApp() {
  if (quitting) return;
  quitting = true;
  log('info', 'quitting');
  try {
    tray?.destroy();
  } catch (_) { /* ignore */ }
  try {
    if (backend && !runtimeInfo?.attached) {
      // Let the backend close its DB and release the instance lock cleanly.
      await backend.api('POST', '/system/shutdown').catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      await backend.stop();
    }
  } catch (err) {
    log('warn', `shutdown: ${err.message}`);
  }
  app.quit();
}

/* ── boot ──────────────────────────────────────────────────────────────── */

async function boot() {
  paths = resolvePaths(app);
  firstRun = !fs.existsSync(paths.configFile);
  logger.init(paths.desktopLog);
  log('info', `${APP_NAME} ${app.getVersion()} starting (packaged=${paths.packaged}, firstRun=${firstRun})`);
  log('info', `home=${paths.home} payload=${paths.payloadDir}`);

  buildMenu();
  registerIpc();
  createSplash();

  let runtime;
  try {
    splashProgress('Checking the bundled Node.js runtime…');
    runtime = resolveRuntime(paths, (level, ...args) => log(level, ...args));
  } catch (err) {
    closeSplash();
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      `${err.message}\n\nLog: ${paths.desktopLog}`
    );
    app.quit();
    return;
  }

  backend = new Backend({
    paths,
    runtime,
    log: (level, ...args) => log(level, ...args),
    serviceStatus: () => service.status(),
  });
  backend.startService = () => service.control('start', { paths, log });
  backend.on('progress', ({ message, detail }) => splashProgress(message, detail));
  backend.on('state', (state) => {
    mainWindow?.webContents.send('att:backend-state', { state, at: Date.now() });
    log('info', `backend state: ${state}`);
  });
  backend.on('failed', (err) => {
    splashError('The attendance engine stopped', err.message);
    dialog.showErrorBox(`${APP_NAME} — backend stopped`, `${err.message}\n\nLog: ${paths.serverLog}`);
  });

  try {
    runtimeInfo = await backend.start();
    localToken = runtimeInfo?.token || '';
    log('info', `backend online at ${runtimeInfo.url} (mode ${runtimeInfo.mode}, attached=${Boolean(runtimeInfo.attached)})`);
  } catch (err) {
    log('error', `backend start failed: ${err.message}`);
    closeSplash();
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: `${APP_NAME} could not start`,
      message: 'The local attendance engine did not start.',
      detail: `${err.message}\n\nBackend log: ${paths.serverLog}\nDesktop log: ${paths.desktopLog}`,
      buttons: ['Open log folder', 'Retry', 'Quit'],
      defaultId: 0,
    });
    if (response === 0) await shell.openPath(paths.logDir);
    if (response === 1) {
      quitting = false;
      return boot();
    }
    app.quit();
    return;
  }

  createMainWindow(runtimeInfo.url);
  tray = createTray({
    assetsDir: path.join(paths.payloadDir, 'assets'),
    backend,
    getWindow: () => mainWindow,
    log: (level, ...args) => log(level, ...args),
    onQuit: () => quitApp(),
    autostart,
  });
  tray.create();

  syncAutostart();

  if (firstRun) log('info', 'first run — opening the connection wizard');
}

/* ── electron lifecycle ────────────────────────────────────────────────── */

app.whenReady().then(boot).catch((err) => {
  log('error', `fatal: ${err.stack || err.message}`);
  try {
    dialog.showErrorBox(`${APP_NAME} failed to start`, String(err.message || err));
  } catch (_) { /* ignore */ }
  app.quit();
});

app.on('window-all-closed', () => {
  // The tray keeps ATT collecting attendance — never quit just because the
  // window closed (that is the whole point of closeToTray).
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('activate', () => showWindow());

process.on('uncaughtException', (err) => {
  log('error', `uncaught: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log('error', `unhandled rejection: ${reason?.stack || reason}`);
});
