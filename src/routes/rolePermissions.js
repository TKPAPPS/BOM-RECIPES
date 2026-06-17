const express = require('express');
const pool    = require('../config/db');
const { requireManager }  = require('../middleware/authMiddleware');
const { logAudit, getIp } = require('../services/auditService');

const router = express.Router();

// Canonical sidebar tab keys (mirror of client/src/config/tabs.ts).
const TAB_KEYS = ['dashboard', 'book', 'kitchen', 'test', 'pending', 'whereused', 'products', 'settings', 'logs', 'profile'];
const ROLES    = ['customer', 'admin', 'manager'];

// Fallback defaults if a row is missing.  Personal area (profile) is on
// by default for every role but can be toggled in the matrix.
const DEFAULTS = {
  customer: ['book', 'profile'],
  admin:    ['book', 'test', 'products', 'profile'],
  manager:  [...TAB_KEYS],
};

// ── GET /api/role-permissions ───────────────────────────────────────
// Returns the full { role: [tabKey,...] } map.  Any authenticated user
// may read it (their own nav is filtered by their role's list).
router.get('/', async (_req, res) => {
  const { rows } = await pool.query('SELECT role, tabs FROM role_tab_permissions');
  const map = { customer: [...DEFAULTS.customer], admin: [...DEFAULTS.admin], manager: [...DEFAULTS.manager] };
  for (const r of rows) if (ROLES.includes(r.role)) map[r.role] = r.tabs || [];
  // Anti-lockout: a manager can always reach Settings.
  if (!map.manager.includes('settings')) map.manager.push('settings');
  res.json(map);
});

// ── PUT /api/role-permissions ──────────────────────────────── (manager)
// Body: { role, tabs: [tabKey,...] } — replaces one role's visible tabs.
router.put('/', requireManager, async (req, res) => {
  const role = String(req.body?.role || '');
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });

  let tabs = Array.isArray(req.body?.tabs) ? req.body.tabs : [];
  tabs = [...new Set(tabs.filter((t) => TAB_KEYS.includes(t)))];
  // Anti-lockout: the manager role must always keep Settings.
  if (role === 'manager' && !tabs.includes('settings')) tabs.push('settings');

  const beforeRow = await pool.query('SELECT tabs FROM role_tab_permissions WHERE role = $1', [role]);
  const before = beforeRow.rows[0]?.tabs ?? DEFAULTS[role];

  await pool.query(
    `INSERT INTO role_tab_permissions (role, tabs, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (role) DO UPDATE
       SET tabs = EXCLUDED.tabs, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [role, tabs, req.localUser?.id ?? null]
  );

  await logAudit({
    userId:      req.localUser?.id ?? null,
    actionType:  'role_permissions_update',
    entity:      'role_tab_permissions',
    entityId:    null,
    description: `Updated visible tabs for role "${role}"`,
    valueBefore: { tabs: before },
    valueAfter:  { tabs },
    ipAddress:   getIp(req),
  });

  res.json({ role, tabs });
});

module.exports = router;
