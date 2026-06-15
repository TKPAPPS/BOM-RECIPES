/**
 * authMiddleware.js
 *
 * Two-layer authentication:
 *   (1) JWT verification — proves the request carries a valid token
 *       issued by /api/auth/login.
 *   (2) Local users-row resolution — the LIVE source of truth for
 *       role, can_view_prices, and is_active.  Reading from the DB
 *       on every request means an admin promoting/demoting/
 *       deactivating someone takes effect immediately, without the
 *       user re-logging in.
 *
 * Exports:
 *   • authMiddleware (default)  — verifies JWT + loads req.localUser
 *   • requireRole('admin', …)   — gate by role(s)
 *   • requireAdmin              — shorthand for requireRole('admin')
 *   • pricesMiddleware          — wraps res.json to strip price
 *                                 fields for users without view-price
 *                                 permission
 *
 * Backwards compatibility: `require('./authMiddleware')` still
 * returns the auth function as the default export, so app.js does
 * not need to change call sites.  Named helpers are attached to it.
 */

const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { canViewPrices, stripPrices } = require('../utils/priceVisibility');

const USER_SELECT_COLS =
  'id, odoo_uid, username, name, email, role, can_view_prices, is_active, avatar_url';

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token  = authHeader.slice(7); // strip "Bearer "
  const secret = process.env.JWT_SECRET;

  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Session expired. Please log in again.'
        : 'Invalid or tampered token.';
    return res.status(401).json({ message });
  }

  req.user = decoded;

  // ── Resolve the LIVE local users row (source of truth) ───────────
  // decoded.userId is the local users.id (issued by routes/auth.js).
  if (!decoded.userId) {
    return res.status(401).json({ message: 'Token missing user id.' });
  }

  let localUser;
  try {
    const { rows } = await pool.query(
      `SELECT ${USER_SELECT_COLS} FROM users WHERE id = $1`,
      [decoded.userId]
    );
    localUser = rows[0];
  } catch (err) {
    console.error('[authMiddleware] DB lookup failed:', err.message);
    return res.status(500).json({ message: 'Authentication lookup failed.' });
  }

  if (!localUser) {
    return res.status(401).json({ message: 'User no longer exists.' });
  }
  if (!localUser.is_active) {
    return res.status(403).json({ message: 'Account is deactivated.' });
  }

  req.localUser = localUser;
  next();
}

/**
 * Gate access to one or more roles.  Usage:
 *   router.post('/x', requireAdmin, handler)
 *   router.put ('/y', requireRole('admin', 'customer'), handler)
 *
 * Must run AFTER authMiddleware so req.localUser is populated.
 */
function requireRole(...allowedRoles) {
  return function roleGuard(req, res, next) {
    if (!req.localUser) {
      return res.status(401).json({ message: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.localUser.role)) {
      return res.status(403).json({
        message: 'Insufficient permissions for this action.',
      });
    }
    next();
  };
}

// 'manager' is a privileged superset of admin — it passes every admin
// gate AND additionally may promote test recipes (requireManager).
const requireAdmin = requireRole('admin', 'manager');
const requireManager = requireRole('manager');

/**
 * Wrap res.json so every response body is filtered through stripPrices
 * when the current user cannot view prices.  Mounted globally AFTER
 * authMiddleware in app.js so every protected response is covered
 * automatically and individual routes do not need to remember.
 *
 * For endpoints that are public-before-auth (e.g. /api/auth/login,
 * /api/health), req.localUser is undefined → canViewPrices returns
 * false → those payloads contain no price data anyway, so the strip
 * is a no-op there.
 */
function pricesMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (canViewPrices(req.localUser)) return originalJson(payload);
    return originalJson(stripPrices(payload));
  };
  next();
}

// Preserve existing default export so `require('./authMiddleware')`
// keeps working in app.js without a refactor.
module.exports = authMiddleware;
module.exports.authMiddleware  = authMiddleware;
module.exports.requireRole     = requireRole;
module.exports.requireAdmin    = requireAdmin;
module.exports.requireManager  = requireManager;
module.exports.pricesMiddleware = pricesMiddleware;
