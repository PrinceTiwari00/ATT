/**
 * Device adapter that forwards operations to the authenticated on-site bridge.
 * The remote agent runs RealZKDevice locally, so no ZKTeco traffic or port
 * forwarding is exposed to the public internet.
 */
const { requestDeviceCommand } = require('../services/deviceBridge');

class BridgeZKDevice {
  constructor(cfg) {
    this.ip = cfg.ip;
    this.port = cfg.port;
    this.mode = 'bridge';
  }

  async testConnection() {
    try {
      const result = await requestDeviceCommand('testConnection');
      return { ...result, mode: this.mode, ip: this.ip, port: this.port };
    } catch (err) {
      return {
        ok: false,
        mode: this.mode,
        ip: this.ip,
        port: this.port,
        error: err.message,
        retryable: Boolean(err.retryable),
      };
    }
  }

  getUsers() {
    return requestDeviceCommand('getUsers');
  }

  getAttendance() {
    return requestDeviceCommand('getAttendance');
  }

  setUser(payload) {
    return requestDeviceCommand('setUser', payload);
  }

  /**
   * The bridge agent runs RealZKDevice on the school LAN, so capabilities are
   * decided there — reported as unknown until the agent answers. `canWriteUsers:
   * null` keeps the UI from disabling a button that may well work.
   */
  capabilities() {
    return {
      source: 'bridge',
      library: null,
      libraryVersion: null,
      installed: true,
      canFetchAttendance: true,
      canFetchUsers: true,
      canClearAttendance: true,
      canWriteUsers: null,
      availableMethods: [],
      note: 'Capabilities are determined by node-zklib on the site agent machine.',
    };
  }
}

module.exports = { BridgeZKDevice };
