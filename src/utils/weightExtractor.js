/**
 * weightExtractor.js
 *
 * Parse a "package measure" out of a product NAME when the Odoo
 * volume_weight column is missing.  Used as a fallback only — the
 * real Odoo weight, when present, always wins.
 *
 * THREE measure families are recognised (case-insensitive, whitespace
 * optional between number and unit):
 *
 *   WEIGHT  → price per kg
 *     "200 gr", "200gr", "200 g", "200g", "200 gram", "200 grams"
 *     "1 kg", "1kg", "1.5 kg", "0,5 kg"
 *     Hebrew: "200 גרם", "1 ק\"ג", "1 קג"
 *
 *   VOLUME  → price per litre
 *     "1 l", "1l", "1 lt", "1.5 liter", "750 liters"   (also "ליטר")
 *
 *   COUNT   → price per unit
 *     "6 unit", "6 units", or a bare "unit" / "units" with no number
 *     (a bare unit means the cost IS already per unit → divide by 1).
 *
 * Output is normalised so the cost pipeline can divide a raw cost by a
 * single "kg-equivalent" quantity and get the right per-measure price:
 *
 *   - WEIGHT: grams are real grams; cost_per_kg = rawCost / (grams/1000)
 *   - VOLUME: grams = litres × 1000, so rawCost / (grams/1000) = price/litre
 *   - COUNT : grams = count × 1000, so rawCost / (grams/1000) = price/unit
 *
 * The caller knows the family via the `measure` field and so can avoid
 * treating a volume/count value as if it were a real weight.
 *
 * Robustness rules:
 *   1. Only numbers IMMEDIATELY followed by a measure unit are
 *      considered — bare numbers like "Pack of 12" are ignored
 *      (except the bare "unit" / "units" token, which has no number).
 *   2. Measure families have a PRIORITY: weight > volume > count.
 *      A name that contains a real weight ("Tuna 160g x 6 units")
 *      still resolves by weight; the unit count is ignored.  This keeps
 *      the original weight behaviour intact.
 *   3. If, WITHIN the chosen family, multiple pairs normalise to
 *      DIFFERENT values, the name is ambiguous and we return null.
 *   4. If nothing matches, return null.
 *
 * Decimal separators: both "." and "," accepted (Israeli / EU
 * conventions show up in supplier feeds).
 *
 * Returns: { grams: number, unit: 'g'|'kg'|'l'|'unit',
 *            measure: 'weight'|'volume'|'count' } | null
 */

// Order matters: list LONGER unit tokens first so the alternation
// prefers "kg" over "g", "grams" over "g", and "liter" over "l".
// Hebrew tokens come in geresh / gershayim / straight-quote variants
// seen in Odoo feeds.
const UNIT_PATTERN = String.raw`(?:` +
  // kg variants — longer/more-specific first so "kg" beats "g"
  String.raw`kilograms|kilogram|kgs|kg|` +
  String.raw`ק["׳'’]ג|קג|` +
  // gram variants — Hebrew first (no ambiguity), then English
  String.raw`גרמים|גרם|` +
  String.raw`grams|gram|gr\.?|g|` +
  // litre variants — longer first so "liter" beats "lt"/"l"
  String.raw`liters|litres|liter|litre|ליטר|lt|l|` +
  // count variants — Hebrew first, then English
  String.raw`יחידות|יחידה|units|unit` +
  String.raw`)`;

const NUMBER_PATTERN = String.raw`\d+(?:[.,]\d+)?`;

// Unicode-aware boundaries: the number must not sit inside an
// alphanumeric token (so SKUs like "X1234kg" are ignored), and the
// unit must not be followed by another letter (so "1 grand" or
// "200 grocery" do not match).  `\p{L}` covers Latin and Hebrew
// letters alike, which `\w` / `\b` in JS do not.
const PAIR_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(${NUMBER_PATTERN})\s*(${UNIT_PATTERN})(?![\p{L}\p{N}])`,
  'giu'
);

// A standalone "unit" / "units" token WITHOUT a leading number — means
// the cost is already per unit, so the divisor is 1.  Only consulted
// when no numbered pair matched in any family.
const BARE_UNIT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:units?|יחידות|יחידה)(?![\p{L}\p{N}])`,
  'iu'
);

const KG_UNITS = new Set(['kg', 'kgs', 'kilogram', 'kilograms', 'קג']);

/**
 * Classify a matched unit token into a measure family / sub-type.
 * Returns 'kg' | 'g' | 'l' | 'unit' | null.
 */
function classifyUnit(unitToken) {
  // Strip an optional trailing dot ("gr.") for comparison.
  const t = unitToken.toLowerCase().replace(/\.$/, '');

  if (KG_UNITS.has(t)) return 'kg';
  // Hebrew kg with quote/geresh: ק"ג, ק׳ג, ק'ג, ק’ג
  if (/^ק["׳'’]ג$/.test(unitToken)) return 'kg';

  if (t === 'g' || t === 'gr' || t === 'gram' || t === 'grams'
      || t === 'גרם' || t === 'גרמים') return 'g';

  if (t === 'l' || t === 'lt' || t === 'liter' || t === 'liters'
      || t === 'litre' || t === 'litres' || t === 'ליטר') return 'l';

  if (t === 'unit' || t === 'units'
      || unitToken === 'יחידה' || unitToken === 'יחידות') return 'unit';

  return null;
}

function parseNumber(token) {
  // Accept "1.5" and "1,5" — comma as decimal separator.
  return parseFloat(token.replace(',', '.'));
}

/**
 * Extract a package measure from a product name.
 *
 * @param {string|null|undefined} name
 * @returns {{ grams: number, unit: 'g'|'kg'|'l'|'unit',
 *             measure: 'weight'|'volume'|'count' } | null}
 */
function extractWeightFromName(name) {
  if (!name || typeof name !== 'string') return null;

  // Collect matches into measure families so we can apply the
  // weight > volume > count priority below.
  const buckets = { weight: [], volume: [], count: [] };

  for (const m of name.matchAll(PAIR_RE)) {
    const value = parseNumber(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;

    const kind = classifyUnit(m[2]);
    if (kind === 'kg') {
      buckets.weight.push({ grams: value * 1000, unit: 'kg', measure: 'weight' });
    } else if (kind === 'g') {
      buckets.weight.push({ grams: value, unit: 'g', measure: 'weight' });
    } else if (kind === 'l') {
      // grams = litres × 1000 so cost / (grams/1000) === cost per litre
      buckets.volume.push({ grams: value * 1000, unit: 'l', measure: 'volume' });
    } else if (kind === 'unit') {
      // grams = count × 1000 so cost / (grams/1000) === cost per unit
      buckets.count.push({ grams: value * 1000, unit: 'unit', measure: 'count' });
    }
  }

  // Priority: a real weight always wins, then volume, then explicit count.
  for (const family of ['weight', 'volume', 'count']) {
    const arr = buckets[family];
    if (arr.length === 0) continue;

    // De-dupe matches that normalise to the same value (e.g. "1 kg" and
    // "1kg" in the same name) — those are not ambiguous.
    const unique = new Set(arr.map((x) => x.grams));
    if (unique.size > 1) return null;             // ambiguous within family
    return arr[0];
  }

  // Fallback: a bare "unit" / "units" with no number → price per 1 unit.
  if (BARE_UNIT_RE.test(name)) {
    return { grams: 1000, unit: 'unit', measure: 'count' };
  }

  return null;
}

/**
 * Extract ONLY a count ("<number> unit/units/יחידה/יחידות", or a bare
 * unit token) from a product name — ignoring any weight/volume in the
 * name.  Used for per-unit products where a "4.2 lt" / "500 g" in the
 * name describes packaging capacity, not divisible content, so only an
 * explicit unit COUNT should divide the cost.
 *
 * @returns {{ grams: number, unit: 'unit', measure: 'count' } | null}
 *          grams = count × 1000 so rawCost / (grams/1000) === price/unit.
 */
function extractCountFromName(name) {
  if (!name || typeof name !== 'string') return null;

  const counts = [];
  for (const m of name.matchAll(PAIR_RE)) {
    const value = parseNumber(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (classifyUnit(m[2]) === 'unit') counts.push(value);
  }
  if (counts.length) {
    const unique = new Set(counts);
    if (unique.size > 1) return null;             // ambiguous count
    return { grams: counts[0] * 1000, unit: 'unit', measure: 'count' };
  }

  // Bare "unit" / "units" / "יחידה" with no number → 1 unit (divide by 1).
  if (BARE_UNIT_RE.test(name)) {
    return { grams: 1000, unit: 'unit', measure: 'count' };
  }
  return null;
}

module.exports = {
  extractWeightFromName,
  extractCountFromName,
  // Exported for testing only
  _internal: { PAIR_RE, BARE_UNIT_RE, classifyUnit, parseNumber },
};
