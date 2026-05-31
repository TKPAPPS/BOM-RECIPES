/**
 * dedupe-pricing-formulas.js
 *
 * Postgres treats NULL as DISTINCT in UNIQUE constraints, so the
 * `UNIQUE (scope, scope_ref_id, price_tier)` on pricing_formulas
 * never caught duplicate GLOBAL rows (scope_ref_id IS NULL).  Every
 * time the seed at the bottom of schema.sql re-ran, it inserted a
 * fresh cost/wholesale/retail global trio.
 *
 * This script finds duplicate ACTIVE global rows and deactivates
 * all but ONE per price_tier — keeping the row with the highest
 * priority, breaking ties by highest id (most recently created).
 *
 * Dry-run by default.  Pass --apply to actually deactivate rows.
 *
 *   node scripts/dedupe-pricing-formulas.js          # dry-run
 *   node scripts/dedupe-pricing-formulas.js --apply  # commit
 */

require('dotenv').config();
const pool = require('../src/config/db');

const APPLY = process.argv.includes('--apply');

async function run() {
  const { rows } = await pool.query(
    `SELECT id, price_tier, multiplier, priority, name, created_at
       FROM pricing_formulas
      WHERE scope = 'global'
        AND scope_ref_id IS NULL
        AND is_active = TRUE
      ORDER BY price_tier, priority DESC, id DESC`
  );

  console.log(`\nFound ${rows.length} active global pricing rows.\n`);

  const byTier = new Map();
  for (const r of rows) {
    if (!byTier.has(r.price_tier)) byTier.set(r.price_tier, []);
    byTier.get(r.price_tier).push(r);
  }

  const toDeactivate = [];
  for (const [tier, list] of byTier) {
    const [keep, ...drop] = list;
    console.log(`Tier '${tier}': ${list.length} active rows`);
    console.log(`  KEEP   #${keep.id} multiplier=${keep.multiplier} priority=${keep.priority} created=${keep.created_at.toISOString()}`);
    for (const d of drop) {
      console.log(`  DROP   #${d.id} multiplier=${d.multiplier} priority=${d.priority} created=${d.created_at.toISOString()}`);
      toDeactivate.push(d.id);
    }
  }

  if (toDeactivate.length === 0) {
    console.log('\nNo duplicates to deactivate.\n');
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN: would deactivate ${toDeactivate.length} duplicate row(s).`);
    console.log('Re-run with --apply to commit.\n');
    await pool.end();
    return;
  }

  const { rowCount } = await pool.query(
    `UPDATE pricing_formulas SET is_active = FALSE, updated_at = NOW()
      WHERE id = ANY($1::int[])`,
    [toDeactivate]
  );
  console.log(`\nDeactivated ${rowCount} duplicate row(s).\n`);
  await pool.end();
}

run().catch((err) => { console.error(err); process.exit(1); });
