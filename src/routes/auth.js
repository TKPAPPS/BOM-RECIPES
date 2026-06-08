const express = require('express');
const jwt     = require('jsonwebtoken');
const xmlrpc  = require('xmlrpc');

const pool                = require('../config/db');
const { logAudit, getIp } = require('../services/auditService');
const { verifyPassword }  = require('../utils/password');

const router = express.Router();

/**
 * POST /api/auth/login
 *
 * Auth resolution order:
 *   1. ALLOW_DEV_LOGIN bypass — if enabled AND the submitted
 *      credentials match DEV_ADMIN_USER / DEV_ADMIN_PASSWORD,
 *      log the user in as a local admin without touching Odoo.
 *      Off-by-default, gated by env, and announced at boot.
 *   2. Otherwise authenticate against Odoo via XML-RPC
 *      (same connection style as services/odooSyncService.js):
 *        • /xmlrpc/2/common  → authenticate(db, login, password, {})
 *        • /xmlrpc/2/object  → res.users read + has_group for admin
 *   3. Upsert a local `users` row (cache of the Odoo user, per
 *      STEP 1 schema decision), issue a JWT carrying the LOCAL
 *      users.id, and write an audit_logs row.
 */
router.post('/login', async (req, res) => {
  const { username, code } = req.body;
  const ipAddress = getIp(req);

  if (!username || !code) {
    return res.status(400).json({ message: 'Username and code are required.' });
  }

  // ── 1. Dev-admin bypass (off unless ALLOW_DEV_LOGIN=true) ────────
  if (isDevAdminAttempt(username, code)) {
    let localUser;
    try {
      localUser = await upsertDevAdmin(username);
    } catch (err) {
      return sendStoreUnavailable(res, '[auth] Dev-admin upsert failed', err);
    }
    return issueToken(res, localUser, ipAddress, { devLogin: true });
  }

  // ── 1b. Local password auth (admin-created accounts) ─────────────
  // A user row with a password_hash authenticates locally, without
  // touching Odoo.  If the username matches a local password account
  // but the password is wrong, fail here (do NOT fall through to Odoo).
  let localPwUser;
  try {
    const { rows } = await pool.query(
      `SELECT id, odoo_uid, username, name, email, role, can_view_prices,
              is_active, password_hash
         FROM users
        WHERE LOWER(username) = LOWER($1) AND password_hash IS NOT NULL`,
      [username]
    );
    localPwUser = rows[0];
  } catch (err) {
    return sendStoreUnavailable(res, '[auth] Local password lookup failed', err);
  }

  if (localPwUser) {
    if (!verifyPassword(code, localPwUser.password_hash)) {
      await logAudit({
        userId: null, actionType: 'login_failure', entity: 'auth',
        description: `Invalid local password for "${username}"`, ipAddress,
      });
      return res.status(401).json({ message: 'Invalid credentials.' });
    }
    if (localPwUser.is_active === false) {
      await logAudit({
        userId: localPwUser.id, actionType: 'login_denied', entity: 'user',
        entityId: localPwUser.id,
        description: `Deactivated account "${username}" attempted to log in.`, ipAddress,
      });
      return res.status(403).json({ message: 'Account is deactivated. Contact an administrator.' });
    }
    try {
      await pool.query(`UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`, [localPwUser.id]);
    } catch { /* non-fatal */ }
    return issueToken(res, localPwUser, ipAddress, { devLogin: false });
  }

  // ── 2. Odoo XML-RPC auth ─────────────────────────────────────────
  if (!process.env.ODOO_URL || !process.env.ODOO_DB) {
    return res.status(503).json({
      message:
        'Authentication service not configured. Set ODOO_URL and ODOO_DB in .env ' +
        '(or enable ALLOW_DEV_LOGIN=true for local development).',
    });
  }

  let odooUser;
  try {
    odooUser = await authenticateWithOdoo(username, code);
  } catch (err) {
    console.error('[auth] Odoo XML-RPC transport failed');
    console.error('[auth]   → URL  :', process.env.ODOO_URL);
    console.error('[auth]   → DB   :', process.env.ODOO_DB);
    console.error('[auth]   → Error:', err.message);

    await logAudit({
      userId:      null,
      actionType:  'login_failure',
      entity:      'auth',
      description: `Odoo transport error for "${username}": ${err.message}`,
      ipAddress,
    });
    return res.status(502).json({ message: 'Authentication server connection error' });
  }

  if (!odooUser) {
    await logAudit({
      userId:      null,
      actionType:  'login_failure',
      entity:      'auth',
      description: `Invalid credentials for "${username}"`,
      ipAddress,
    });
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  // ── Deactivation guard (admin override beats Odoo) ───────────────
  let existing;
  try {
    const { rows } = await pool.query(
      `SELECT id, is_active FROM users WHERE odoo_uid = $1`,
      [odooUser.uid]
    );
    existing = rows[0];
  } catch (err) {
    return sendStoreUnavailable(res, '[auth] Local user lookup failed', err);
  }

  if (existing && existing.is_active === false) {
    await logAudit({
      userId:      existing.id,
      actionType:  'login_denied',
      entity:      'user',
      entityId:    existing.id,
      description: `Deactivated account "${odooUser.username}" attempted to log in.`,
      ipAddress,
    });
    return res.status(403).json({
      message: 'Account is deactivated. Contact an administrator.',
    });
  }

  // ── Upsert keyed by odoo_uid ─────────────────────────────────────
  // Role rule (unchanged from earlier spec):
  //   • upstream provided 'admin' → use it (overwrites local)
  //   • upstream did NOT          → keep existing role, or default
  //     'customer' for a brand-new row
  let localUser;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (odoo_uid, username, name, email, role, is_active, last_login)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'customer'), TRUE, NOW())
       ON CONFLICT (odoo_uid) DO UPDATE SET
         username   = EXCLUDED.username,
         name       = COALESCE(EXCLUDED.name,  users.name),
         email      = COALESCE(EXCLUDED.email, users.email),
         -- Never downgrade a 'manager' (highest role) just because Odoo
         -- reports the user as a system admin — manager is assigned here.
         role       = CASE WHEN users.role = 'manager' THEN 'manager'
                           ELSE COALESCE($5, users.role) END,
         last_login = NOW(),
         updated_at = NOW()
       RETURNING id, odoo_uid, username, name, email, role, can_view_prices, is_active`,
      [odooUser.uid, odooUser.username, odooUser.name, odooUser.email, odooUser.role]
    );
    localUser = rows[0];
  } catch (err) {
    return sendStoreUnavailable(res, '[auth] Local user upsert failed', err);
  }

  return issueToken(res, localUser, ipAddress, { devLogin: false });
});

/**
 * sendStoreUnavailable — uniform handler for local-DB failures.
 *   • Always logs the full error (with code + stack) server-side.
 *   • When ALLOW_DEV_LOGIN is on, returns the real reason in the
 *     response body so the developer can see "relation does not
 *     exist", "ECONNREFUSED", "password authentication failed", etc.
 *   • In production, returns the generic message — no internal
 *     details leak to the client.
 */
function sendStoreUnavailable(res, contextLabel, err) {
  console.error(`${contextLabel}:`, err.code || '', err.message);
  if (err.stack) console.error(err.stack);

  const body = { message: 'Local authentication store unavailable.' };
  if (devLoginEnabled()) {
    body.detail = `${err.code ? `[${err.code}] ` : ''}${err.message}`;
    body.hint = err.code === '42P01'
      ? 'Table missing — run `npm run db:migrate`.'
      : (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND')
        ? 'Cannot reach Postgres — check DB_HOST / DB_PORT in .env.'
        : (err.code === '28P01' || err.code === '28000')
          ? 'Postgres rejected the credentials — check DB_USER / DB_PASSWORD.'
          : undefined;
  }
  return res.status(500).json(body);
}

// ─── Odoo XML-RPC helpers (mirror src/services/odooSyncService.js) ──

function makeOdooClient(path) {
  const url  = new URL(process.env.ODOO_URL);
  const opts = {
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path,
  };
  return url.protocol === 'https:'
    ? xmlrpc.createSecureClient(opts)
    : xmlrpc.createClient(opts);
}

function rpcCall(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => (err ? reject(err) : resolve(val)));
  });
}

/**
 * authenticateWithOdoo — calls Odoo XML-RPC `authenticate` and, on
 * success, reads the res.users row + checks `base.group_system` to
 * decide if the user is an admin.
 *
 * Returns null on bad credentials (Odoo's `authenticate` returns
 * false). Throws on transport/server errors so the caller can map
 * them to a 502.
 */
async function authenticateWithOdoo(login, password) {
  const db = process.env.ODOO_DB;

  const common = makeOdooClient('/xmlrpc/2/common');
  const uid = await rpcCall(common, 'authenticate', [db, login, password, {}]);
  if (!uid) return null;

  const object = makeOdooClient('/xmlrpc/2/object');

  const userRows = await rpcCall(object, 'execute_kw', [
    db, uid, password,
    'res.users', 'read',
    [[uid]],
    { fields: ['login', 'name', 'email'] },
  ]);
  const userRow = Array.isArray(userRows) ? userRows[0] : null;

  // has_group runs as the authenticated uid → tells us if THIS user
  // is in the Settings/Administration group.  Non-fatal on failure.
  let isAdmin = false;
  try {
    isAdmin = await rpcCall(object, 'execute_kw', [
      db, uid, password,
      'res.users', 'has_group',
      ['base.group_system'],
    ]);
  } catch (err) {
    console.warn('[auth] has_group check failed (defaulting to non-admin):', err.message);
  }

  return {
    uid,
    username: (userRow && userRow.login) || login,
    name:     (userRow && userRow.name)  || login,
    email:    (userRow && userRow.email) || null,
    role:     isAdmin ? 'admin' : null, // null → leave local role / default 'customer' on new row
  };
}

// ─── Dev-only local admin bypass ─────────────────────────────────────

function devLoginEnabled() {
  return process.env.ALLOW_DEV_LOGIN === 'true';
}

function isDevAdminAttempt(username, code) {
  if (!devLoginEnabled()) return false;
  const u = process.env.DEV_ADMIN_USER;
  const p = process.env.DEV_ADMIN_PASSWORD;
  if (!u || !p) return false;
  return username === u && code === p;
}

/**
 * Upsert the dev-admin user.  No odoo_uid (NULL is fine — Postgres
 * treats NULLs as distinct under UNIQUE), conflict target is the
 * username, role is forced to 'manager' (the highest role — full access
 * incl. Settings + approvals), is_active forced TRUE.
 * can_view_prices is left as-is so the existing role-default applies.
 */
async function upsertDevAdmin(username) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, name, role, is_active, last_login)
     VALUES ($1, $2, 'manager', TRUE, NOW())
     ON CONFLICT (username) DO UPDATE SET
       role       = 'manager',
       is_active  = TRUE,
       last_login = NOW(),
       updated_at = NOW()
     RETURNING id, odoo_uid, username, name, email, role, can_view_prices, is_active`,
    [username, 'Local Dev Admin']
  );
  return rows[0];
}

// ─── Token issuance + audit (shared by both auth paths) ──────────────

function issueToken(res, localUser, ipAddress, { devLogin }) {
  const secret  = process.env.JWT_SECRET;
  const expires = process.env.JWT_EXPIRES_IN ?? '8h';

  if (!secret || secret.includes('REPLACE_WITH')) {
    console.error('[auth] JWT_SECRET is not configured.');
    return res.status(500).json({ message: 'Server configuration error.' });
  }

  const token = jwt.sign(
    {
      userId:   localUser.id,
      odooUid:  localUser.odoo_uid,
      username: localUser.username,
      name:     localUser.name,
    },
    secret,
    { expiresIn: expires }
  );

  logAudit({
    userId:      localUser.id,
    actionType:  'login_success',
    entity:      'user',
    entityId:    localUser.id,
    description: devLogin
      ? `DEV-LOGIN: "${localUser.username}" logged in as admin (ALLOW_DEV_LOGIN bypass).`
      : `User "${localUser.username}" logged in (role=${localUser.role}).`,
    ipAddress,
  });

  return res.json({
    token,
    user: {
      id:       localUser.id,
      odoo_uid: localUser.odoo_uid,
      username: localUser.username,
      name:     localUser.name,
      email:    localUser.email,
      role:     localUser.role,
      can_view_prices: localUser.can_view_prices,
    },
  });
}

module.exports = router;
// expose for app.js startup banner
module.exports.devLoginEnabled = devLoginEnabled;
