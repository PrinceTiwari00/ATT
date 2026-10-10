/**
 * Device adapter that forwards operations to the authenticated on-site bridge.
 * The remote agent runs RealZKDevice locally, so no ZKTeco traffic or port
 * forwarding is exposed to the public internet.
 *
 * The terminal's Comm Key travels with each command (over the same
 * token-authenticated TLS channel as the command itself) so a key saved in the
 * cloud UI also works on the school LAN — the agent applies it before opening
 * its local session. `ZK_COMM_KEY` in the agent's own environment is used when
 * the cloud does not send one.
 */
const { requestDeviceCommand } = require('../services/deviceBridge');
const { normalizeCommKey } = require('./commKey');

class BridgeZKDevice {
  constructor(cfg) {
    this.ip = cfg.ip;
    this.port = cfg.port;
    this.mode = 'bridge';
    this.commKey = normalizeCommKey(cfg.commKey);
  }

  /** Bridge commands carry the key; `opts` (lock ticket) stays server-side. */
  command(action, payload = {}) {
    return requestDeviceCommand(action, payload, { commKey: this.commKey });
  }

  async testConnection(_opts = {}) {
    try {
      const result = await this.command('testConnection');
      return { ...result, mode: this.mode, ip: this.ip, port: this.port };
    } catch (err) {
      return {
        ok: false,
        mode: this.mode,
        ip: this.ip,
        port: this.port,
        error: err.message,
        hint: err.hint || null,
        retryable: Boolean(err.retryable),
      };
    }
  }

  getUsers(_opts = {}) {
    return this.command('getUsers');
  }

  getAttendance(_opts = {}) {
    return this.command('getAttendance');
  }

  setUser(payload, _opts = {}) {
    return this.command('setUser', payload);
  }

  /** Ask the on-site terminal what its Comm Key currently is. */
  readCommKey(_opts = {}) {
    return this.command('getCommKey');
  }

  /** Change the Comm Key on the on-site terminal (through the agent). */
  writeCommKey(key, { name = null } = {}, _opts = {}) {
    return this.command('setCommKey', { key: normalizeCommKey(key), name });
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
