/**
 * calculationService.js
 *
 * Customer-facing quantity calculator.  Given a recipe + a desired
 * output weight, recursively expands every BOM line into the
 * required ingredient quantities (raw materials AND nested base
 * recipes via items.item_type='recipe') and computes the per-line +
 * per-batch cost using the SAME math as the costing service so the
 * results agree with whatever the recipe was costed at.
 *
 * Math (matches src/services/costingService.js — do NOT diverge):
 *
 *   scale_factor       = desired_weight_kg / boms.yield_kg
 *
 *   per line:
 *     waste_factor     = 1 - waste_pct / 100
 *     scaled_input_kg  = (quantity_kg / waste_factor) * scale_factor
 *     line_cost        = scaled_input_kg * ingredient_cost_per_kg
 *                        (for sub-recipes, line_cost is the recursive
 *                         total_cost of the sub-tree at scaled_input_kg)
 *
 *   per batch (additive on top of material cost):
 *     labor / overhead / packaging are per-yield costs from the BOM;
 *     they scale linearly with output → multiplied by scale_factor.
 *
 *   total_cost  = Σ line_cost + (labor + overhead + packaging) * scale
 *   cost_per_kg = total_cost / desired_weight_kg
 *
 * IMPORTANT — yield_kg vs. total_weight:
 *   yield_kg     is the costing denominator (the weight the recipe
 *                was costed against, what actually comes off the line
 *                before packaging shrinkage).  Quantity scaling uses
 *                yield_kg only.
 *   total_weight is the consumer-facing net weight on the recipe
 *                card (set on the BOM in STEP 1).  It is NEVER used
 *                in this math — using it would inflate / deflate
 *                ingredient quantities relative to what the costing
 *                service computed.
 *
 * Circular-dep protection mirrors the costing service: an ancestor
 * Set is threaded through the recursion and throws before any
 * partial result is returned.
 *
 * Stripping of price fields (cost_per_kg, line_cost, etc.) for users
 * without view-price permission is handled centrally by
 * pricesMiddleware in app.js — this service always computes the full
 * numbers and lets the middleware filter on egress.
 */

const pool = require('../config/db');
const { resolvePricingForItem } = require('./pricingService');

/**
 * Public entry point.  Validates inputs, runs the recursive
 * expansion, attaches live pricing from the formula engine, and
 * aggregates raw-material quantities across the whole tree (handy
 * for shopping-list use cases where the same flour appears in
 * multiple sub-recipes).
 *
 * @param {number} itemId
 * @param {number} desiredWeightKg
 * @returns {Promise<object>}
 */
async function calculateForOutput(itemId, desiredWeightKg) {
  if (!Number.isFinite(desiredWeightKg) || desiredWeightKg <= 0) {
    throw new Error('desired_weight_kg must be a positive number');
  }

  const tree = await expand(itemId, desiredWeightKg, new Set(), pool);

  // Live pricing on the TOP-LEVEL recipe.  cost_per_kg here is what
  // the engine returned from items.cost_per_kg — it should agree
  // with tree.cost_per_kg because the math is identical, but we
  // expose the engine's value separately so callers can see which
  // formula was applied + whether it was manual.
  let pricing = null;
  try {
    pricing = await resolvePricingForItem(itemId);
  } catch (_) {
    // No-op: a recipe with no cost yet still produces a valid
    // quantity breakdown; pricing simply stays null.
  }

  // Per-batch wholesale / retail totals from the resolver's per-kg
  // prices, scaled to the requested output weight.
  const wholesaleTotal =
    pricing && pricing.wholesale_price != null
      ? pricing.wholesale_price * desiredWeightKg
      : null;
  const retailTotal =
    pricing && pricing.retail_price != null
      ? pricing.retail_price * desiredWeightKg
      : null;

  return {
    ...tree,
    pricing,
    wholesale_total: wholesaleTotal,
    retail_total:    retailTotal,
    aggregated_raw_materials: aggregateRawMaterials(tree),
  };
}

// ── Recursive expansion ─────────────────────────────────────────────

async function expand(itemId, desiredWeightKg, ancestors, db) {
  if (ancestors.has(itemId)) {
    const cycle = [...ancestors, itemId].join(' → ');
    throw new Error(`Circular dependency detected: ${cycle}`);
  }

  // Recipe header (item + active BOM) in one round-trip
  const { rows: headRows } = await db.query(
    `SELECT i.id, COALESCE(i.name_en, i.name) AS name, i.item_type,
            i.image_url, i.uom,
            b.id           AS bom_id,
            b.yield_kg,
            b.recipe_type,
            b.labor_cost,
            b.overhead_cost,
            b.packaging_cost
     FROM   items i
     LEFT JOIN boms b ON b.item_id = i.id AND b.is_active = TRUE
     WHERE  i.id = $1 AND i.is_active = TRUE`,
    [itemId]
  );
  if (!headRows.length) throw new Error(`Item ${itemId} not found or inactive`);
  const head = headRows[0];

  if (head.item_type !== 'recipe' || !head.bom_id) {
    throw new Error(`Item ${itemId} ("${head.name}") is not a recipe with an active BOM`);
  }

  const yieldKg = parseFloat(head.yield_kg);
  if (!(yieldKg > 0)) {
    throw new Error(`Recipe "${head.name}" has invalid yield_kg`);
  }
  const scale = desiredWeightKg / yieldKg;

  // BOM lines + ingredient metadata in one round-trip
  const { rows: lineRows } = await db.query(
    `SELECT l.id AS line_id, l.ingredient_item_id,
            l.quantity_kg, l.waste_pct, l.line_uom, l.step_number,
            l.ingredient_type AS line_ingredient_type,
            ing.id     AS ing_id,
            COALESCE(ing.name_en, ing.name) AS ing_name,
            ing.item_type   AS ing_type,
            ing.cost_per_kg AS ing_cost_per_kg,
            ing.uom         AS ing_uom,
            ing.image_url   AS ing_image,
            ing.reference   AS ing_reference
     FROM   bom_lines l
     JOIN   items ing ON ing.id = l.ingredient_item_id
     WHERE  l.bom_id = $1
     ORDER  BY l.id`,
    [head.bom_id]
  );

  const newAncestors = new Set(ancestors).add(itemId);
  const ingredients = [];
  let materialCost = 0;

  for (const line of lineRows) {
    const wastePct    = parseFloat(line.waste_pct) || 0;
    const wasteFactor = Math.max(1 - wastePct / 100, 0.001);
    const inputPerYield = parseFloat(line.quantity_kg);
    const scaledInputKg = (inputPerYield / wasteFactor) * scale;

    let lineCost = null;
    let subRecipe = null;

    if (line.ing_type === 'recipe') {
      // Recurse: this ingredient is itself a recipe that must be
      // expanded to produce `scaledInputKg` of itself.
      subRecipe = await expand(
        line.ingredient_item_id,
        scaledInputKg,
        newAncestors,
        db
      );
      lineCost = subRecipe.total_cost;
    } else if (line.ing_cost_per_kg != null) {
      lineCost = scaledInputKg * parseFloat(line.ing_cost_per_kg);
    }

    materialCost += lineCost || 0;

    ingredients.push({
      line_id:           line.line_id,
      ingredient_id:     line.ing_id,
      ingredient_name:   line.ing_name,
      ingredient_type:   line.ing_type,            // 'raw_material' | 'recipe'
      step_number:       line.step_number,
      reference:         line.ing_reference,
      image_url:         line.ing_image,
      unit:              line.ing_uom,
      base_quantity_kg:  inputPerYield,            // qty per recipe yield (unchanged)
      waste_pct:         wastePct,
      scaled_quantity_kg: scaledInputKg,           // what to actually weigh out
      cost_per_kg:       line.ing_cost_per_kg != null ? parseFloat(line.ing_cost_per_kg) : null,
      line_cost:         lineCost,
      sub_recipe:        subRecipe,                // nested calc tree | null
    });
  }

  // Per-batch costs scale linearly with output weight
  const laborTotal     = parseFloat(head.labor_cost     || 0) * scale;
  const overheadTotal  = parseFloat(head.overhead_cost  || 0) * scale;
  const packagingTotal = parseFloat(head.packaging_cost || 0) * scale;

  const totalCost = materialCost + laborTotal + overheadTotal + packagingTotal;
  const costPerKg = desiredWeightKg > 0 ? totalCost / desiredWeightKg : null;

  // Preparation steps (name + process text) for this recipe, so the
  // kitchen view can group the scaled ingredients by step.
  const { rows: stepRows } = await db.query(
    `SELECT step_number, step_name, description
     FROM   bom_steps WHERE bom_id = $1 ORDER BY step_number`,
    [head.bom_id]
  );

  return {
    recipe_id:         itemId,
    recipe_name:       head.name,
    recipe_type:       head.recipe_type,
    image_url:         head.image_url,
    yield_kg:          yieldKg,                    // costing denominator (NOT total_weight)
    desired_weight_kg: desiredWeightKg,
    scale_factor:      scale,
    ingredients,
    steps:             stepRows,
    material_cost_total:  materialCost,
    labor_cost_total:     laborTotal,
    overhead_cost_total:  overheadTotal,
    packaging_cost_total: packagingTotal,
    total_cost:           totalCost,
    cost_per_kg:          costPerKg,
  };
}

// ── Aggregation: flatten tree → shopping list of raw materials ──────

function aggregateRawMaterials(tree, acc = new Map()) {
  for (const ing of tree.ingredients) {
    if (ing.ingredient_type === 'recipe' && ing.sub_recipe) {
      aggregateRawMaterials(ing.sub_recipe, acc);
      continue;
    }
    if (ing.ingredient_type !== 'raw_material') continue;

    const existing = acc.get(ing.ingredient_id);
    if (existing) {
      existing.total_quantity_kg += ing.scaled_quantity_kg;
      if (existing.total_cost != null && ing.line_cost != null) {
        existing.total_cost += ing.line_cost;
      } else if (ing.line_cost != null && existing.total_cost == null) {
        // Promote from null to a real sum if a later occurrence has cost data
        existing.total_cost = ing.line_cost;
      }
    } else {
      acc.set(ing.ingredient_id, {
        ingredient_id:     ing.ingredient_id,
        ingredient_name:   ing.ingredient_name,
        reference:         ing.reference,
        image_url:         ing.image_url,
        unit:              ing.unit,
        cost_per_kg:       ing.cost_per_kg,
        total_quantity_kg: ing.scaled_quantity_kg,
        total_cost:        ing.line_cost,
      });
    }
  }
  return [...acc.values()].sort((a, b) =>
    (a.ingredient_name || '').localeCompare(b.ingredient_name || '')
  );
}

module.exports = { calculateForOutput };
