/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRELOAD — the only bridge between the web UI and the desktop shell
 * ─────────────────────────────────────────────────────────────────────────────
 *  Exposes `window.att` to the renderer. The React app feature-detects it, so
 *  the SAME bundle works in a plain browser (window.att === undefined) and in
 *  the installed Windows app (tray, service control, autostart, folders…).
 *
 *  Everything is an explicit allow-listed invoke — no Node primitives, no
 *  arbitrary paths, no shell access from page context.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('att', {
  isDesktop: true,

  /** Shell/runtime facts (versions, folders, port, first run). */
  info: () => invoke('att:info'),

  /** Loopback admin token so the desktop UI never needs the staff password. */
  localToken: () => invoke('att:local-token'),

  settings: {
    get: () => invoke('att:settings-get'),
    set: (patch) => invoke('att:settings-set', patch),
  },

  backend: {
    status: () => invoke('att:backend-status'),
    restart: () => invoke('att:backend-restart'),
    syncNow: () => invoke('att:backend-sync'),
  },

  service: {
    status: () => invoke('att:service-status'),
    control: (action) => invoke('att:service-control', action),
  },

  autostart: {
    get: () => invoke('att:autostart-get'),
    set: (enabled) => invoke('att:autostart-set', enabled),
  },

  window: {
    minimize: () => invoke('att:window-minimize'),
    toggleMaximize: () => invoke('att:window-maximize'),
    close: () => invoke('att:window-close'),
    reload: () => invoke('att:window-reload'),
  },

  paths: {
    open: (which) => invoke('att:open-path', which),
  },

  logs: (lines = 300) => invoke('att:logs', lines),
  diagnostics: (target) => invoke('att:diagnostics', target),
  discover: (options) => invoke('att:discover', options),

  openExternal: (url) => invoke('att:open-external', url),
  quit: () => invoke('att:quit'),

  /** Shell → UI events. Each returns an unsubscribe function. */
  onNavigate: (handler) => subscribe('att:navigate', handler),
  onBackendState: (handler) => subscribe('att:backend-state', handler),
  onTrayAction: (handler) => subscribe('att:tray-action', handler),
});
