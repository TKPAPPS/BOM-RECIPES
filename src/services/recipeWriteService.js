/**
 * recipeWriteService.js
 *
 * Single source of truth for the create-or-replace logic of a recipe
 * BOM.  Both the interactive single-save endpoint (routes/boms.js
 * POST /) and the bulk Excel importer (routes/recipeIO.js) call
 * saveRecipeBom() so the two paths never diverge.
 *
 * The function runs INSIDE a transaction supplied by the caller — the
 * caller owns BEGIN / COMMIT / ROLLBACK.  This lets the importer wrap
 * each recipe in its own transaction (one bad recipe does not roll the
 * whole file back) while the single-save endpoint keeps its existing
 * one-transaction-per-request shape.
 *
 * Throws on validation failure and on circular dependency; the caller
 * maps the thrown Error to the right HTTP status (the messages match
 * what routes/boms.js used to return inline).
 */

const { calculateCostPerKg }    = require('./costingService');
const { resolvePricingForItem } = require('./pricingService');

/**
 * @param {import('pg').PoolClient} client  An open client with a
 *        transaction already begun by the caller.
 * @param {object} payload  Recipe fields (see routes/boms.js POST docs).
 * @param {number|null} userId  Local users.id of the actor (created_by/updated_by).
 * @returns {Promise<{bom_id:number,item_id:number,version:number,
 *           cost_per_kg:number,total_cost:number,
 *           wholesale_price:number|null,retail_price:number|null}>}
 */
async function saveRecipeBom(client, payload, userId) {
  const {
    item_id = null,
    name,
    reference_code,
    yield_kg,
    lines,
    labor_cost = 0,
    overhead_cost = 0,
    packaging_cost = 0,
    recipe_type = 'base',
    full_name = null,
    description = null,
    image_url = null,
    allergens = null,
    is_spicy = false,
    serving_suggestion = null,
    servings_count = null,
    total_weight = null,
    pricing_formula_id = null,
    steps = null,
  } = payload;

  const safeRecipeType = recipe_type === 'final' ? 'final' : 'base';
  const safeAllergens  = Array.isArray(allergens) ? allergens : [];

  // ── Validation (mirrors the inline guards the route used to run) ──
  if (!name || !name.trim()) {
    const err = new Error('name is required');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!yield_kg || yield_kg <= 0) {
    const err = new Error('yield_kg must be a positive number');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    const err = new Error('lines[] must be a non-empty array');
    err.code = 'VALIDATION';
    throw err;
  }

  // Resolve the target item:
  //   1. item_id passed → EDIT a specific recipe row in place (rename
  //      included) so renaming never creates a duplicate.
  //   2. Otherwise → case-insensitive find-or-create on name.
  let itemId;
  if (item_id) {
    const pinned = await client.query(
      `SELECT id FROM items
       WHERE  id = $1 AND item_type = 'recipe' AND is_active = TRUE`,
      [parseInt(item_id, 10)]
    );
    if (!pinned.rows.length) {
      const err = new Error(`Recipe item ${item_id} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    itemId = pinned.rows[0].id;
    await client.query(
      `UPDATE items
       SET    name = $1, name_en = $1, updated_at = NOW()
       WHERE  id = $2`,
      [name.trim(), itemId]
    );
  } else {
    // Find-or-create by name, SCOPED to the same recipe_type.  This lets a
    // final product share a name (and code) with its base recipe without
    // overwriting it — a final "X" matches an existing final "X" only, never
    // the base "X".  Falls back to a plain name match for recipe items that
    // have no active BOM yet (legacy rows).
    const existing = await client.query(
      `SELECT i.id
       FROM   items i
       JOIN   boms b ON b.item_id = i.id AND b.is_active = TRUE
       WHERE  LOWER(i.name) = LOWER($1)
         AND  i.item_type = 'recipe'
         AND  b.recipe_type = $2
       LIMIT 1`,
      [name.trim(), safeRecipeType]
    );
    if (existing.rows.length) {
      itemId = existing.rows[0].id;
    } else {
      const { rows: [newItem] } = await client.query(
        `INSERT INTO items (name, name_en, uom, item_type)
         VALUES ($1, $1, 'kg', 'recipe') RETURNING id`,
        [name.trim()]
      );
      itemId = newItem.id;
    }
  }

  // image_url lives on the items row.  Only touch it when explicitly
  // supplied so a save without an image does not blank an existing one.
  if (image_url !== undefined && image_url !== null) {
    await client.query(
      `UPDATE items SET image_url = $1, updated_at = NOW() WHERE id = $2`,
      [image_url, itemId]
    );
  }

  // Upsert the BOM.  created_by set only on insert (COALESCE preserves
  // the original creator); updated_by always overwritten.
  const { rows: [bom] } = await client.query(
    `INSERT INTO boms (item_id, yield_kg, reference_code, notes, version,
                       labor_cost, overhead_cost, packaging_cost, recipe_type,
                       full_name, description, allergens, is_spicy,
                       serving_suggestion, servings_count, total_weight,
                       pricing_formula_id, created_by, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
     ON CONFLICT (item_id) DO UPDATE
       SET yield_kg            = EXCLUDED.yield_kg,
           reference_code      = EXCLUDED.reference_code,
           labor_cost          = EXCLUDED.labor_cost,
           overhead_cost       = EXCLUDED.overhead_cost,
           packaging_cost      = EXCLUDED.packaging_cost,
           recipe_type         = EXCLUDED.recipe_type,
           full_name           = EXCLUDED.full_name,
           description         = EXCLUDED.description,
           allergens           = EXCLUDED.allergens,
           is_spicy            = EXCLUDED.is_spicy,
           serving_suggestion  = EXCLUDED.serving_suggestion,
           servings_count      = EXCLUDED.servings_count,
           total_weight        = EXCLUDED.total_weight,
           pricing_formula_id  = EXCLUDED.pricing_formula_id,
           updated_by          = EXCLUDED.updated_by,
           version             = boms.version + 1,
           is_active           = TRUE,
           updated_at          = NOW()
     RETURNING *`,
    [
      itemId, yield_kg, reference_code || null,
      parseFloat(labor_cost)     || 0,
      parseFloat(overhead_cost)  || 0,
      parseFloat(packaging_cost) || 0,
      safeRecipeType,
      full_name, description, safeAllergens, !!is_spicy,
      serving_suggestion,
      servings_count ? parseInt(servings_count) : null,
      total_weight   ? parseFloat(total_weight) : null,
      pricing_formula_id ? parseInt(pricing_formula_id) : null,
      userId,
    ]
  );

  // Replace all lines for this BOM
  await client.query(`DELETE FROM bom_lines WHERE bom_id = $1`, [bom.id]);

  for (const line of lines) {
    if (!line.ingredient_item_id || !(line.quantity_kg > 0)) continue;

    const lineUom  = (line.line_uom || 'kg').toString().trim().toLowerCase();
    const wastePct = parseFloat(line.waste_pct) || 0;

    const { rows: ingRows } = await client.query(
      `SELECT cost_per_kg, item_type FROM items WHERE id = $1`,
      [line.ingredient_item_id]
    );
    const ing = ingRows[0] || {};
    const snapshotPpk  = ing.cost_per_kg != null ? parseFloat(ing.cost_per_kg) : null;
    const effectiveQty = parseFloat(line.quantity_kg) / Math.max(1 - wastePct / 100, 0.001);
    const lineCost     = snapshotPpk != null ? effectiveQty * snapshotPpk : null;

    const stepNumber = Number.isFinite(parseInt(line.step_number, 10))
      ? parseInt(line.step_number, 10)
      : null;

    await client.query(
      `INSERT INTO bom_lines
         (bom_id, ingredient_item_id, ingredient_type,
          quantity_kg, line_uom, waste_pct,
          price_per_kg_snapshot, line_cost, step_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        bom.id,
        line.ingredient_item_id,
        ing.item_type || null,
        line.quantity_kg,
        lineUom,
        wastePct,
        snapshotPpk,
        lineCost,
        stepNumber,
      ]
    );
  }

  // ── Preparation steps (name + process description per step) ──
  // Replace all step metadata for this BOM.  bom_lines.step_number above
  // links each ingredient to its step; this table holds the step's
  // name + description.  Recipes saved without steps simply clear it.
  await client.query(`DELETE FROM bom_steps WHERE bom_id = $1`, [bom.id]);
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const n = parseInt(step.step_number, 10);
      if (!Number.isFinite(n)) continue;
      await client.query(
        `INSERT INTO bom_steps (bom_id, step_number, step_name, description)
         VALUES ($1, $2, $3, $4)`,
        [bom.id, n, step.step_name || null, step.description || null]
      );
    }
  }

  // Calculate and persist recipe cost — throws on circular dependency
  const costPerKg = await calculateCostPerKg(itemId, new Set(), client);
  const totalCost = costPerKg * parseFloat(yield_kg);

  // Stored price snapshots for final recipes (engine remains the
  // source of truth; these are card-stability snapshots).
  let wholesalePrice    = null;
  let retailPrice       = null;
  let snapshotFormula   = null;
  let snapshotSelection = null;
  if (safeRecipeType === 'final') {
    try {
      const pricing = await resolvePricingForItem(itemId, client);
      wholesalePrice    = pricing.wholesale_price ?? null;
      retailPrice       = pricing.retail_price    ?? null;
      snapshotFormula   = pricing.formula;
      snapshotSelection = pricing.selection;
    } catch (err) {
      console.warn('[saveRecipeBom] price snapshot skipped:', err.message);
    }
  }

  await client.query(
    `UPDATE boms
     SET    cost_per_kg = $1, total_cost = $2,
            wholesale_price = $3, retail_price = $4
     WHERE  id = $5`,
    [costPerKg, totalCost, wholesalePrice, retailPrice, bom.id]
  );

  // ── BOM Version Snapshot (immutable) ─────────────────────────────
  const { rows: snapLines } = await client.query(
    `SELECT l.ingredient_item_id AS ingredient_id,
            COALESCE(ing.name_en, ing.name) AS ingredient,
            l.quantity_kg,
            l.line_uom,
            l.waste_pct,
            l.ingredient_type,
            ing.cost_per_kg,
            (l.quantity_kg / GREATEST(1 - l.waste_pct / 100, 0.001)) * ing.cost_per_kg AS line_cost
     FROM   bom_lines l
     JOIN   items ing ON ing.id = l.ingredient_item_id
     WHERE  l.bom_id = $1
     ORDER BY l.id`,
    [bom.id]
  );

  const snapshot = {
    yield_kg:          parseFloat(yield_kg),
    cost_per_kg:       costPerKg,
    total_cost:        totalCost,
    labor_cost:        parseFloat(labor_cost)     || 0,
    overhead_cost:     parseFloat(overhead_cost)  || 0,
    packaging_cost:    parseFloat(packaging_cost) || 0,
    wholesale_price:   wholesalePrice,
    retail_price:      retailPrice,
    pricing_formula:   snapshotFormula,
    pricing_selection: snapshotSelection,
    ingredients:       snapLines,
  };

  await client.query(
    `INSERT INTO bom_snapshots
       (bom_id, item_id, version, yield_kg, cost_per_kg, total_cost,
        labor_cost, overhead_cost, packaging_cost, reference_code, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      bom.id, itemId, bom.version, parseFloat(yield_kg), costPerKg, totalCost,
      parseFloat(labor_cost) || 0, parseFloat(overhead_cost) || 0,
      parseFloat(packaging_cost) || 0,
      reference_code || null,
      JSON.stringify(snapshot),
    ]
  );

  // Cost History Ledger
  await client.query(
    `INSERT INTO cost_history (item_id, cost_per_kg, source)
     VALUES ($1, $2, 'bom_save')`,
    [itemId, costPerKg]
  );

  return {
    bom_id:          bom.id,
    item_id:         itemId,
    version:         bom.version,
    cost_per_kg:     costPerKg,
    total_cost:      totalCost,
    wholesale_price: wholesalePrice,
    retail_price:    retailPrice,
  };
}

module.exports = { saveRecipeBom };
