/**
 * products.js — Admin-only catalogue of raw materials synced from Odoo.
 *
 * This is intentionally a separate route from /items because the
 * Products tab is a flat, raw-data view of the synced catalogue
 * (image / name / reference / Odoo weight / cost / cost-per-kg)
 * rather than the BOM-aware item picker used elsewhere.
 *
 * Cost / weight resolution is delegated to costResolver.resolveProductCost
 * so the GET listing recomputes LIVE on every request (no dependency on a
 * possibly-stale items.cost_per_kg) and agrees exactly with the Odoo sync.
 *
 * Resolution order (most authoritative first):
 *   COST PRICE   manual_raw_cost   → Odoo standard_price
 *   WEIGHT       manual_weight     → Odoo volume_weight → name regex
 *   COST / KG    manual_cost_per_kg → cost / measure → cost as-is (fallback)
 *
 * The name regex resolves weight (kg/g), volume ("1 l" → ₪/litre) and
 * count ("6 unit" / bare "unit" → ₪/unit).  When nothing is parseable
 * the cost itself becomes the cost-per-kg.
 *
 * Manual overrides live in dedicated columns (manual_raw_cost,
 * manual_weight_grams, manual_cost_per_kg) and survive Odoo syncs.
 */

const express = require('express');
const pool    = require('../config/db');
const { requireAdmin } = require('../middleware/authMiddleware');
const { resolveProductCost, toNum } = require('../utils/costResolver');

const router = express.Router();

const PRODUCT_COLUMNS = `
  i.id,
  i.odoo_id,
  COALESCE(i.name_en, i.name) AS name,
  i.name_en,
  i.name_he,
  i.reference,
  i.uom,
  i.volume_weight,
  i.weight_extracted_grams,
  i.weight_source,
  i.odoo_archived,
  i.raw_cost,
  i.cost_per_kg                  AS cost_per_kg_stored,
  i.manual_raw_cost,
  i.manual_weight_grams,
  i.manual_cost_per_kg,
  i.cost_overridden,
  i.image_url,
  i.last_synced_at
`;

/** Map a raw DB row into the API product shape with live-resolved costs. */
function shapeProduct(r, categoryName) {
  const odooWeightKg = toNum(r.volume_weight);
  const odooRawCost  = toNum(r.raw_cost);

  const resolved = resolveProductCost({
    name:              r.name_en || r.name,
    rawCost:           odooRawCost,
    odooWeightKg,
    manualRawCost:     r.manual_raw_cost,
    manualWeightGrams: r.manual_weight_grams,
    manualCostPerKg:   r.manual_cost_per_kg,
  });

  return {
    id:                 r.id,
    odoo_id:            r.odoo_id,
    name:               r.name,
    name_en:            r.name_en,
    name_he:            r.name_he,
    reference:          r.reference,
    uom:                r.uom,
    image_url:          r.image_url,
    category_name:      categoryName ?? null,
    last_synced_at:     r.last_synced_at,
    odoo_archived:      !!r.odoo_archived,

    // Raw Odoo data (what sync imported)
    odoo_weight_kg:     odooWeightKg,
    odoo_raw_cost:      odooRawCost,

    // Manual overrides (null when not overridden) — drive the edit form
    manual_raw_cost:     toNum(r.manual_raw_cost),
    manual_weight_grams: toNum(r.manual_weight_grams),
    manual_cost_per_kg:  toNum(r.manual_cost_per_kg),
    cost_overridden:     !!r.cost_overridden,

    // Effective / resolved values shown in the grid
    raw_cost:               resolved.effectiveRawCost,
    volume_weight:          odooWeightKg,
    weight_extracted_grams: resolved.weightExtractedGrams,
    effective_weight_grams: resolved.weightGrams,
    weight_source:          resolved.weightSource,   // manual|odoo|name_regex|none
    measure:                resolved.measure,        // weight|volume|count|null
    cost_per_kg:            resolved.costPerKg,
    cost_per_kg_source:     resolved.costPerKgSource, // manual|odoo|name_regex|raw_cost|none
    weight_missing:         resolved.weightSource === 'none',
  };
}

// GET /api/products — admin-only listing of raw_material items.
// ?includeArchived=true also returns Odoo-archived products (which are
// stored with is_active = FALSE and odoo_archived = TRUE).
router.get('/', requireAdmin, async (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';

  // Default: only active (non-archived) products.  With the flag, also
  // include archived ones — but never other inactive rows (e.g. products
  // deleted from Odoo, which are is_active = FALSE and odoo_archived = FALSE).
  const whereActive = includeArchived
    ? '(i.is_active = TRUE OR i.odoo_archived = TRUE)'
    : 'i.is_active = TRUE';

  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS},
            c.name AS category_name
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.item_type = 'raw_material'
        AND ${whereActive}
      ORDER BY COALESCE(i.name_en, i.name)`
  );

  res.json(rows.map((r) => shapeProduct(r, r.category_name)));
});

/**
 * PATCH /api/products/:id — manually override cost price, weight and/or
 * cost-per-kg for one raw material.
 *
 * Body (all optional; each accepts a number to set or null to clear):
 *   { manual_raw_cost, manual_weight_kg, manual_cost_per_kg }
 *
 * Weight is accepted in KG from the UI and stored as grams.  Setting any
 * override flips cost_overridden TRUE so the next sync won't clobber the
 * recomputed cost_per_kg; clearing all of them flips it back to FALSE and
 * lets the sync's auto value take over again.
 */
router.patch('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid product id' });
  }

  // A field present in the body is applied (number → set, null → clear);
  // an absent field keeps its current value.
  const body = req.body || {};

  function normalizeMoney(v, label) {
    if (v === null) return { ok: true, value: null };
    const n = toNum(v);
    if (n == null || n < 0) return { ok: false, error: `${label} must be a non-negative number or null` };
    return { ok: true, value: n };
  }

  const updates = {};
  if ('manual_raw_cost' in body) {
    const r = normalizeMoney(body.manual_raw_cost, 'manual_raw_cost');
    if (!r.ok) return res.status(400).json({ error: r.error });
    updates.manual_raw_cost = r.value;
  }
  if ('manual_cost_per_kg' in body) {
    const r = normalizeMoney(body.manual_cost_per_kg, 'manual_cost_per_kg');
    if (!r.ok) return res.status(400).json({ error: r.error });
    updates.manual_cost_per_kg = r.value;
  }
  if ('manual_weight_kg' in body) {
    if (body.manual_weight_kg === null) {
      updates.manual_weight_grams = null;
    } else {
      const kg = toNum(body.manual_weight_kg);
      if (kg == null || kg <= 0) {
        return res.status(400).json({ error: 'manual_weight_kg must be a positive number or null' });
      }
      updates.manual_weight_grams = kg * 1000;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No editable fields provided' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: current } = await client.query(
      `SELECT ${PRODUCT_COLUMNS} FROM items i
        WHERE i.id = $1 AND i.item_type = 'raw_material' FOR UPDATE`,
      [id]
    );
    if (current.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }
    const row = current[0];

    // Merge requested overrides over the existing ones.
    const manualRawCost   = 'manual_raw_cost'    in updates ? updates.manual_raw_cost    : toNum(row.manual_raw_cost);
    const manualWeightG   = 'manual_weight_grams' in updates ? updates.manual_weight_grams : toNum(row.manual_weight_grams);
    const manualCostPerKg = 'manual_cost_per_kg' in updates ? updates.manual_cost_per_kg : toNum(row.manual_cost_per_kg);

    const overridden = manualRawCost != null || manualWeightG != null || manualCostPerKg != null;

    // Recompute the canonical cost_per_kg so BOM costing (which reads
    // items.cost_per_kg) immediately reflects the override.
    const resolved = resolveProductCost({
      name:              row.name_en || row.name,
      rawCost:           toNum(row.raw_cost),
      odooWeightKg:      toNum(row.volume_weight),
      manualRawCost,
      manualWeightGrams: manualWeightG,
      manualCostPerKg,
    });

    await client.query(
      `UPDATE items
          SET manual_raw_cost     = $1,
              manual_weight_grams = $2,
              manual_cost_per_kg  = $3,
              cost_overridden     = $4,
              cost_per_kg         = $5,
              updated_at          = NOW()
        WHERE id = $6`,
      [manualRawCost, manualWeightG, manualCostPerKg, overridden, resolved.costPerKg, id]
    );

    const { rows: after } = await client.query(
      `SELECT ${PRODUCT_COLUMNS},
              c.name AS category_name
         FROM items i
         LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.id = $1`,
      [id]
    );

    await client.query('COMMIT');
    res.json(shapeProduct(after[0], after[0].category_name));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[products] PATCH failed:', err.message);
    res.status(500).json({ error: 'Failed to update product' });
  } finally {
    client.release();
  }
});

module.exports = router;
