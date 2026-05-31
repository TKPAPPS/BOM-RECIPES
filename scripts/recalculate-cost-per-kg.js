/**
 * recalculate-cost-per-kg.js
 *
 * One-time script to:
 *  1. Extract package weight from product name via regex when Odoo returned 0.
 *  2. Recalculate cost_per_kg = raw_cost / weight.
 *  3. Fix any image_url values that are missing the data URI prefix.
 *
 * Run: node scripts/recalculate-cost-per-kg.js
 */

require('dotenv').config();
const pool = require('../src/config/db');

const WEIGHT_REGEX = /(\d+(?:\.\d+)?)\s*kg/i;

async function run() {
  const { rows } = await pool.query(
    `SELECT id, name, raw_cost, volume_weight, cost_per_kg, image_url
     FROM   items
     WHERE  item_type = 'raw_material'
       AND  is_active  = TRUE`
  );

  console.log(`\n[recalc] Processing ${rows.length} raw-material items…\n`);

  let updated = 0;
  let skipped = 0;

  for (const item of rows) {
    let weight   = parseFloat(item.volume_weight) || 0;
    const rawCost = parseFloat(item.raw_cost)      || 0;
    let weightSource = 'odoo';

    // Regex fallback: extract weight from product name
    if (!weight && item.name) {
      const match = item.name.match(WEIGHT_REGEX);
      if (match) {
        weight      = parseFloat(match[1]);
        weightSource = 'name';
      }
    }

    const newCostPerKg = weight > 0 ? rawCost / weight : rawCost;

    // Fix image URL: add data URI prefix if stored as raw base64
    let newImageUrl = item.image_url;
    if (newImageUrl && !newImageUrl.startsWith('data:')) {
      newImageUrl = `data:image/png;base64,${newImageUrl}`;
    }

    const oldCost       = parseFloat(item.cost_per_kg) || 0;
    const costChanged   = Math.abs(newCostPerKg - oldCost) > 0.0001;
    const imageChanged  = newImageUrl !== item.image_url;
    const weightChanged = weight !== (parseFloat(item.volume_weight) || 0);

    if (costChanged || imageChanged || weightChanged) {
      await pool.query(
        `UPDATE items
            SET cost_per_kg   = $1,
                volume_weight = $2,
                image_url     = $3,
                updated_at    = NOW()
          WHERE id = $4`,
        [newCostPerKg, weight || null, newImageUrl, item.id]
      );
      console.log(
        `  UPDATED  [${item.id}] ${item.name}\n` +
        `           weight: ${weight} kg (from ${weightSource}) | ` +
        `raw_cost: ${rawCost} → cost/kg: ${newCostPerKg.toFixed(4)}` +
        (imageChanged ? ' | image fixed' : '')
      );
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`\n[recalc] Done — updated: ${updated}, unchanged: ${skipped}\n`);
  await pool.end();
}

run().catch((err) => {
  console.error('[recalc] Script failed:', err.message);
  process.exit(1);
});
