/**
 * backfill-weight-from-name.js
 *
 * One-time backfill for the weight-from-name feature.
 *
 * For every active raw_material item:
 *   - If volume_weight is present (Odoo gave us a weight):
 *       weight_source := 'odoo'   (the canonical source)
 *       weight_extracted_grams := what the name says, when extractable,
 *         saved AS A BACKUP only — never used unless the Odoo weight
 *         later disappears.
 *
 *   - If volume_weight is NULL/0 and a weight can be parsed from the
 *     name:
 *       weight_source          := 'name_regex'
 *       weight_extracted_grams := the parsed grams
 *       cost_per_kg            := raw_cost / extracted_grams * 1000
 *         (only updated when raw_cost is known)
 *
 *   - If neither source resolved a weight:
 *       weight_source := 'none'
 *       cost_per_kg stays untouched (don't downgrade a possibly-good
 *       value just because we couldn't parse the name).
 *
 * Run: node scripts/backfill-weight-from-name.js
 */

require('dotenv').config();
const pool = require('../src/config/db');
const { extractWeightFromName } = require('../src/utils/weightExtractor');

async function run() {
  const { rows } = await pool.query(
    `SELECT id, name, name_en, raw_cost, volume_weight, cost_per_kg
       FROM items
      WHERE item_type = 'raw_material'
        AND is_active  = TRUE`
  );

  console.log(`\n[backfill-weight] Processing ${rows.length} active raw-material rows…\n`);

  let countOdoo        = 0;  // had a real Odoo weight already
  let countRegexNew    = 0;  // Odoo missing → regex resolved one
  let countUnresolved  = 0;  // Odoo missing AND regex didn't match
  let countCostUpdated = 0;  // wrote a new cost_per_kg
  const samplesResolved = [];
  const samplesUnresolved = [];

  for (const item of rows) {
    const odooKg   = parseFloat(item.volume_weight);
    const hasOdoo  = Number.isFinite(odooKg) && odooKg > 0;
    const rawCost  = parseFloat(item.raw_cost);
    const hasCost  = Number.isFinite(rawCost) && rawCost > 0;

    // Try both languages of the name — supplier feeds occasionally have
    // the weight only in the Hebrew variant.
    const candidates = [item.name_en, item.name].filter(Boolean);
    let extracted = null;
    for (const candidate of candidates) {
      const r = extractWeightFromName(candidate);
      if (r) { extracted = r; break; }
    }
    const extractedGrams = extracted ? extracted.grams : null;

    let weightSource;
    let newCostPerKg = null;

    if (hasOdoo) {
      weightSource = 'odoo';
      countOdoo++;
    } else if (extractedGrams != null) {
      weightSource = 'name_regex';
      countRegexNew++;
      if (hasCost) {
        newCostPerKg = (rawCost / extractedGrams) * 1000;
      }
      if (samplesResolved.length < 8) {
        samplesResolved.push({
          id: item.id,
          name: item.name_en || item.name,
          grams: extractedGrams,
          newCostPerKg: newCostPerKg != null ? Number(newCostPerKg.toFixed(4)) : null,
        });
      }
    } else {
      weightSource = 'none';
      countUnresolved++;
      if (samplesUnresolved.length < 8) {
        samplesUnresolved.push({ id: item.id, name: item.name_en || item.name });
      }
    }

    if (newCostPerKg != null) {
      await pool.query(
        `UPDATE items
            SET weight_extracted_grams = $1,
                weight_source          = $2,
                cost_per_kg            = $3,
                updated_at             = NOW()
          WHERE id = $4`,
        [extractedGrams, weightSource, newCostPerKg, item.id]
      );
      countCostUpdated++;
    } else {
      await pool.query(
        `UPDATE items
            SET weight_extracted_grams = $1,
                weight_source          = $2,
                updated_at             = NOW()
          WHERE id = $3`,
        [extractedGrams, weightSource, item.id]
      );
    }
  }

  console.log('───────────────────────────────────────────────');
  console.log(' Weight resolution summary');
  console.log('───────────────────────────────────────────────');
  console.log(`  Real Odoo weight present : ${countOdoo}`);
  console.log(`  Resolved from name regex : ${countRegexNew}`);
  console.log(`  Still unresolved (none)  : ${countUnresolved}`);
  console.log(`  cost_per_kg recomputed   : ${countCostUpdated}`);
  console.log('───────────────────────────────────────────────');

  if (samplesResolved.length) {
    console.log('\nExamples — resolved from name:');
    for (const s of samplesResolved) {
      console.log(`  [${s.id}] ${s.name}  →  ${s.grams} g`
        + (s.newCostPerKg != null ? `  (cost/kg = ${s.newCostPerKg})` : '  (no raw_cost — cost/kg unchanged)'));
    }
  }
  if (samplesUnresolved.length) {
    console.log('\nExamples — still unresolved:');
    for (const s of samplesUnresolved) {
      console.log(`  [${s.id}] ${s.name}`);
    }
  }

  await pool.end();
}

run().catch((err) => {
  console.error('[backfill-weight] Failed:', err.message);
  process.exit(1);
});
