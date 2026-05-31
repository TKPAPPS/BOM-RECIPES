const express = require('express');
const pool                = require('../config/db');
const { syncFromOdoo }    = require('../services/odooSyncService');
const { recalculateAll }  = require('../services/costingService');
const { requireAdmin }    = require('../middleware/authMiddleware');
const { logAudit, getIp } = require('../services/auditService');

const router = express.Router();

// GET /sync/status — last Odoo sync result (admin only).  Pulls the
// most recent 'odoo_sync_complete' / '_failure' / '_trigger' row from
// audit_logs so the dashboard / settings panel can show "synced N
// minutes ago" without us needing a separate state column.
router.get('/status', requireAdmin, async (_req, res) => {
  // Last completed sync (success or failure)
  const { rows: outcomeRows } = await pool.query(
    `SELECT action_type, description, value_after, created_at, user_id
     FROM   audit_logs
     WHERE  action_type IN ('odoo_sync_complete', 'odoo_sync_failure')
     ORDER  BY created_at DESC
     LIMIT  1`
  );

  // Most recent trigger (manual or cron)
  const { rows: triggerRows } = await pool.query(
    `SELECT description, created_at, user_id
     FROM   audit_logs
     WHERE  action_type = 'odoo_sync_trigger'
     ORDER  BY created_at DESC
     LIMIT  1`
  );

  // Active raw_material count gives a sanity-check number
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS active_products
     FROM   items
     WHERE  item_type = 'raw_material' AND is_active = TRUE`
  );

  res.json({
    last_outcome:    outcomeRows[0] || null,
    last_trigger:    triggerRows[0] || null,
    active_products: countRows[0].active_products,
    cron_schedule:   process.env.ODOO_SYNC_SCHEDULE || '0 */6 * * *',
  });
});

// All sync triggers are admin-only and every trigger is audited
// (both the start of the run and the outcome).

// POST /sync/odoo — manually trigger Odoo sync
router.post('/odoo', requireAdmin, async (req, res) => {
  const userId    = req.localUser?.id ?? null;
  const ipAddress = getIp(req);

  await logAudit({
    userId,
    actionType:  'odoo_sync_trigger',
    entity:      'sync_job',
    description: `User "${req.localUser?.username}" triggered Odoo sync.`,
    ipAddress,
  });

  try {
    const result = await syncFromOdoo();
    await logAudit({
      userId,
      actionType:  'odoo_sync_complete',
      entity:      'sync_job',
      description: 'Odoo sync completed.',
      valueAfter:  result,
      ipAddress,
    });
    res.json(result);
  } catch (err) {
    await logAudit({
      userId,
      actionType:  'odoo_sync_failure',
      entity:      'sync_job',
      description: `Odoo sync failed: ${err.message}`,
      ipAddress,
    });
    throw err;
  }
});

// POST /sync/costs — recalculate all recipe costs
router.post('/costs', requireAdmin, async (req, res) => {
  const userId    = req.localUser?.id ?? null;
  const ipAddress = getIp(req);

  await logAudit({
    userId,
    actionType:  'cost_recalc_trigger',
    entity:      'sync_job',
    description: `User "${req.localUser?.username}" triggered full cost recalculation.`,
    ipAddress,
  });

  const results = await recalculateAll();
  const ok      = results.filter((r) => r.ok).length;
  const failed  = results.filter((r) => !r.ok);

  await logAudit({
    userId,
    actionType:  'cost_recalc_complete',
    entity:      'sync_job',
    description: `Cost recalculation completed: ${ok} ok, ${failed.length} failed.`,
    valueAfter:  { ok, failed_count: failed.length },
    ipAddress,
  });

  res.json({ recalculated: ok, failed });
});

module.exports = router;
