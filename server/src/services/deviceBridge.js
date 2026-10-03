/**
 * In-memory command broker for the LAN-side device agent.
 *
 * A Render-hosted process cannot open TCP connections to a school's RFC1918
 * ZKTeco address. The site agent instead makes outbound HTTPS requests to
 * Render, claims commands here, executes them on the LAN, and posts results
 * back. Commands are intentionally transient; attendance itself is persisted
 * by the normal poller in SQLite.
 */
const { randomUUID } = require('crypto');
const config = require('../config');
const { ZKConnectionError, ZKDeviceError } = require('../zk/deviceContract');

const jobs = new Map();
const queue = [];
let activeAgent = null;

function normalizeAgentId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128) throw new Error('agentId must be a non-empty string of at most 128 characters');
  return id;
}

function heartbeatAgent(agentId) {
  const id = normalizeAgentId(agentId);
  const now = Date.now();
  if (!activeAgent || activeAgent.id !== id) {
    activeAgent = { id, firstSeenAt: now, lastSeenAt: now };
  } else {
    activeAgent.lastSeenAt = now;
  }
  return getAgentStatus();
}

function getAgentStatus() {
  const lastSeenAt = activeAgent?.lastSeenAt ?? null;
  const onlineWindowMs = config.bridge.agentOnlineWindowMs;
  return {
    enabled: config.zk.mode === 'bridge' && Boolean(config.bridge.token),
    online: Boolean(lastSeenAt && Date.now() - lastSeenAt <= onlineWindowMs),
    agentId: activeAgent?.id ?? null,
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
  };
}

function requestDeviceCommand(action, payload = {}) {
  if (config.zk.mode !== 'bridge') {
    return Promise.reject(new ZKDeviceError('The site device bridge is not enabled (set ZK_MODE=bridge)'));
  }
  if (!config.bridge.token) {
    return Promise.reject(new ZKDeviceError('DEVICE_BRIDGE_TOKEN is required when ZK_MODE=bridge'));
  }
  if (!getAgentStatus().online) {
    return Promise.reject(
      new ZKConnectionError('The site bridge agent is offline. Start server/src/agent.js on a machine that can reach the ZKTeco terminal.')
    );
  }

  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const job = {
      id,
      action,
      payload,
      resolve,
      reject,
      claimedBy: null,
      timer: null,
    };
    job.timer = setTimeout(() => {
      settleJob(
        job,
        new ZKConnectionError(
          `Timed out waiting for the site bridge to run ${action} after ${config.bridge.commandTimeoutMs}ms`
        )
      );
    }, config.bridge.commandTimeoutMs);
    jobs.set(id, job);
    queue.push(job);
  });
}

/** Called by an authenticated site agent. Returns one queued command at most. */
function claimNextCommand(agentId) {
  const id = normalizeAgentId(agentId);
  heartbeatAgent(id);
  while (queue.length) {
    const job = queue.shift();
    if (!jobs.has(job.id)) continue; // expired while still queued
    job.claimedBy = id;
    return { id: job.id, action: job.action, payload: job.payload };
  }
  return null;
}

/** Called by the same authenticated agent that claimed the command. */
function completeDeviceCommand({ agentId, commandId, ok, result, error, retryable }) {
  const id = normalizeAgentId(agentId);
  const job = jobs.get(String(commandId));
  if (!job || job.claimedBy !== id) return false;

  if (ok) {
    settleJob(job, null, result);
  } else {
    const message = String(error || 'The site agent reported a device operation failure');
    settleJob(job, retryable ? new ZKConnectionError(message) : new ZKDeviceError(message));
  }
  return true;
}

function settleJob(job, error, result) {
  if (!jobs.has(job.id)) return;
  jobs.delete(job.id);
  clearTimeout(job.timer);
  if (error) job.reject(error);
  else job.resolve(result);
}

module.exports = {
  heartbeatAgent,
  getAgentStatus,
  requestDeviceCommand,
  claimNextCommand,
  completeDeviceCommand,
};
