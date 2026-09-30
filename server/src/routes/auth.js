/**
 * Optional access control — active only when APP_PASSWORD is set.
 *
 * The token is a stateless SHA-256 of the password + salt, so it survives
 * server restarts with zero session storage. When APP_PASSWORD is unset the
 * whole API stays open (LAN-trusted mode) and this module is a no-op.
 */
const crypto = require('crypto');
const express = require('express');

const router = express.Router();

function appPassword() {
  return process.env.APP_PASSWORD || null;
}

function expectedToken() {
  const pw = appPassword();
  if (!pw) return null;
  return crypto
    .createHash('sha256')
    .update(`att:${pw}:${process.env.APP_TOKEN_SALT || 'v1'}`)
    .digest('hex');
}

router.post('/login', (req, res) => {
  const token = expectedToken();
  if (!token) return res.json({ data: { authDisabled: true, token: null } });
  if (String(req.body?.password ?? '') === appPassword()) {
    return res.json({ data: { token } });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

router.get('/check', (req, res) => {
  const token = expectedToken();
  if (!token) return res.json({ data: { authDisabled: true } });
  if (req.headers['x-att-token'] === token) return res.json({ data: { ok: true } });
  return res.status(401).json({ error: 'Token expired or invalid' });
});

module.exports = { router, expectedToken };
