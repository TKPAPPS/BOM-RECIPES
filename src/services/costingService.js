/**
 * costingService.js
 *
 * Handles recursive BOM cost calculation.
 *
 * Material cost per line:
 *   effective_qty = quantity_kg / (1 - waste_pct / 100)
 *   line_cost     = effective_qty × ingredient_cost_per_kg
 *
 * Fully-burdened recipe cost:
 *   total_cost  = Σ(line_cost) + labor_cost + overhead_cost + packaging_cost
 *   cost_per_kg = total_cost / yield_kg
 *
 * Circular dependency detection uses a visited ancestor Set threaded
 * through the recursion — O(depth) per node, no extra DB round-trips.
 */

const pool = require('../config/db');
const { resolvePricingForItem } = require('./pricingService');

// ─── Queries ────────────────────────────────────────────────────────────────

const Q_ITEM = `
  SELECT id, name, item_type, cost_per_kg
  FROM   items
  WHERE  id = $1 AND is_active = TRUE
`;

const Q_BOM = `
  SELECT b.id AS bom_id, b.yield_kg, b.recipe_type,
         b.labor_cost, b.overhead_cost, b.packaging_cost,
         l.id AS line_id,
         l.ingredient_item_id,
         l.quantity_kg,
         l.waste_pct
  FROM   boms b
  JOIN   bom_lines l ON l.bom_id = b.id
  WHERE  b.item_id  = $1
    AND  b.is_active = TRUE
`;

const Q_UPDATE_COST = `
  UPDATE items
  SET    cost_per_kg = $1, updated_at = NOW()
  WHERE  id = $2
`;

// Refresh the per-line frozen snapshots so the recipe detail view (which
// reads bom_lines.line_cost / price_per_kg_snapshot) reflects the new
// ingredient cost after a recalculation — not just the headline number.
const Q_UPDATE_LINE = `
  UPDATE bom_lines
  SET    price_per_kg_snapshot = $1, line_cost = $2
  WHERE  id = $3
`;

// Refresh the recipe-level snapshots on the BOM row itself.
const Q_UPDATE_BOM = `
  UPDATE boms
  SET    cost_per_kg = $1, total_cost = $2,
         wholesale_price = $3, retail_price = $4
  WHERE  id = $5
`;

// ─── Core recursive function ─────────────────────────────────────────────────

/**
 * Recursively calculate and persist cost_per_kg for a recipe item.
 *
 * @param {number} itemId        - items.id of the recipe to calculate
 * @param {Set}    ancestors     - Set of item IDs on the current call stack
 * @param {object} [client]      - optional pg client (for transaction support)
 * @returns {Promise<number>}    - resolved cost_per_kg
 * @throws {Error}               - on circular dependency or missing data
 */
async function calculateCostPerKg(itemId, ancestors = new Set(), client) {
  const db = client || pool;

  // ── Circular dependency guard ────────────────────────────────────────────
  if (ancestors.has(itemId)) {
    const cycle = [...ancestors, itemId].join(' → ');
    throw new Error(`Circular dependency detected: ${cycle}`);
  }

  const { rows: itemRows } = await db.query(Q_ITEM, [itemId]);
  if (!itemRows.length) throw new Error(`Item ${itemId} not found or inactive`);

  const item = itemRows[0];

  // ── Raw material: cost is already stored, just return it ─────────────────
  if (item.item_type === 'raw_material') {
    if (item.cost_per_kg === null)
      throw new Error(`Raw material "${item.name}" (id ${itemId}) has no cost_per_kg`);
    return parseFloat(item.cost_per_kg);
  }

  // ── Recipe: fetch BOM lines and recurse ──────────────────────────────────
  const { rows: bomRows } = await db.query(Q_BOM, [itemId]);
  if (!bomRows.length)
    throw new Error(`Recipe "${item.name}" (id ${itemId}) has no active BOM`);

  const yieldKg = parseFloat(bomRows[0].yield_kg);
  const bomId   = bomRows[0].bom_id;
  const newAncestors = new Set(ancestors).add(itemId);

  let materialCost = 0;
  for (const line of bomRows) {
    const ingredientCost = await calculateCostPerKg(
      line.ingredient_item_id,
      newAncestors,
      client
    );
    const wastePct    = parseFloat(line.waste_pct) || 0;
    const wasteFactor = 1 - wastePct / 100;          // > 0 guaranteed by DB CHECK
    const effectiveQty = parseFloat(line.quantity_kg) / wasteFactor;
    const lineCost     = effectiveQty * ingredientCost;
    materialCost += lineCost;

    // Refresh the frozen per-line snapshot so the recipe view updates too.
    await db.query(Q_UPDATE_LINE, [ingredientCost, lineCost, line.line_id]);
  }

  // Add per-batch production costs (labour, overhead, packaging)
  const laborCost     = parseFloat(bomRows[0].labor_cost     || 0);
  const overheadCost  = parseFloat(bomRows[0].overhead_cost  || 0);
  const packagingCost = parseFloat(bomRows[0].packaging_cost || 0);
  const totalCost = materialCost + laborCost + overheadCost + packagingCost;

  const costPerKg = totalCost / yieldKg;

  // ── Persist the calculated value back to the item ────────────────────────
  await db.query(Q_UPDATE_COST, [costPerKg, itemId]);

  // ── Refresh the recipe-level BOM snapshots (cost/total + prices) ──────────
  // Mirrors the BOM save path so the recipe detail view — which reads these
  // stored columns — shows current numbers after a recalc.  Resolve prices
  // AFTER the item cost update above so the pricing engine sees the new cost.
  let wholesalePrice = null;
  let retailPrice    = null;
  if (bomRows[0].recipe_type === 'final') {
    try {
      const pricing = await resolvePricingForItem(itemId, client);
      wholesalePrice = pricing.wholesale_price ?? null;
      retailPrice    = pricing.retail_price    ?? null;
    } catch (err) {
      console.warn(`[costing] price refresh skipped for item ${itemId}:`, err.message);
    }
  }
  await db.query(Q_UPDATE_BOM, [costPerKg, totalCost, wholesalePrice, retailPrice, bomId]);

  return costPerKg;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Recalculate cost for one recipe (wrapped in a transaction).
 */
async function recalculateItem(itemId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cost = await calculateCostPerKg(itemId, new Set(), client);
    await client.query('COMMIT');
    return { itemId, cost_per_kg: cost };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Build a dependency-ordered list of recipe IDs using Kahn's BFS topological
 * sort on the sub-recipe dependency graph, so every sub-assembly is costed
 * before any parent recipe that consumes it.
 *
 * Recipes unreachable via the sorted order (i.e. part of a cycle) are
 * appended at the end — calculateCostPerKg will surface a clear error for
 * each of them individually.
 *
 * @returns {Promise<number[]>} recipe item IDs in safe calculation order
 */
async function buildCalculationOrder() {
  const { rows: recipeRows } = await pool.query(
    `SELECT id FROM items WHERE item_type = 'recipe' AND is_active = TRUE`
  );
  const allIds = recipeRows.map((r) => r.id);
  if (allIds.length === 0) return [];

  const recipeSet = new Set(allIds);

  // Edges in the dependency graph:
  //   dep_id    = the sub-recipe ingredient
  //   parent_id = the recipe that consumes it  (parent depends on dep)
  const { rows: edges } = await pool.query(
    `SELECT b.item_id            AS parent_id,
            l.ingredient_item_id AS dep_id
     FROM   boms b
     JOIN   bom_lines l ON l.bom_id = b.id
     JOIN   items dep   ON dep.id   = l.ingredient_item_id
     WHERE  b.is_active     = TRUE
       AND  dep.item_type   = 'recipe'
       AND  dep.is_active   = TRUE`
  );

  // inDegree[parent] = number of recipe-type ingredients not yet processed
  const inDegree   = new Map(allIds.map((id) => [id, 0]));
  // dependents[dep] = list of parent recipe IDs that are waiting on this dep
  const dependents = new Map();

  for (const { parent_id, dep_id } of edges) {
    if (!recipeSet.has(parent_id) || !recipeSet.has(dep_id)) continue;
    inDegree.set(parent_id, (inDegree.get(parent_id) ?? 0) + 1);
    if (!dependents.has(dep_id)) dependents.set(dep_id, []);
    dependents.get(dep_id).push(parent_id);
  }

  // Seed the queue with recipes that have zero recipe-type dependencies
  // (they only use raw materials, so they can be calculated immediately).
  const queue  = allIds.filter((id) => inDegree.get(id) === 0);
  const order  = [];

  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const parentId of (dependents.get(id) ?? [])) {
      const remaining = inDegree.get(parentId) - 1;
      inDegree.set(parentId, remaining);
      if (remaining === 0) queue.push(parentId);
    }
  }

  // Any recipe not reached by the sort is in a cycle; append so it still
  // runs and produces a clear circular-dependency error.
  const inOrderSet = new Set(order);
  for (const id of allIds) {
    if (!inOrderSet.has(id)) order.push(id);
  }

  return order;
}

/**
 * Recalculate all active recipes in dependency order.
 * Leaves raw materials untouched (their cost comes from Odoo).
 */
async function recalculateAll() {
  const order = await buildCalculationOrder();

  const results = [];
  for (const id of order) {
    try {
      const r = await recalculateItem(id);
      results.push({ ...r, ok: true });
    } catch (err) {
      results.push({ itemId: id, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Resolve pricing for an item across all tiers using stored formulas.
 * Resolution order: item > category > global
 */
async function getPricingForItem(itemId) {
  const { rows } = await pool.query(
    `SELECT i.cost_per_kg, i.category_id,
            pf.price_tier, pf.multiplier, pf.scope
     FROM   items i
     -- item-level formulas
     LEFT JOIN pricing_formulas pf ON pf.is_active = TRUE AND (
       (pf.scope = 'item'     AND pf.scope_ref_id = i.id)
       OR (pf.scope = 'category' AND pf.scope_ref_id = i.category_id)
       OR (pf.scope = 'global'   AND pf.scope_ref_id IS NULL)
     )
     WHERE  i.id = $1`,
    [itemId]
  );

  if (!rows.length) throw new Error(`Item ${itemId} not found`);

  const rawCost = rows[0].cost_per_kg;
  if (rawCost === null || rawCost === undefined) {
    throw new Error(
      `Item ${itemId} has no calculated cost. Save its BOM first to generate a cost_per_kg.`
    );
  }
  const costPerKg = parseFloat(rawCost);
  if (!isFinite(costPerKg)) {
    throw new Error(`Item ${itemId} has an invalid cost value: "${rawCost}"`);
  }

  const TIERS = ['cost', 'wholesale', 'retail'];
  const SCOPE_PRIORITY = { item: 3, category: 2, global: 1 };

  // Pick highest-priority formula per tier
  const best = {};
  for (const row of rows) {
    if (!row.price_tier) continue;
    const tier = row.price_tier;
    const priority = SCOPE_PRIORITY[row.scope];
    if (!best[tier] || priority > best[tier].priority) {
      best[tier] = { multiplier: parseFloat(row.multiplier), priority };
    }
  }

  const pricing = {};
  for (const tier of TIERS) {
    pricing[tier] = best[tier] ? costPerKg * best[tier].multiplier : null;
  }

  return { itemId, cost_per_kg: costPerKg, pricing };
}

module.exports = { recalculateItem, recalculateAll, getPricingForItem, calculateCostPerKg };
