/**
 * routes/users.js
 *
 * Admin-only user management.  No password endpoints — authentication
 * is external (Odoo).  Local `users` rows are a cache populated by
 * /api/auth/login; admins can change role, can_view_prices, is_active.
 *
 * Every mutation writes an audit_logs row with value_before /
 * value_after JSON so changes are diffable.
 *
 * Endpoints (all behind requireAdmin):
 *   GET   /api/users           — list (filterable: ?role=, ?active=)
 *   GET   /api/users/:id       — single user
 *   PATCH /api/users/:id       — update role / can_view_prices / is_active
 *   GET   /api/users/me        — current user's own row (any auth'd user)
 *   GET   /api/users/audit/:id — recent audit log for a user (admin)
 *
 * Note: GET /me is open to any authenticated user so the frontend can
 * refresh role/permissions without re-login.
 */

const express = require('express');
const pool    = require('../config/db');
const { requireAdmin }   = require('../middleware/authMiddleware');
const { logAudit, getIp } = require('../services/auditService');
const { hashPassword }    = require('../utils/password');

const router = express.Router();

const PUBLIC_COLS =
  'id, odoo_uid, username, name, email, role, can_view_prices, is_active, last_login, created_at, updated_at';

// ── GET /api/users/me — open to any authenticated user ──────────────
// Mounted before requireAdmin so a customer can fetch their own row
// to refresh role / can_view_prices after an admin changes it.
router.get('/me', (req, res) => {
  if (!req.localUser) return res.status(401).json({ message: 'Not authenticated.' });
  const u = req.localUser;
  res.json({
    id:              u.id,
    odoo_uid:        u.odoo_uid,
    username:        u.username,
    name:            u.name,
    email:           u.email,
    role:            u.role,
    can_view_prices: u.can_view_prices,
    is_active:       u.is_active,
    avatar_url:      u.avatar_url ?? null,
  });
});

// ── PATCH /api/users/me — self-service profile (any auth'd user) ─────
// A user may edit their own display name, username, profile picture and
// set/replace a local password.  Mounted before requireAdmin.
router.patch('/me', async (req, res) => {
  if (!req.localUser) return res.status(401).json({ message: 'Not authenticated.' });
  const id = req.localUser.id;
  const b = req.body || {};
  const sets = [];
  const params = [];
  const push = (frag, val) => { params.push(val); sets.push(`${frag} = $${params.length}`); };

  if ('name' in b) push('name', (b.name ?? '').toString().trim() || null);

  if ('username' in b) {
    const username = (b.username ?? '').toString().trim();
    if (!username) return res.status(400).json({ error: 'username cannot be empty' });
    const clash = await pool.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2', [username, id]);
    if (clash.rowCount) return res.status(409).json({ error: 'username already taken' });
    push('username', username);
  }

  if ('avatar_url' in b) {
    const a = b.avatar_url;
    push('avatar_url', a == null || a === '' ? null : String(a));
  }

  if (b.password) {
    const pw = String(b.password);
    if (pw.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
    push('password_hash', hashPassword(pw));
  }

  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}
     RETURNING id, odoo_uid, username, name, email, role, can_view_prices, is_active, avatar_url`,
    params
  );

  await logAudit({
    userId:      id,
    actionType:  'user_self_update',
    entity:      'user',
    entityId:    id,
    description: `User updated own profile (${Object.keys(b).filter((k) => ['name', 'username', 'avatar_url', 'password'].includes(k)).join(', ')})`,
    valueBefore: null,
    valueAfter:  { fields: Object.keys(b) },
    ipAddress:   getIp(req),
  });

  res.json(rows[0]);
});

// ── Everything below requires admin ─────────────────────────────────
router.use(requireAdmin);

// GET /api/users — list, with optional filters
router.get('/', async (req, res) => {
  const { role, active } = req.query;
  const params = [];
  const where  = [];

  if (role) {
    params.push(role);
    where.push(`role = $${params.length}`);
  }
  if (active === 'true' || active === 'false') {
    params.push(active === 'true');
    where.push(`is_active = $${params.length}`);
  }

  const sql =
    `SELECT ${PUBLIC_COLS} FROM users
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY name NULLS LAST, username`;

  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// POST /api/users — create a LOCAL user with username + password.
// These accounts authenticate against the local password hash (no Odoo).
// Body: { username, password, name?, role?, can_view_prices? }
router.post('/', async (req, res) => {
  const { username, password, name = null, role = 'customer', can_view_prices } = req.body ?? {};

  if (!username || !username.trim()) {
    return res.status(400).json({ error: 'username is required' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  if (!['admin', 'customer', 'manager'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin', 'manager' or 'customer'" });
  }

  const uname = username.trim();

  // Reject duplicate usernames up front for a clean message.
  const { rows: dupe } = await pool.query(
    `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`, [uname]
  );
  if (dupe.length) {
    return res.status(409).json({ error: 'A user with that username already exists.' });
  }

  const cvp = can_view_prices === true || can_view_prices === false ? can_view_prices : null;

  let created;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, name, role, can_view_prices, is_active, password_hash)
       VALUES ($1, $2, $3, $4, TRUE, $5)
       RETURNING ${PUBLIC_COLS}`,
      [uname, name?.trim() || uname, role, cvp, hashPassword(password)]
    );
    created = rows[0];
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with that username already exists.' });
    }
    throw err;
  }

  await logAudit({
    userId:      req.localUser?.id ?? null,
    actionType:  'user_create',
    entity:      'user',
    entityId:    created.id,
    description: `Created local user "${created.username}" (role=${created.role}).`,
    valueAfter:  { username: created.username, role: created.role, is_active: created.is_active },
    ipAddress:   getIp(req),
  });

  res.status(201).json(created);
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid user id' });

  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLS} FROM users WHERE id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'user not found' });
  res.json(rows[0]);
});

// PATCH /api/users/:id — update role, can_view_prices, is_active
//
// can_view_prices is THREE-STATE:
//   null  → "default" (follow role default at read time)
//   true  → explicit grant
//   false → explicit deny
//
// Accept the body shape:
//   { role?: 'admin'|'customer',
//     can_view_prices?: true|false|null,
//     is_active?: boolean }
router.patch('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid user id' });

  const { role, can_view_prices, is_active } = req.body ?? {};

  // ── Validate inputs explicitly (incl. the three-state field) ─────
  if (role !== undefined && !['admin', 'customer', 'manager'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin', 'manager' or 'customer'" });
  }
  if (
    can_view_prices !== undefined &&
    can_view_prices !== true &&
    can_view_prices !== false &&
    can_view_prices !== null
  ) {
    return res.status(400).json({
      error: 'can_view_prices must be true, false, or null (default)',
    });
  }
  if (is_active !== undefined && typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be boolean' });
  }

  // ── Anti-lockout: prevent the last active admin demoting/
  //                  deactivating themselves and losing all admin access
  if (id === req.localUser.id) {
    const wantsDemote     = role === 'customer';
    const wantsDeactivate = is_active === false;
    if (wantsDemote || wantsDeactivate) {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM users
         WHERE role = 'admin' AND is_active = TRUE AND id <> $1`,
        [id]
      );
      if (countRows[0].n === 0) {
        return res.status(409).json({
          error:
            'Cannot demote or deactivate the last active admin. Promote another admin first.',
        });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch the BEFORE snapshot inside the transaction for the audit row
    const { rows: beforeRows } = await client.query(
      `SELECT ${PUBLIC_COLS} FROM users WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!beforeRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'user not found' });
    }
    const before = beforeRows[0];

    // Build a partial UPDATE only with provided fields
    const sets   = [];
    const params = [];
    if (role !== undefined) {
      params.push(role);
      sets.push(`role = $${params.length}`);
    }
    if (can_view_prices !== undefined) {
      params.push(can_view_prices);
      sets.push(`can_view_prices = $${params.length}`);
    }
    if (is_active !== undefined) {
      params.push(is_active);
      sets.push(`is_active = $${params.length}`);
    }

    if (!sets.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'no updatable fields supplied' });
    }

    params.push(id);
    const { rows: afterRows } = await client.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING ${PUBLIC_COLS}`,
      params
    );
    const after = afterRows[0];

    // Diff: only include fields that actually changed
    const diffBefore = {};
    const diffAfter  = {};
    for (const key of ['role', 'can_view_prices', 'is_active']) {
      if (before[key] !== after[key]) {
        diffBefore[key] = before[key];
        diffAfter[key]  = after[key];
      }
    }

    await logAudit(
      {
        userId:      req.localUser.id,
        actionType:  'user_update',
        entity:      'user',
        entityId:    id,
        description: `Admin "${req.localUser.username}" updated user "${after.username}"`,
        valueBefore: diffBefore,
        valueAfter:  diffAfter,
        ipAddress:   getIp(req),
      },
      client
    );

    await client.query('COMMIT');
    res.json(after);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/users/:id/audit — recent audit history for a user
router.get('/:id/audit', async (req, res) => {
  const id    = parseInt(req.params.id);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  if (!id) return res.status(400).json({ error: 'invalid user id' });

  const { rows } = await pool.query(
    `SELECT id, action_type, entity, entity_id, description,
            value_before, value_after, ip_address, created_at
     FROM   audit_logs
     WHERE  user_id = $1 OR (entity = 'user' AND entity_id = $1)
     ORDER  BY created_at DESC
     LIMIT  $2`,
    [id, limit]
  );
  res.json(rows);
});

module.exports = router;
