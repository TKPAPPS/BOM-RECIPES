const express = require('express');
const pool    = require('../config/db');
const {
  resolvePricingForItem,
  fetchDefaultFormula,
  fetchFormulaById,
} = require('../services/pricingService');
const { applyFormula }          = require('../utils/formulaEval');

// Last-resort pricing if no active default formula exists (mirrors the
// HARDCODED_DEFAULT in pricingService).  Used by the batch list resolver.
const HARDCODED_PRICING = {
  name: null,
  wholesale_multiplier: 2.5,
  retail_multiplier:    5.0,
  wholesale_formula:    null,
  retail_formula:       null,
};
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
    `SELECT
       COUNT(*) FILTER (WHERE is_active = TRUE AND NOT odoo_archived)::int AS active_products,
       COUNT(*) FILTER (WHERE odoo_archived)::int                          AS archived_products
     FROM items WHERE item_type='raw_material'`
  );
  const { rows: testRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='pending')::int AS pending_count,
       COUNT(*) FILTER (WHERE status='draft')::int   AS draft_count,
       COUNT(*)::int                                  AS total
     FROM test_recipes`
  );
  const { rows: userRows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE role='manager'  AND is_active=TRUE)::int AS manager_count,
       COUNT(*) FILTER (WHERE role='admin'    AND is_active=TRUE)::int AS admin_count,
       COUNT(*) FILTER (WHERE role='customer' AND is_active=TRUE)::int AS customer_count,
       COUNT(*) FILTER (WHERE is_active=FALSE)::int                    AS inactive_count
     FROM users`
  );
  res.json({
    recipes:      rows[0],
    products:     prodRows[0],
    test_recipes: testRows[0],
    users:        userRows[0],
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
  // Default list hides archived recipes; ?archived=true shows only archived.
  const archivedFilter = req.query.archived === 'true';

  const { rows } = await pool.query(
    `SELECT b.id,
            b.item_id,
            COALESCE(i.name_en, i.name) AS recipe_name,
            b.full_name,
            b.reference_code,
            b.recipe_type,
            b.sale_uom,
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
       AND  i.is_active = TRUE
       AND  b.archived = $2
       AND  ($1::text IS NULL OR b.recipe_type = $1)
     GROUP BY b.id, i.id, i.name_en, i.name, i.cost_per_kg, i.category_id, i.image_url
     ORDER BY b.updated_at DESC`,
    [typeFilter, archivedFilter]
  );

  // Resolve live pricing in BATCH — avoid the per-recipe N+1 (which on a
  // remote DB cost ~3 round-trips × every recipe).  The default formula is
  // shared by all auto-priced recipes, so fetch it ONCE; only the few
  // recipes that PIN a specific formula need an extra lookup (deduped).
  const defaultFormula = await fetchDefaultFormula(pool).catch(() => null);
  const pinnedIds = [...new Set(rows.map((r) => r.pricing_formula_id).filter(Boolean))];
  const pinnedPairs = await Promise.all(pinnedIds.map(async (id) => {
    try { return [id, await fetchFormulaById(pool, id)]; } catch { return [id, null]; }
  }));
  const pinnedMap = new Map(pinnedPairs);

  const enriched = rows.map((r) => {
    const pinned   = r.pricing_formula_id ? pinnedMap.get(r.pricing_formula_id) : null;
    const formula  = pinned || defaultFormula || HARDCODED_PRICING;
    const totalCost = r.total_cost != null ? parseFloat(r.total_cost) : null;
    return {
      ...r,
      wholesale_multiplier: formula?.wholesale_multiplier ?? null,
      retail_multiplier:    formula?.retail_multiplier ?? null,
      // Evaluate the formula on the TOTAL cost (exact — supports rounding),
      // falling back to total × multiplier.
      wholesale_for_yield: applyFormula(formula?.wholesale_formula, formula?.wholesale_multiplier, totalCost),
      retail_for_yield:    applyFormula(formula?.retail_formula,    formula?.retail_multiplier,    totalCost),
      formula_name:        formula?.name ?? null,
      pricing_selection:   pinned ? 'manual' : 'auto',
    };
  });

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
            b.sale_uom,
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
              'reference',               COALESCE(ing.reference, ing_bom.reference_code),
              'ingredient_type',         l.ingredient_type,
              'step_number',             l.step_number,
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
            ) ORDER BY l.id) AS lines,
            (SELECT json_agg(json_build_object(
                      'step_number', st.step_number,
                      'step_name',   st.step_name,
                      'description', st.description
                    ) ORDER BY st.step_number)
             FROM bom_steps st WHERE st.bom_id = b.id) AS steps
     FROM   boms b
     JOIN   items i   ON i.id = b.item_id
     JOIN   bom_lines l   ON l.bom_id = b.id
     JOIN   items ing ON ing.id = l.ingredient_item_id
     -- For sub-recipe ingredients, pull the recipe's own code (lives on
     -- boms.reference_code, not items.reference) for the REF CODE column.
     LEFT JOIN boms ing_bom ON ing_bom.item_id = ing.id AND ing_bom.is_active = TRUE
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

// DELETE /boms/:id — PERMANENTLY delete a recipe (admin only).
// Deletes the recipe's items row; FK CASCADE removes its boms, bom_lines,
// bom_steps, bom_snapshots and cost_history.  The bom_lines.ingredient_item_id
// FK is NO ACTION, so this fails cleanly if the recipe is still used as a
// sub-recipe in another recipe — caught and reported as 409 'in_use'.
router.delete('/:id', requireAdmin, async (req, res) => {
  const bomId = parseInt(req.params.id, 10);
  if (!Number.isInteger(bomId)) return res.status(400).json({ error: 'invalid id' });
  const { rows } = await pool.query(`SELECT item_id FROM boms WHERE id = $1`, [bomId]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const itemId = rows[0].item_id;

  // Blocked only by LIVE recipes (active & not archived) that use it.
  // References from archived / soft-deleted recipes are stale → cleaned.
  const { rows: parents } = await pool.query(
    `SELECT DISTINCT COALESCE(i.name_en, i.name) AS name
       FROM bom_lines l
       JOIN boms  b ON b.id = l.bom_id
       JOIN items i ON i.id = b.item_id
      WHERE l.ingredient_item_id = $1
        AND b.item_id <> $1
        AND b.is_active = TRUE
        AND b.archived  = FALSE
        AND i.is_active = TRUE
      ORDER BY name LIMIT 20`,
    [itemId]
  );
  if (parents.length) {
    const usedBy = parents.map((r) => r.name);
    const list = usedBy.slice(0, 5).join(', ') + (usedBy.length > 5 ? `, +${usedBy.length - 5} more` : '');
    return res.status(409).json({
      error: 'in_use',
      usedBy,
      message: `This recipe is used as a sub-recipe in: ${list}. Remove it from those recipes first, or archive it instead.`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM boms WHERE item_id = $1`, [itemId]);
    await client.query(`DELETE FROM bom_lines WHERE ingredient_item_id = $1`, [itemId]); // stale refs from archived/inactive
    await client.query(`DELETE FROM items WHERE id = $1 AND item_type = 'recipe'`, [itemId]);
    await client.query('COMMIT');
    res.json({ message: 'Recipe permanently deleted' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ── Bulk actions (keyed by item_id, matching the list's selection) ──
// Helper: validate and normalise an itemIds[] body into a clean int[].
function parseItemIds(body) {
  const raw = Array.isArray(body?.itemIds) ? body.itemIds : [];
  const ids = [...new Set(raw.map((n) => parseInt(n, 10)).filter(Number.isInteger))];
  return ids;
}

// POST /boms/bulk-delete — PERMANENTLY delete many recipes by item_id.
// A recipe can't be deleted while it's used as a sub-recipe by a recipe
// we are NOT deleting (it would break that parent) — those are reported
// as `blocked`.  Everything else is removed in a single fast transaction
// (a few queries total, not one-per-recipe).
router.post('/bulk-delete', requireAdmin, async (req, res) => {
  const ids = parseItemIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'itemIds[] must be a non-empty array' });

  // Fixed-point: drop any selected recipe still used as an ingredient by a
  // LIVE recipe (active & not archived) outside the (shrinking) set —
  // those are the only real blockers.  References from archived or
  // soft-deleted recipes are stale and get cleaned up on delete below.
  // One query per round (= chain depth), not O(n²).
  const candidate = new Set(ids);
  for (;;) {
    if (!candidate.size) break;
    const arr = [...candidate];
    const { rows } = await pool.query(
      `SELECT DISTINCT l.ingredient_item_id AS id
         FROM   bom_lines l
         JOIN   boms b   ON b.id = l.bom_id
         JOIN   items pi ON pi.id = b.item_id
        WHERE   l.ingredient_item_id = ANY($1::int[])
          AND   b.item_id <> ALL($1::int[])
          AND   b.is_active = TRUE
          AND   b.archived  = FALSE
          AND   pi.is_active = TRUE`,
      [arr]
    );
    if (!rows.length) break;                 // nothing else blocked → stable
    for (const r of rows) candidate.delete(r.id);
  }

  const deletable = [...candidate];
  const blocked   = ids.filter((id) => !candidate.has(id));

  let deleted = 0;
  if (deletable.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 1) Delete the recipes' own BOMs (cascades their bom_lines).
      await client.query(`DELETE FROM boms WHERE item_id = ANY($1::int[])`, [deletable]);
      // 2) Clear any remaining references to these items — they can only
      //    come from archived/soft-deleted recipes now (live ones were
      //    excluded above), so removing them is safe.
      await client.query(`DELETE FROM bom_lines WHERE ingredient_item_id = ANY($1::int[])`, [deletable]);
      // 3) Delete the items themselves.
      const del = await client.query(
        `DELETE FROM items WHERE id = ANY($1::int[]) AND item_type = 'recipe'`,
        [deletable]
      );
      deleted = del.rowCount;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  res.json({ message: 'Recipes deleted', count: deleted, blocked });
});

// POST /boms/bulk-archive — set archived flag for many recipes.
// Body: { itemIds: [...], archived?: boolean }  (archived defaults to true)
router.post('/bulk-archive', requireAdmin, async (req, res) => {
  const ids = parseItemIds(req.body);
  if (!ids.length) return res.status(400).json({ error: 'itemIds[] must be a non-empty array' });
  const archived = req.body?.archived === false ? false : true;
  const { rowCount } = await pool.query(
    `UPDATE boms SET archived = $2, updated_at = NOW()
      WHERE item_id = ANY($1::int[]) AND is_active = TRUE`,
    [ids, archived]
  );
  res.json({ message: archived ? 'Recipes archived' : 'Recipes unarchived', count: rowCount });
});

module.exports = router;
