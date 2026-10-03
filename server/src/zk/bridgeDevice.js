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
}

module.exports = { BridgeZKDevice };
