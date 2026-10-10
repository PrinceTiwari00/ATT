#!/usr/bin/env node
/**
 * LAN-side ZKTeco bridge agent for cloud deployments (for example Render).
 * Run this on an always-on machine that can reach the terminal at ZK_IP:ZK_PORT.
 * It only makes outbound HTTPS requests; the cloud server never connects to
 * the school's private network and no device port needs to be forwarded.
 */
const os = require('os');
const config = require('./config');
const { RealZKDevice } = require('./zk/realDevice');

const apiBase = process.env.ATT_API_URL;
const bridgeToken = config.bridge.token;
const agentId = process.env.DEVICE_BRIDGE_AGENT_ID || `${os.hostname()}-${process.pid}`;
const pollIntervalMs = Math.max(
  500,
  Number.parseInt(process.env.DEVICE_BRIDGE_POLL_INTERVAL_MS || String(config.bridge.agentPollIntervalMs), 10)
);

function validateConfig() {
  if (!apiBase) throw new Error('ATT_API_URL is required (for example https://your-service.onrender.com)');
  if (!bridgeToken) throw new Error('DEVICE_BRIDGE_TOKEN is required; copy it from the Render service environment');
  const url = new URL(apiBase);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('ATT_API_URL must use HTTP or HTTPS');
  const localHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHost) {
    throw new Error('Use an HTTPS ATT_API_URL except for local development on loopback');
  }
}

async function post(endpoint, body, timeoutMs = 15_000) {
  const url = new URL(`/api/bridge/${endpoint}`, apiBase);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-bridge-token': bridgeToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON response is surfaced below with its HTTP status.
  }
  if (!response.ok) {
    throw new Error(payload?.error || `ATT bridge returned HTTP ${response.status}`);
  }
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execute(device, command) {
  switch (command.action) {
    case 'testConnection':
      return device.testConnection();
    case 'getUsers':
      return device.getUsers();
    case 'getAttendance':
      return device.getAttendance();
    case 'setUser':
      return device.setUser(command.payload || {});
    default:
      throw new Error(`Unsupported bridge command: ${command.action}`);
  }
}

async function run() {
  validateConfig();
  const device = new RealZKDevice(config.zk);
  console.log(`[bridge-agent] using ATT endpoint ${new URL(apiBase).origin}`);
  console.log(`[bridge-agent] device target ${config.zk.ip}:${config.zk.port}; agent id ${agentId}`);
  console.log('[bridge-agent] only outbound HTTPS is used; keep TCP 4370 private to the school LAN');

  let stopping = false;
  let lastHeartbeatError = '';
  const heartbeatTimer = setInterval(() => {
    post('heartbeat', { agentId }, 10_000)
      .then(() => { lastHeartbeatError = ''; })
      .catch((err) => {
        if (err.message !== lastHeartbeatError) {
          console.warn(`[bridge-agent] heartbeat failed: ${err.message}`);
          lastHeartbeatError = err.message;
        }
      });
  }, config.bridge.agentHeartbeatIntervalMs);
  heartbeatTimer.unref();

  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });

  let retryDelayMs = pollIntervalMs;
  let loggedOnline = false;
  while (!stopping) {
    try {
      const response = await post('poll', { agentId }, 15_000);
      if (!loggedOnline) {
        console.log('[bridge-agent] authenticated with ATT; waiting for device commands');
        loggedOnline = true;
      }
      retryDelayMs = pollIntervalMs;
      const command = response?.command || null;
      if (!command) {
        await sleep(pollIntervalMs);
        continue;
      }

      let result;
      try {
        result = await execute(device, command);
        if (command.action === 'testConnection' && result?.ok === false) {
          await post('result', {
            agentId,
            commandId: command.id,
            ok: false,
            error: result.error || 'ZKTeco connection failed',
            retryable: Boolean(result.retryable),
          });
        } else {
          await post('result', { agentId, commandId: command.id, ok: true, result });
        }
      } catch (err) {
        await post('result', {
          agentId,
          commandId: command.id,
          ok: false,
          error: err.message || String(err),
          retryable: Boolean(err.retryable),
        });
      }
    } catch (err) {
      loggedOnline = false;
      console.warn(`[bridge-agent] cloud connection failed: ${err.message}`);
      await sleep(retryDelayMs);
      retryDelayMs = Math.min(30_000, Math.max(pollIntervalMs, retryDelayMs * 2));
    }
  }

  clearInterval(heartbeatTimer);
  console.log('[bridge-agent] stopped');
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`[bridge-agent] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, execute, validateConfig };
