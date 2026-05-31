/**
 * weightExtractor.js
 *
 * Parse a package weight out of a product NAME when the Odoo
 * volume_weight column is missing.  Used as a fallback only — the
 * real Odoo weight, when present, always wins.
 *
 * Supported patterns (case-insensitive, whitespace optional between
 * number and unit):
 *
 *   ENGLISH:
 *     "200 gr", "200gr", "200 g", "200g"
 *     "200 gram", "200 grams"
 *     "1 kg", "1kg", "1.5 kg", "0,5 kg"
 *
 *   HEBREW:
 *     "200 גרם", "200 גרמים"
 *     "1 ק\"ג", "1 ק'ג", "1 ק׳ג", "1 קג"
 *
 * Output is always normalised to GRAMS (kg ×1000).
 *
 * Robustness rules:
 *   1. Only numbers IMMEDIATELY followed by a weight unit are
 *      considered — bare numbers like "Pack of 12" are ignored.
 *   2. If multiple weight-unit pairs are found and they normalise
 *      to DIFFERENT gram values, the name is ambiguous and we
 *      return null (do not guess).
 *   3. If no pair is found, return null.
 *
 * Decimal separators: both "." and "," accepted (Israeli / EU
 * conventions show up in supplier feeds).
 *
 * Returns: { grams: number, unit: 'g'|'kg' } | null
 */

// Order matters: list LONGER unit tokens first so the alternation
// prefers "kg" over "g" and "grams" over "g".  Hebrew tokens come
// in geresh / gershayim / straight-quote variants seen in Odoo feeds.
const UNIT_PATTERN = String.raw`(?:` +
  // kg variants — longer/more-specific first so "kg" beats "g"
  String.raw`kilograms|kilogram|kgs|kg|` +
  String.raw`ק["׳'’]ג|קג|` +
  // gram variants — Hebrew first (no ambiguity), then English
  String.raw`גרמים|גרם|` +
  String.raw`grams|gram|gr\.?|g` +
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

const KG_UNITS = new Set(['kg', 'kilogram', 'kilograms', 'קג']);

function isKgUnit(unitToken) {
  const t = unitToken.toLowerCase();
  if (KG_UNITS.has(t)) return true;
  // Hebrew kg with quote/geresh: ק"ג, ק׳ג, ק'ג, ק’ג
  if (/^ק["׳'’]ג$/.test(unitToken)) return true;
  return false;
}

function parseNumber(token) {
  // Accept "1.5" and "1,5" — comma as decimal separator.
  return parseFloat(token.replace(',', '.'));
}

/**
 * Extract a weight (in grams) from a product name.
 *
 * @param {string|null|undefined} name
 * @returns {{ grams: number, unit: 'g'|'kg' } | null}
 */
function extractWeightFromName(name) {
  if (!name || typeof name !== 'string') return null;

  const matches = [];
  for (const m of name.matchAll(PAIR_RE)) {
    const value = parseNumber(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;

    const isKg  = isKgUnit(m[2]);
    const grams = isKg ? value * 1000 : value;
    matches.push({ grams, unit: isKg ? 'kg' : 'g' });
  }

  if (matches.length === 0) return null;

  // De-dupe matches that normalise to the same grams (e.g. someone
  // wrote both "1 kg" and "1kg" in the same name) — those are not
  // ambiguous.
  const uniqueGrams = new Set(matches.map((m) => m.grams));
  if (uniqueGrams.size > 1) return null;            // ambiguous

  return matches[0];
}

module.exports = {
  extractWeightFromName,
  // Exported for testing only
  _internal: { PAIR_RE, isKgUnit, parseNumber },
};
