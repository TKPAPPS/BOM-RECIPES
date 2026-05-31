/**
 * routes/auditLogs.js
 *
 * Admin-only audit log viewer.  Reads the audit_logs table seeded
 * by STEPS 2 + 4 (login events, user changes, pricing changes, sync
 * triggers, quantity calculations).
 *
 * Endpoints:
 *   GET /api/audit-logs              — filterable list
 *   GET /api/audit-logs/action-types — distinct action types (for filter UI)
 *
 * Filter params (all optional, AND'd together):
 *   user_id      — numeric users.id
 *   action_type  — exact match, e.g. 'login_success'
 *   entity       — 'user' | 'pricing_formula' | 'sync_job' | 'recipe' | 'auth'
 *   from         — ISO timestamp (inclusive)
 *   to           — ISO timestamp (exclusive)
 *   limit        — max rows to return (default 200, max 1000)
 *   offset       — pagination offset
 */

const express = require('express');
const pool    = require('../config/db');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  const { user_id, action_type, entity, from, to } = req.query;
  const limit  = Math.min(parseInt(req.query.limit)  || 200, 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const where  = [];
  const params = [];

  if (user_id) {
    params.push(parseInt(user_id));
    where.push(`a.user_id = $${params.length}`);
  }
  if (action_type) {
    params.push(action_type);
    where.push(`a.action_type = $${params.length}`);
  }
  if (entity) {
    params.push(entity);
    where.push(`a.entity = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`a.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`a.created_at < $${params.length}`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const sql =
    `SELECT a.id,
            a.user_id,
            u.username,
            u.name AS user_name,
            a.action_type,
            a.entity,
            a.entity_id,
            a.description,
            a.value_before,
            a.value_after,
            a.ip_address,
            a.created_at
     FROM   audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER  BY a.created_at DESC
     LIMIT  ${limitParam}
     OFFSET ${offsetParam}`;

  const { rows } = await pool.query(sql, params);

  // Total count for the same filter (drop limit/offset)
  const countSql =
    `SELECT COUNT(*)::int AS n
     FROM   audit_logs a
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const { rows: countRows } = await pool.query(countSql, params.slice(0, params.length - 2));

  res.json({
    total: countRows[0].n,
    rows,
  });
});

router.get('/action-types', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT action_type
     FROM   audit_logs
     ORDER  BY action_type`
  );
  res.json(rows.map((r) => r.action_type));
});

module.exports = router;
