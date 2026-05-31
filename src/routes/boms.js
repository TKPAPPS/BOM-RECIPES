const express = require('express');
const pool    = require('../config/db');
const { resolvePricingForItem } = require('../services/pricingService');
const { calculateForOutput }    = require('../services/calculationService');
const { saveRecipeBom }         = require('../services/recipeWriteService');
const { requireAdmin }      = require('../middleware/authMiddleware');
const { logAudit, getIp }   = require('../services/auditService');

const router = express.Router();

// GET /boms/summary — small counts payload for the admin Dashboard.
// Admin-only intentionally: even though no prices are returned, the
// "user count" portion is sensitive metadata.
router.get('/summary', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE b.recipe_type = 'base')::int  AS base_count,
       COUNT(*) FILTER (WHERE b.recipe_type = 'final')::int AS final_count,
       COUNT(*)::int AS total_recipes
     FROM boms b
     WHERE b.is_active = TRUE`
  );
  const { rows: prodRows } = await pool.query(
    `SELECT COUNT(*)::int AS active_products
     FROM items WHERE item_type='raw_material' AND is_active=TRUE`
  );
  const { rows: userRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE role='admin'    AND is_active=TRUE)::int AS admin_count,
       COUNT(*) FILTER (WHERE role='customer' AND is_active=TRUE)::int AS customer_count,
       COUNT(*) FILTER (WHERE is_active=FALSE)::int                    AS inactive_count
     FROM users`
  );
  res.json({
    recipes:  rows[0],
    products: prodRows[0],
    users:    userRows[0],
  });
});

// ── READS — open to all authenticated users (admin + customer) ─────
// The pricesMiddleware wrapper in app.js automatically strips price
// fields from these responses for users without view-price permission.

// GET /boms — list active BOMs; optional ?type=base|final filter.
// Pricing fields are resolved via the formula-selection engine
// (one source of truth for the priority chain), then computed
// per-yield for display.
router.get('/', async (req, res) => {
  const { type } = req.query;
  const typeFilter = type === 'base' || type === 'final' ? type : null;

  const { rows } = await pool.query(
    `SELECT b.id,
            b.item_id,
            COALESCE(i.name_en, i.name) AS recipe_name,
            b.full_name,
            b.reference_code,
            b.recipe_type,
            b.yield_kg,
            b.total_weight,
            b.servings_count,
            b.is_spicy,
            b.allergens,
            b.pricing_formula_id,
            i.image_url,
            i.cost_per_kg,
            b.total_cost,
            b.wholesale_price,
            b.retail_price,
            b.version,
            b.created_at,
            b.updated_at,
            b.created_by,
            b.updated_by,
            COUNT(l.id)::int AS line_count
     FROM   boms b
     JOIN   items i ON i.id = b.item_id
     LEFT JOIN bom_lines l ON l.bom_id = b.id
     WHERE  b.is_active = TRUE
       AND  ($1::text IS NULL OR b.recipe_type = $1)
     GROUP BY b.id, i.id, i.name_en, i.name, i.cost_per_kg, i.category_id, i.image_url
     ORDER BY b.updated_at DESC`,
    [typeFilter]
  );

  // Resolve live pricing per row via the engine.  Parallel to keep
  // latency low; each call is 2 small indexed lookups (~ms) so 100s
  // of recipes still respond well under a second.
  const enriched = await Promise.all(rows.map(async (r) => {
    const p = await resolvePricingForItem(r.item_id);
    const totalCost = r.total_cost != null ? parseFloat(r.total_cost) : null;
    return {
      ...r,
      wholesale_multiplier: p.wholesale_multiplier,
      retail_multiplier:    p.retail_multiplier,
      wholesale_for_yield:
        totalCost != null && p.wholesale_multiplier != null
          ? totalCost * p.wholesale_multiplier
          : null,
      retail_for_yield:
        totalCost != null && p.retail_multiplier != null
          ? totalCost * p.retail_multiplier
          : null,
      formula_name:      p.formula.name,
      pricing_selection: p.selection, // 'manual' | 'auto'
    };
  }));

  res.json(enriched);
});

// GET /boms/:itemId — fetch BOM with lines for a recipe
router.get('/:itemId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id,
            b.item_id,
            b.reference_code,
            b.full_name,
            b.description,
            b.allergens,
            b.is_spicy,
            b.serving_suggestion,
            b.servings_count,
            b.total_weight,
            b.recipe_type,
            b.yield_kg,
            b.notes,
            b.version,
            b.labor_cost,
            b.overhead_cost,
            b.packaging_cost,
            b.wholesale_price,
            b.retail_price,
            b.pricing_formula_id,
            b.created_by,
            b.updated_by,
            b.created_at,
            b.updated_at,
            COALESCE(i.name_en, i.name) AS recipe_name,
            i.image_url,
            i.cost_per_kg,
            json_agg(json_build_object(
              'line_id',                 l.id,
              'ingredient_id',           l.ingredient_item_id,
              'ingredient',              COALESCE(ing.name_en, ing.name),
              'name_en',                 ing.name_en,
              'name_he',                 ing.name_he,
              'reference',               ing.reference,
              'ingredient_type',         l.ingredient_type,
              'quantity_kg',             l.quantity_kg,
              'line_uom',                l.line_uom,
              'waste_pct',               l.waste_pct,
              'cost_per_kg',             ing.cost_per_kg,
              'price_per_kg_snapshot',   l.price_per_kg_snapshot,
              'line_cost',               COALESCE(
                                           l.line_cost,
                                           (l.quantity_kg / GREATEST(1 - l.waste_pct / 100, 0.001)) * ing.cost_per_kg
                                         ),
              'image_url',               ing.image_url,
              'unit',                    ing.uom,
              'item_type',               ing.item_type
            ) ORDER BY l.id) AS lines
     FROM   boms b
     JOIN   items i   ON i.id = b.item_id
     JOIN   bom_lines l   ON l.bom_id = b.id
     JOIN   items ing ON ing.id = l.ingredient_item_id
     WHERE  b.item_id = $1 AND b.is_active = TRUE
     GROUP BY b.id, i.name_en, i.name, i.image_url, i.cost_per_kg`,
    [req.params.itemId]
  );
  if (!rows.length) return res.status(404).json({ error: 'BOM not found' });
  res.json(rows[0]);
});

// POST /boms/:itemId/calculate — customer-accessible quantity scaler.
// Body: { desired_weight_kg: number }
//
// Scales every bom_line from the recipe's yield_kg (the costing
// denominator) to the requested output weight, recursing into nested
// base recipes.  Cost numbers come from the formula-selection engine;
// price fields are stripped automatically by pricesMiddleware for
// customers without view-price permission.
//
// Audited on every run (action_type='quantity_calculation').  NO
// requireAdmin — this is the one mutation-style customer endpoint
// per the role spec ("Customer may access ONLY: view recipes + the
// quantity-calculation endpoint").
router.post('/:itemId/calculate', async (req, res) => {
  const itemId = parseInt(req.params.itemId);
  const desiredWeightKg = parseFloat(req.body?.desired_weight_kg);

  if (!itemId) return res.status(400).json({ error: 'invalid item id' });
  if (!Number.isFinite(desiredWeightKg) || desiredWeightKg <= 0) {
    return res.status(400).json({ error: 'desired_weight_kg must be a positive number' });
  }

  try {
    const result = await calculateForOutput(itemId, desiredWeightKg);

    await logAudit({
      userId:      req.localUser?.id ?? null,
      actionType:  'quantity_calculation',
      entity:      'recipe',
      entityId:    itemId,
      description: `User "${req.localUser?.username}" calculated ${desiredWeightKg} kg of recipe ${itemId} (${result.recipe_name}).`,
      valueAfter:  {
        desired_weight_kg: desiredWeightKg,
        yield_kg:          result.yield_kg,
        scale_factor:      result.scale_factor,
      },
      ipAddress:   getIp(req),
    });

    res.json(result);
  } catch (err) {
    if (err.message && err.message.includes('Circular dependency')) {
      return res.status(422).json({ error: err.message });
    }
    if (err.message && err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message && err.message.includes('not a recipe')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[POST /boms/:itemId/calculate]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /boms/:itemId/snapshots — full version history (admin only:
// snapshots are an audit trail and they include cost data the
// customer should not see)
router.get('/:itemId/snapshots', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.version, s.yield_kg, s.cost_per_kg, s.total_cost,
            s.labor_cost, s.overhead_cost, s.packaging_cost,
            s.reference_code, s.snapshot, s.created_at
     FROM   bom_snapshots s
     JOIN   boms b ON b.id = s.bom_id
     WHERE  b.item_id = $1
     ORDER BY s.version DESC`,
    [req.params.itemId]
  );
  res.json(rows);
});

// ── WRITES — admin only ────────────────────────────────────────────

// POST /boms — create or replace a BOM
// Payload (additions from STEP 1 are all optional):
//   { name, reference_code, yield_kg, recipe_type,
//     labor_cost, overhead_cost, packaging_cost,
//     full_name, description, allergens, is_spicy,
//     serving_suggestion, servings_count, total_weight,
//     pricing_formula_id,
//     lines: [{ ingredient_item_id, quantity_kg, line_uom, waste_pct }] }
router.post('/', requireAdmin, async (req, res) => {
  const { name, yield_kg, lines } = req.body;

  // Cheap pre-flight validation so obvious bad requests get a 400
  // before we open a transaction (the service re-validates too).
  if (!name || !name.trim())
    return res.status(400).json({ error: 'name is required' });
  if (!yield_kg || yield_kg <= 0)
    return res.status(400).json({ error: 'yield_kg must be a positive number' });
  if (!Array.isArray(lines) || lines.length === 0)
    return res.status(400).json({ error: 'lines[] must be a non-empty array' });

  const userId = req.localUser?.id ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await saveRecipeBom(client, req.body, userId);
    await client.query('COMMIT');
    res.status(201).json({ ...result, message: 'BOM saved and costs recalculated' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === 'NOT_FOUND')
      return res.status(404).json({ error: err.message });
    if (err.code === 'VALIDATION')
      return res.status(400).json({ error: err.message });
    if (err.message && err.message.includes('Circular dependency'))
      return res.status(422).json({ error: err.message });
    console.error('[POST /boms]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /boms/:id — deactivate a BOM (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE boms SET is_active = FALSE WHERE id = $1`, [req.params.id]);
  res.json({ message: 'BOM deactivated' });
});

module.exports = router;
