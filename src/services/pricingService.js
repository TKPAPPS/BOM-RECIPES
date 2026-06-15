/**
 * pricingService.js
 *
 * Formula-selection engine.  Source of truth for live price
 * recomputation.  The stored boms.wholesale_price / retail_price
 * columns are SNAPSHOTS for card stability — this engine is what
 * answers "what is the current price for this recipe right now?".
 *
 * Resolution priority (descending — first match wins):
 *
 *   1. MANUAL  — boms.pricing_formula_id was set by an admin and
 *                still points at an active formula row.
 *   2. DEFAULT — pricing_formulas.is_default = TRUE among active
 *                rows.  Exactly one formula is flagged at any time
 *                (enforced by uq_pricing_formulas_default_active).
 *   3. HARDCODED — last-resort 2.5 / 5 fallback used only if the
 *                  default flag was somehow wiped.  In normal
 *                  operation step 2 always resolves.
 *
 * The legacy scope/category/product/priority chain is GONE.  The
 * scope / scope_ref_id / priority columns remain on the table for
 * data-safety reasons but are not consulted here.
 *
 * Formula rows are stored TALL: one row per price_tier
 * (wholesale + retail).  `formula_uid` pairs the two tier rows
 * that together make up one logical formula.  When a recipe pins
 * a specific tier-row id via boms.pricing_formula_id, we look up
 * its formula_uid and aggregate both tiers back into a single
 * formula object.
 *
 * The cost side (cost_per_kg) comes straight from items.cost_per_kg,
 * which is maintained by the untouched recursive costingService —
 * including nested base recipes (items.item_type='recipe' lines)
 * and per-batch labor + overhead + packaging additions.
 *
 * Output shape:
 *   {
 *     item_id,
 *     cost_per_kg,                      // null only if the item has no cost yet
 *     formula: { id, formula_uid, name, is_default },
 *     selection: 'manual' | 'auto',
 *     wholesale_multiplier,
 *     retail_multiplier,
 *     wholesale_price,                  // cost_per_kg * wholesale_multiplier (per kg)
 *     retail_price,                     // cost_per_kg * retail_multiplier   (per kg)
 *   }
 */

const pool = require('../config/db');
const { applyFormula } = require('../utils/formulaEval');

// Hard fallback if the default flag is ever lost.  Matches the
// historical seed values in db/schema.sql.
const HARDCODED_DEFAULT = {
  id: null,
  formula_uid: null,
  name: 'Default (hardcoded fallback)',
  is_default: true,
  wholesale_multiplier: 2.5,
  retail_multiplier:    5.0,
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Resolve current pricing for a single item.
 *
 * @param {number} itemId
 * @param {object} [client]  pg client (for transactional callers e.g. BOM save)
 * @returns {Promise<object>} see file header for shape
 */
async function resolvePricingForItem(itemId, client) {
  const db = client || pool;

  // Item + (optional) BOM lookup in one round-trip.  pricing_formula_id
  // lives on boms, not items, so we LEFT JOIN to pick it up when present.
  const { rows } = await db.query(
    `SELECT i.id              AS item_id,
            i.cost_per_kg     AS item_cost_per_kg,
            b.id              AS bom_id,
            b.pricing_formula_id
     FROM   items i
     LEFT JOIN boms b ON b.item_id = i.id AND b.is_active = TRUE
     WHERE  i.id = $1 AND i.is_active = TRUE`,
    [itemId]
  );
  if (!rows.length) throw new Error(`Item ${itemId} not found or inactive`);
  const ctx = rows[0];

  const costPerKg = ctx.item_cost_per_kg != null
    ? parseFloat(ctx.item_cost_per_kg)
    : null;

  // ── Walk the (much shorter) priority chain ─────────────────────────
  let formula = null;
  let selection = 'auto';

  // 1. MANUAL — pinned formula on the BOM
  if (ctx.pricing_formula_id) {
    const pinned = await fetchFormulaById(db, ctx.pricing_formula_id);
    if (pinned) {
      formula   = pinned;
      selection = 'manual';
    }
    // If the pinned formula was deleted / deactivated, fall through
    // to the default below.  Callers can detect this by noticing
    // selection === 'auto' while boms.pricing_formula_id was set.
  }

  // 2. DEFAULT — the single is_default formula
  if (!formula) {
    formula = await fetchDefaultFormula(db);
  }

  // 3. HARDCODED — last resort
  if (!formula) {
    formula = HARDCODED_DEFAULT;
  }

  // Evaluate the formula directly on the per-kg cost (exact — supports
  // rounding/constants), falling back to cost × multiplier.
  const wholesalePrice = applyFormula(formula.wholesale_formula, formula.wholesale_multiplier, costPerKg);
  const retailPrice    = applyFormula(formula.retail_formula,    formula.retail_multiplier,    costPerKg);

  return {
    item_id: ctx.item_id,
    cost_per_kg: costPerKg,
    formula: {
      id:          formula.id,
      formula_uid: formula.formula_uid,
      name:        formula.name,
      is_default:  !!formula.is_default,
    },
    selection,
    wholesale_multiplier: formula.wholesale_multiplier,
    retail_multiplier:    formula.retail_multiplier,
    wholesale_formula:    formula.wholesale_formula || null,
    retail_formula:       formula.retail_formula || null,
    wholesale_price:      wholesalePrice,
    retail_price:         retailPrice,
  };
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Aggregate the wholesale + retail tier rows that share `formula_uid`
 * into one formula object.  Returns null if no active rows exist
 * for that uid (e.g. formula was deactivated).
 */
async function fetchFormulaByUid(db, formulaUid) {
  const { rows } = await db.query(
    `SELECT MIN(id)                                                          AS id,
            formula_uid,
            MAX(name)                                                        AS name,
            bool_or(is_default)                                              AS is_default,
            MAX(CASE WHEN price_tier = 'wholesale' THEN multiplier END)::float AS wholesale_multiplier,
            MAX(CASE WHEN price_tier = 'retail'    THEN multiplier END)::float AS retail_multiplier,
            MAX(CASE WHEN price_tier = 'wholesale' THEN formula_expr END)      AS wholesale_formula,
            MAX(CASE WHEN price_tier = 'retail'    THEN formula_expr END)      AS retail_formula
     FROM   pricing_formulas
     WHERE  formula_uid = $1
       AND  is_active   = TRUE
       AND  price_tier IN ('wholesale', 'retail')
     GROUP BY formula_uid`,
    [formulaUid]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.wholesale_multiplier == null && row.retail_multiplier == null) return null;
  return row;
}

/**
 * Given a tier-row id (the value stored in boms.pricing_formula_id),
 * find its formula_uid and return the aggregated formula.  Returns
 * null when the row is missing or inactive, or when the resolved
 * formula has no active tier rows.
 */
async function fetchFormulaById(db, tierRowId) {
  const { rows } = await db.query(
    `SELECT formula_uid
     FROM   pricing_formulas
     WHERE  id = $1`,
    [tierRowId]
  );
  if (!rows.length || rows[0].formula_uid == null) return null;
  return fetchFormulaByUid(db, rows[0].formula_uid);
}

/**
 * Fetch the single is_default formula.  Returns null if none is
 * flagged (the resolver then falls back to HARDCODED_DEFAULT).
 */
async function fetchDefaultFormula(db) {
  const { rows } = await db.query(
    `SELECT formula_uid
     FROM   pricing_formulas
     WHERE  is_default = TRUE
       AND  is_active  = TRUE
     LIMIT  1`
  );
  if (!rows.length || rows[0].formula_uid == null) return null;
  return fetchFormulaByUid(db, rows[0].formula_uid);
}

module.exports = {
  resolvePricingForItem,
  // Exported for tests / route helpers
  fetchFormulaById,
  fetchFormulaByUid,
  fetchDefaultFormula,
};
