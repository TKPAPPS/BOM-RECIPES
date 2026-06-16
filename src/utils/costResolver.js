/**
 * costResolver.js
 *
 * Single source of truth for turning a product's raw data into an
 * effective cost-per-kg.  Used by the Odoo sync, the Products GET
 * route (live recompute) and the manual-edit endpoint so all three
 * agree on the number.
 *
 * Resolution order — most authoritative first:
 *
 *   COST PRICE   manual_raw_cost  →  Odoo standard_price
 *   WEIGHT       manual_weight    →  Odoo volume_weight  →  name regex
 *   COST / KG    manual_cost_per_kg
 *                  → cost / measure   (when a weight/volume/count resolved)
 *                  → cost as-is       (FALLBACK: nothing parseable, so the
 *                                      cost itself is treated as the per-kg
 *                                      / per-unit price)
 *
 * The name regex also yields VOLUME ("1 l" → ₪/litre) and COUNT
 * ("6 unit" → ₪/unit); for those the `grams` value is only a divisor
 * proxy (litres×1000 / count×1000), never a real weight — see
 * weightExtractor.js.
 */

const { extractWeightFromName, extractCountFromName } = require('./weightExtractor');

/** Coerce to a finite number or null (accepts numeric strings from pg). */
function toNum(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * True when the product's Odoo UOM means it is counted in whole units
 * (so its standard_price is already a PER-UNIT cost and must NOT be
 * divided by any weight/volume parsed out of the name — e.g. a packaging
 * box named "… 4.2 lt 1 Units" is one unit, not 4.2 litres of content).
 */
function isUnitUom(uom) {
  if (!uom) return false;
  const u = String(uom).trim().toLowerCase();
  return u === 'unit' || u === 'units' || u === 'each' || u === 'ea'
      || u === 'pc' || u === 'pcs' || u === 'piece' || u === 'pieces'
      || u === 'יחידה' || u === 'יחידות' || u === 'יח' || u === "יח'";
}

/**
 * @param {object} input
 * @param {string|null} input.name              product name (for regex)
 * @param {number|string|null} input.rawCost    Odoo standard_price
 * @param {number|string|null} input.odooWeightKg  Odoo volume_weight (kg)
 * @param {number|string|null} [input.manualRawCost]
 * @param {number|string|null} [input.manualWeightGrams]
 * @param {number|string|null} [input.manualCostPerKg]
 *
 * @returns {{
 *   effectiveRawCost: number|null,
 *   weightGrams: number|null,        // divisor proxy (kg/L/unit × 1000)
 *   weightSource: 'manual'|'odoo'|'name_regex'|'none',
 *   measure: 'weight'|'volume'|'count'|null,
 *   weightExtractedGrams: number|null, // real weight only (for storage)
 *   costPerKg: number|null,
 *   costPerKgSource: 'manual'|'odoo'|'name_regex'|'raw_cost'|'none',
 * }}
 */
function resolveProductCost(input) {
  const manualRawCost     = toNum(input.manualRawCost);
  const manualWeightGrams = toNum(input.manualWeightGrams);
  const manualCostPerKg   = toNum(input.manualCostPerKg);

  const odooRawCost  = toNum(input.rawCost);
  const odooWeightKg = toNum(input.odooWeightKg);

  // ── Effective cost price: manual wins ──
  const effectiveRawCost = manualRawCost != null ? manualRawCost : odooRawCost;

  // ── Effective weight / measure: manual → Odoo → name regex ──
  let weightGrams  = null;    // grams (or divisor proxy for volume/count)
  let weightSource = 'none';
  let measure      = null;

  if (manualWeightGrams != null && manualWeightGrams > 0) {
    weightGrams  = manualWeightGrams;
    weightSource = 'manual';
    measure      = 'weight';
  } else if (odooWeightKg != null && odooWeightKg > 0) {
    weightGrams  = odooWeightKg * 1000;
    weightSource = 'odoo';
    measure      = 'weight';
  } else if (isUnitUom(input.uom)) {
    // Per-unit product.  Priority for unit products is COUNT > weight >
    // volume:
    //   • an explicit COUNT in the name ("50 units", "6 יחידות", or a
    //     packaging "… 1 Units") → price per unit (and a volume/weight
    //     alongside a count is treated as packaging capacity → ignored);
    //   • otherwise a WEIGHT/VOLUME in the name is the content, so divide
    //     by it → price per kg / per litre (e.g. "Black Sesame 500 gr");
    //   • nothing parseable → the cost is already per unit (raw cost).
    const cnt = extractCountFromName(input.name);
    if (cnt) {
      weightGrams  = cnt.grams;        // count × 1000 → rawCost/(grams/1000) = per unit
      weightSource = 'name_regex';
      measure      = 'count';
    } else {
      const ext = extractWeightFromName(input.name);   // weight or volume (content)
      if (ext) {
        weightGrams  = ext.grams;
        weightSource = 'name_regex';
        measure      = ext.measure;
      } else {
        measure      = 'count';
        weightSource = 'none';
      }
    }
  } else {
    const ext = extractWeightFromName(input.name);
    if (ext) {
      weightGrams  = ext.grams;
      weightSource = 'name_regex';
      measure      = ext.measure;
    }
  }

  // ── Effective cost-per-kg ──
  let costPerKg       = null;
  let costPerKgSource = 'none';

  if (manualCostPerKg != null && manualCostPerKg > 0) {
    costPerKg       = manualCostPerKg;
    costPerKgSource = 'manual';
  } else if (effectiveRawCost != null && weightGrams != null && weightGrams > 0) {
    costPerKg       = effectiveRawCost / (weightGrams / 1000);
    costPerKgSource = weightSource;
  } else if (effectiveRawCost != null) {
    // Nothing parseable → the cost itself is the per-kg / per-unit price.
    costPerKg       = effectiveRawCost;
    costPerKgSource = 'raw_cost';
  }

  return {
    effectiveRawCost,
    weightGrams,
    weightSource,
    measure,
    // Only a REAL weight is worth persisting as weight_extracted_grams;
    // volume/count grams are divisor proxies, not weights.
    weightExtractedGrams:
      weightSource === 'name_regex' && measure === 'weight' ? weightGrams : null,
    costPerKg,
    costPerKgSource,
  };
}

module.exports = { resolveProductCost, toNum };
