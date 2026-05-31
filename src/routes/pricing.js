const express = require('express');
const pool    = require('../config/db');
const { requireAdmin }    = require('../middleware/authMiddleware');
const { logAudit, getIp } = require('../services/auditService');
const {
  resolvePricingForItem,
  fetchDefaultFormula,
  fetchFormulaByUid,
} = require('../services/pricingService');

const router = express.Router();

// Hardcoded last-resort default for the resolve endpoint when no
// active default formula exists in the DB.  Matches the resolver's
// HARDCODED_DEFAULT in services/pricingService.js.
const HARDCODED_DEFAULT = {
  id: null,
  formula_uid: null,
  name: 'Default (hardcoded fallback)',
  is_default: true,
  wholesale_multiplier: 2.5,
  retail_multiplier:    5.0,
};

// ── GET /api/pricing/resolve?reference_code=... ─────────────────────
// Thin wrapper around the formula-selection engine.  If reference_code
// resolves to an item, delegates to resolvePricingForItem
// (manual → default → hardcoded).  Otherwise returns the default
// formula directly.
//
// Tolerant by design: invalid / partial / non-existent / Hebrew /
// any-encoding input MUST NOT 500.  Unknown ref codes return the
// default formula (selection='auto').  An empty/missing ref also
// returns the default formula.  Any internal failure is caught and
// returns the hardcoded default so the Recipe Builder's debounced
// resolver never crashes the UI.
//
// Reference codes can live on EITHER:
//   • items.reference          — raw materials / Odoo products (SKU)
//   • boms.reference_code      — internal recipe BOMs
// We check both before falling back.
router.get('/resolve', async (req, res) => {
  const raw = req.query.reference_code;
  const refCode = typeof raw === 'string' ? raw.trim() : '';

  try {
    if (refCode !== '') {
      const { rows: itemRows } = await pool.query(
        `SELECT i.id
         FROM   items i
         WHERE  i.is_active = TRUE
           AND  i.reference = $1
         UNION ALL
         SELECT b.item_id AS id
         FROM   boms b
         JOIN   items i ON i.id = b.item_id AND i.is_active = TRUE
         WHERE  b.is_active = TRUE
           AND  b.reference_code = $1
         LIMIT  1`,
        [refCode]
      );

      if (itemRows.length > 0) {
        const result = await resolvePricingForItem(itemRows[0].id);
        return res.json({
          wholesale_multiplier: result.wholesale_multiplier,
          retail_multiplier:    result.retail_multiplier,
          formula:              result.formula,
          selection:            result.selection,
          cost_per_kg:          result.cost_per_kg,
          wholesale_price:      result.wholesale_price,
          retail_price:         result.retail_price,
        });
      }
    }

    // No reference_code or no item match — return the default formula.
    const def = (await fetchDefaultFormula(pool)) || HARDCODED_DEFAULT;
    return res.json(defaultResponse(def));
  } catch (err) {
    console.warn('[GET /pricing/resolve] falling back to hardcoded default:', err.message);
    return res.json(defaultResponse(HARDCODED_DEFAULT));
  }
});

function defaultResponse(f) {
  return {
    wholesale_multiplier: f.wholesale_multiplier,
    retail_multiplier:    f.retail_multiplier,
    formula: {
      id:          f.id,
      formula_uid: f.formula_uid,
      name:        f.name,
      is_default:  !!f.is_default,
    },
    selection: 'auto',
  };
}

// ── GET /api/pricing ────────────────────────────────────────────────
// Returns the flat list of formulas the FormulaManager renders:
//   [{ id, formula_uid, name, wholesale_multiplier, retail_multiplier, is_default }]
//
// `id` is the MIN(tier_row_id) within the formula_uid group — the
// value FK'd by boms.pricing_formula_id when a recipe pins a
// specific formula.  Sorted: default first, then alphabetical by name.
router.get('/', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      MIN(id)                                                                AS id,
      formula_uid,
      MAX(name)                                                              AS name,
      bool_or(is_default)                                                    AS is_default,
      MAX(CASE WHEN price_tier = 'wholesale' THEN multiplier END)::float     AS wholesale_multiplier,
      MAX(CASE WHEN price_tier = 'retail'    THEN multiplier END)::float     AS retail_multiplier
    FROM   pricing_formulas
    WHERE  is_active   = TRUE
      AND  formula_uid IS NOT NULL
      AND  price_tier IN ('wholesale', 'retail')
    GROUP BY formula_uid
    ORDER BY is_default DESC, LOWER(MAX(name)) ASC, formula_uid ASC
  `);
  res.json(rows);
});

// ── POST /api/pricing — create a new formula ────────────────── (admin)
// Body: { name, wholesale_multiplier, retail_multiplier }
// Inserts the wholesale + retail tier rows that together make up
// one formula, both sharing a fresh formula_uid from the sequence.
// is_default is always FALSE on create; use POST /:id/default to set.
router.post('/', requireAdmin, async (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  const wholesale = parseFloat(req.body?.wholesale_multiplier);
  const retail    = parseFloat(req.body?.retail_multiplier);

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!(wholesale > 0) || !(retail > 0)) {
    return res.status(400).json({ error: 'wholesale_multiplier and retail_multiplier must be positive numbers' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [uidRow] } = await client.query(
      `SELECT nextval('pricing_formulas_uid_seq')::int AS uid`
    );
    const uid = uidRow.uid;

    // Insert wholesale then retail.  scope/scope_ref_id are kept at
    // the historical 'global' / NULL because the resolver no longer
    // consults them — the formula_uid is the real identity now.
    const { rows: [wRow] } = await client.query(
      `INSERT INTO pricing_formulas
         (scope, scope_ref_id, price_tier, multiplier, name, formula_uid, is_default)
       VALUES ('global', NULL, 'wholesale', $1, $2, $3, FALSE)
       RETURNING id`,
      [wholesale, name, uid]
    );
    await client.query(
      `INSERT INTO pricing_formulas
         (scope, scope_ref_id, price_tier, multiplier, name, formula_uid, is_default)
       VALUES ('global', NULL, 'retail', $1, $2, $3, FALSE)`,
      [retail, name, uid]
    );

    await logAudit(
      {
        userId:      req.localUser?.id ?? null,
        actionType:  'pricing_formula_create',
        entity:      'pricing_formula',
        entityId:    uid,
        description: `Created pricing formula "${name}" (uid=${uid})`,
        valueBefore: null,
        valueAfter:  { formula_uid: uid, name, wholesale_multiplier: wholesale, retail_multiplier: retail, is_default: false },
        ipAddress:   getIp(req),
      },
      client
    );

    await client.query('COMMIT');

    res.status(201).json({
      id:                   wRow.id,
      formula_uid:          uid,
      name,
      wholesale_multiplier: wholesale,
      retail_multiplier:    retail,
      is_default:           false,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── PUT /api/pricing/:id — update an existing formula ─────────── (admin)
// :id is the MIN(tier_row_id) returned by GET / — we resolve its
// formula_uid and update both tier rows in one transaction.
// Body: { name, wholesale_multiplier, retail_multiplier }
router.put('/:id', requireAdmin, async (req, res) => {
  const tierRowId = parseInt(req.params.id, 10);
  if (!tierRowId) return res.status(400).json({ error: 'invalid id' });

  const name = (req.body?.name ?? '').toString().trim();
  const wholesale = parseFloat(req.body?.wholesale_multiplier);
  const retail    = parseFloat(req.body?.retail_multiplier);

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!(wholesale > 0) || !(retail > 0)) {
    return res.status(400).json({ error: 'wholesale_multiplier and retail_multiplier must be positive numbers' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: uidRows } = await client.query(
      `SELECT formula_uid FROM pricing_formulas WHERE id = $1`,
      [tierRowId]
    );
    if (!uidRows.length || uidRows[0].formula_uid == null) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Formula not found' });
    }
    const uid = uidRows[0].formula_uid;

    const before = await fetchFormulaByUid(client, uid);

    await client.query(
      `UPDATE pricing_formulas
       SET    multiplier = CASE price_tier
                              WHEN 'wholesale' THEN $1
                              WHEN 'retail'    THEN $2
                              ELSE multiplier
                            END,
              name       = $3,
              updated_at = NOW()
       WHERE  formula_uid = $4
         AND  is_active   = TRUE
         AND  price_tier IN ('wholesale', 'retail')`,
      [wholesale, retail, name, uid]
    );

    const after = await fetchFormulaByUid(client, uid);

    await logAudit(
      {
        userId:      req.localUser?.id ?? null,
        actionType:  'pricing_formula_update',
        entity:      'pricing_formula',
        entityId:    uid,
        description: `Updated pricing formula "${name}" (uid=${uid})`,
        valueBefore: before,
        valueAfter:  after,
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

// ── POST /api/pricing/:id/default — mark a formula as the default ───
// Transaction: clear is_default on everything, then set it on rows
// matching the given formula_uid.  The partial unique index
// uq_pricing_formulas_default_active enforces at most one default.
router.post('/:id/default', requireAdmin, async (req, res) => {
  const tierRowId = parseInt(req.params.id, 10);
  if (!tierRowId) return res.status(400).json({ error: 'invalid id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: uidRows } = await client.query(
      `SELECT formula_uid FROM pricing_formulas WHERE id = $1`,
      [tierRowId]
    );
    if (!uidRows.length || uidRows[0].formula_uid == null) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Formula not found' });
    }
    const uid = uidRows[0].formula_uid;

    const before = await fetchFormulaByUid(client, uid);

    // Clear first (so the partial unique index never sees two TRUE
    // rows mid-transaction), then set on the chosen formula.
    await client.query(`UPDATE pricing_formulas SET is_default = FALSE WHERE is_default = TRUE`);
    await client.query(
      `UPDATE pricing_formulas SET is_default = TRUE
       WHERE  formula_uid = $1
         AND  is_active   = TRUE
         AND  price_tier IN ('wholesale', 'retail')`,
      [uid]
    );

    const after = await fetchFormulaByUid(client, uid);

    await logAudit(
      {
        userId:      req.localUser?.id ?? null,
        actionType:  'pricing_formula_update',
        entity:      'pricing_formula',
        entityId:    uid,
        description: `Marked pricing formula "${after?.name ?? uid}" as the default`,
        valueBefore: before,
        valueAfter:  after,
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

// ── DELETE /api/pricing/:id ───────────────────────────────────── (admin)
// Deactivates both tier rows for the formula.  Refuses to delete
// the active default — caller must promote another formula to
// default first.
router.delete('/:id', requireAdmin, async (req, res) => {
  const tierRowId = parseInt(req.params.id, 10);
  if (!tierRowId) return res.status(400).json({ error: 'invalid id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: meta } = await client.query(
      `SELECT formula_uid,
              bool_or(is_default) AS is_default,
              MAX(name)           AS name
       FROM   pricing_formulas
       WHERE  formula_uid = (SELECT formula_uid FROM pricing_formulas WHERE id = $1)
         AND  is_active   = TRUE
       GROUP BY formula_uid`,
      [tierRowId]
    );
    if (!meta.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Formula not found' });
    }
    if (meta[0].is_default) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Cannot delete the default formula. Mark another formula as default first, then try again.',
      });
    }
    const uid = meta[0].formula_uid;

    const before = await fetchFormulaByUid(client, uid);

    await client.query(
      `UPDATE pricing_formulas SET is_active = FALSE
       WHERE  formula_uid = $1`,
      [uid]
    );

    await logAudit(
      {
        userId:      req.localUser?.id ?? null,
        actionType:  'pricing_formula_delete',
        entity:      'pricing_formula',
        entityId:    uid,
        description: `Deactivated pricing formula "${meta[0].name ?? uid}"`,
        valueBefore: before,
        valueAfter:  null,
        ipAddress:   getIp(req),
      },
      client
    );

    await client.query('COMMIT');
    res.json({ message: 'Formula deactivated' });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
