/**
 * priceVisibility.js
 *
 * Server-side enforcement of price visibility.  UI hiding is NOT
 * trusted — every response is filtered here before it leaves the
 * server.
 *
 * Resolution rules (matches the STEP 1 schema decision):
 *   role = 'admin'                       → always TRUE
 *   role = 'customer', can_view_prices=T → TRUE  (per-user override)
 *   role = 'customer', can_view_prices=F → FALSE (per-user override)
 *   role = 'customer', can_view_prices=NULL → FALSE (role default)
 *
 * Stripping is recursive: walks arrays and nested objects, drops any
 * key matching a PRICE_FIELD or PRICE_GROUP.
 */

/**
 * Scalar money / multiplier fields that get nulled when stripping.
 * Anything resembling a per-unit cost or a price-tier multiplier.
 */
const PRICE_FIELDS = new Set([
  // Per-kg costs
  'cost_per_kg',
  'raw_cost',
  'price_per_kg',
  'price_per_kg_snapshot',
  // Aggregated batch costs
  'total_cost',
  'line_cost',
  'labor_cost',
  'overhead_cost',
  'packaging_cost',
  // Stored snapshot prices on recipes
  'wholesale_price',
  'retail_price',
  // Computed per-yield prices in BOM list responses
  'wholesale_for_yield',
  'retail_for_yield',
  // Pricing-formula multipliers
  'wholesale_multiplier',
  'retail_multiplier',
  'multiplier',
]);

/**
 * Object-valued keys that get dropped entirely (they only exist to
 * group price data — e.g. items/:id/pricing returns { pricing: {…} }).
 */
const PRICE_GROUPS = new Set(['pricing']);

/**
 * Decide whether a user is allowed to see prices.
 * @param {object|null|undefined} user - a local users row (or null)
 */
function canViewPrices(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.can_view_prices === true)  return true;
  if (user.can_view_prices === false) return false;
  // can_view_prices IS NULL → fall back to role default
  return user.role === 'admin'; // customer default = false
}

/**
 * Return a deep copy of `value` with all price-related keys removed.
 * Pass-through for primitives, dates, and null/undefined.
 */
function stripPrices(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripPrices);
  if (value instanceof Date) return value;
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (PRICE_FIELDS.has(key)) continue;
    if (PRICE_GROUPS.has(key)) continue;
    out[key] = stripPrices(val);
  }
  return out;
}

module.exports = {
  canViewPrices,
  stripPrices,
  PRICE_FIELDS,
  PRICE_GROUPS,
};
