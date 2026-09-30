/**
 * API guard — enforced only when APP_PASSWORD is configured.
 * Requires the X-ATT-Token header issued by POST /api/auth/login.
 */
const { expectedToken } = require('../routes/auth');

module.exports = function attAuth(req, res, next) {
  const token = expectedToken();
  if (!token) return next(); // auth not configured → LAN-trusted mode
  if (req.headers['x-att-token'] === token) return next();
  return res.status(401).json({ error: 'Authentication required' });
};
