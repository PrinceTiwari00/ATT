/** Private service-to-service API used only by the LAN-side ZKTeco bridge agent. */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { claimNextCommand, completeDeviceCommand, heartbeatAgent } = require('../services/deviceBridge');

const router = express.Router();

function safeTokenMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (config.zk.mode !== 'bridge') {
    return res.status(404).json({ error: 'The device bridge is not enabled on this server' });
  }
  if (!config.bridge.token) {
    return res.status(503).json({ error: 'DEVICE_BRIDGE_TOKEN is not configured on the server' });
  }
  const supplied = req.get('x-device-bridge-token');
  if (!safeTokenMatch(supplied, config.bridge.token)) {
    return res.status(401).json({ error: 'Invalid device bridge token' });
  }
  next();
});

// The complete device log can exceed normal UI payload sizes. Parse it only
// after the bridge shared secret has been checked.
router.use(express.json({ limit: '15mb' }));

function readAgentId(req, res) {
  try {
    return String(req.body?.agentId == null ? '' : req.body.agentId).trim() || null;
  } catch {
    res.status(400).json({ error: 'Invalid request body' });
    return null;
  }
}

router.post('/heartbeat', (req, res) => {
  const agentId = readAgentId(req, res);
  if (!agentId) return res.status(422).json({ error: 'agentId is required' });
  if (agentId.length > 128) return res.status(422).json({ error: 'agentId must be at most 128 characters' });
  res.json({ ok: true, data: heartbeatAgent(agentId) });
});

router.post('/poll', (req, res) => {
  const agentId = readAgentId(req, res);
  if (!agentId) return res.status(422).json({ error: 'agentId is required' });
  if (agentId.length > 128) return res.status(422).json({ error: 'agentId must be at most 128 characters' });
  res.json({ command: claimNextCommand(agentId) });
});

router.post('/result', (req, res) => {
  const agentId = readAgentId(req, res);
  if (!agentId) return res.status(422).json({ error: 'agentId is required' });
  if (agentId.length > 128) return res.status(422).json({ error: 'agentId must be at most 128 characters' });

  const commandId = String(req.body?.commandId ?? '');
  if (!commandId) return res.status(422).json({ error: 'commandId is required' });
  if (typeof req.body?.ok !== 'boolean') return res.status(422).json({ error: 'ok must be a boolean' });

  const accepted = completeDeviceCommand({
    agentId,
    commandId,
    ok: req.body.ok,
    result: req.body.result,
    error: req.body.error,
    retryable: req.body.retryable === true,
  });
  if (!accepted) return res.status(404).json({ error: 'Command expired or was not assigned to this agent' });
  res.json({ ok: true });
});

module.exports = router;
