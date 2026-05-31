/**
 * trace-recipe-pricing.js
 *
 * Investigation script for Issue 2 — traces a real final recipe end-to-end:
 *   raw cost_per_kg → recursive recipe cost → formula multiplier → wholesale/retail
 *
 * Prints every intermediate value so we can spot where the pricing diverges.
 *
 * Run: node scripts/trace-recipe-pricing.js [item_id]
 */

require('dotenv').config();
const pool = require('../src/config/db');
const { calculateCostPerKg } = require('../src/services/costingService');
const { resolvePricingForItem } = require('../src/services/pricingService');

function fmt(n, d = 6) {
  if (n === null || n === undefined) return 'null';
  const x = parseFloat(n);
  return isFinite(x) ? x.toFixed(d) : String(n);
}

async function pickRecipe(explicitId) {
  if (explicitId) {
    const { rows } = await pool.query(
      `SELECT b.item_id, b.recipe_type, COALESCE(i.name_en, i.name) AS name
         FROM boms b JOIN items i ON i.id = b.item_id
        WHERE b.is_active = TRUE AND b.item_id = $1`,
      [explicitId]
    );
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT b.item_id, b.recipe_type, COALESCE(i.name_en, i.name) AS name
       FROM boms b JOIN items i ON i.id = b.item_id
      WHERE b.is_active = TRUE AND b.recipe_type = 'final'
      ORDER BY b.updated_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function traceLines(itemId, depth = 0) {
  const pad = '  '.repeat(depth);
  const { rows: bomRows } = await pool.query(
    `SELECT b.id AS bom_id, b.yield_kg,
            b.labor_cost, b.overhead_cost, b.packaging_cost,
            b.cost_per_kg AS stored_cost_per_kg,
            b.wholesale_price AS stored_wholesale,
            b.retail_price    AS stored_retail
       FROM boms b WHERE b.item_id = $1 AND b.is_active = TRUE`,
    [itemId]
  );
  if (!bomRows.length) {
    console.log(`${pad}(no active BOM for item ${itemId})`);
    return;
  }
  const bom = bomRows[0];
  console.log(`${pad}BOM ${bom.bom_id}: yield_kg=${fmt(bom.yield_kg, 4)}`
    + `  labor=${fmt(bom.labor_cost)}  overhead=${fmt(bom.overhead_cost)}`
    + `  packaging=${fmt(bom.packaging_cost)}`);
  console.log(`${pad}  stored snapshot → cost_per_kg=${fmt(bom.stored_cost_per_kg)}`
    + `  wholesale=${fmt(bom.stored_wholesale)}  retail=${fmt(bom.stored_retail)}`);

  const { rows: lines } = await pool.query(
    `SELECT l.id, l.ingredient_item_id, l.quantity_kg, l.line_uom, l.waste_pct,
            l.price_per_kg_snapshot, l.line_cost,
            i.item_type, i.cost_per_kg AS live_cost_per_kg,
            i.raw_cost, i.volume_weight, i.uom,
            COALESCE(i.name_en, i.name) AS ing_name
       FROM bom_lines l
       JOIN items i ON i.id = l.ingredient_item_id
      WHERE l.bom_id = $1
      ORDER BY l.id`,
    [bom.bom_id]
  );

  let materialCost = 0;
  for (const line of lines) {
    const waste = parseFloat(line.waste_pct) || 0;
    const wf    = 1 - waste / 100;
    const qty   = parseFloat(line.quantity_kg);
    const eff   = qty / wf;
    const live  = line.live_cost_per_kg != null ? parseFloat(line.live_cost_per_kg) : null;
    const snap  = line.price_per_kg_snapshot != null ? parseFloat(line.price_per_kg_snapshot) : null;
    const lineCostLive = live != null ? eff * live : null;
    const drift = (snap != null && live != null) ? (live - snap) : null;

    console.log(`${pad}  └─ [${line.item_type}] ${line.ing_name} (id ${line.ingredient_item_id})`);
    console.log(`${pad}       qty=${fmt(qty,4)} ${line.line_uom}  waste=${waste}%  eff=${fmt(eff,4)} kg`);
    if (line.item_type === 'raw_material') {
      console.log(`${pad}       raw_cost=${fmt(line.raw_cost)}  volume_weight=${fmt(line.volume_weight,4)} ${line.uom}`);
      // Independent cost_per_kg check (price / weight_in_kg)
      const rc = parseFloat(line.raw_cost) || 0;
      const w  = parseFloat(line.volume_weight) || 0;
      const recomputed = w > 0 ? rc / w : null;
      console.log(`${pad}       cost_per_kg → live=${fmt(live)}  snapshot=${fmt(snap)}  recomputed(raw/w)=${fmt(recomputed)}`);
      if (drift != null && Math.abs(drift) > 0.000001) {
        console.log(`${pad}       ⚠ snapshot ≠ live by ${fmt(drift)} (stored price is stale)`);
      }
    } else {
      console.log(`${pad}       cost_per_kg → live=${fmt(live)}  snapshot=${fmt(snap)}`);
      if (drift != null && Math.abs(drift) > 0.000001) {
        console.log(`${pad}       ⚠ snapshot ≠ live by ${fmt(drift)} (stored price is stale)`);
      }
    }
    console.log(`${pad}       line_cost(live)=${fmt(lineCostLive)}  stored line_cost=${fmt(line.line_cost)}`);
    materialCost += lineCostLive || 0;

    if (line.item_type === 'recipe') {
      await traceLines(line.ingredient_item_id, depth + 2);
    }
  }

  const lc = parseFloat(bom.labor_cost) || 0;
  const oc = parseFloat(bom.overhead_cost) || 0;
  const pc = parseFloat(bom.packaging_cost) || 0;
  const total = materialCost + lc + oc + pc;
  const cpk   = total / parseFloat(bom.yield_kg);
  console.log(`${pad}  Σ material(live)=${fmt(materialCost)}  + L+O+P=${fmt(lc+oc+pc)}`
    + `  → total=${fmt(total)}  / yield=${fmt(bom.yield_kg,4)}  = cost_per_kg=${fmt(cpk)}`);
}

async function run() {
  const explicit = process.argv[2] ? parseInt(process.argv[2]) : null;
  const recipe = await pickRecipe(explicit);
  if (!recipe) {
    console.log('No active final recipe found.');
    await pool.end();
    return;
  }

  console.log('============================================================');
  console.log(`TRACE: item ${recipe.item_id} "${recipe.name}" (${recipe.recipe_type})`);
  console.log('============================================================\n');

  console.log('— BOM TREE (live values, recomputed bottom-up) —');
  await traceLines(recipe.item_id);

  console.log('\n— FRESH RECURSIVE CALC (writes back to items.cost_per_kg) —');
  try {
    const fresh = await calculateCostPerKg(recipe.item_id, new Set());
    console.log(`  calculateCostPerKg → ${fmt(fresh)}`);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  console.log('\n— FORMULA RESOLUTION (pricingService) —');
  try {
    const pricing = await resolvePricingForItem(recipe.item_id);
    console.log(`  cost_per_kg from items table: ${fmt(pricing.cost_per_kg)}`);
    console.log(`  formula: ${JSON.stringify(pricing.formula)}  selection=${pricing.selection}`);
    console.log(`  wholesale_multiplier=${pricing.wholesale_multiplier}  retail_multiplier=${pricing.retail_multiplier}`);
    console.log(`  wholesale_price=${fmt(pricing.wholesale_price)}  retail_price=${fmt(pricing.retail_price)}`);
    if (pricing.formula && pricing.formula.name && pricing.formula.name.includes('hardcoded')) {
      console.log('  ⚠ Falling through to HARDCODED fallback (2.5 / 5) — no global row matched');
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  console.log('\n— ALL ACTIVE PRICING FORMULAS —');
  const { rows: pfs } = await pool.query(
    `SELECT id, scope, scope_ref_id, price_tier, multiplier, priority, name, is_active
       FROM pricing_formulas
      WHERE is_active = TRUE
      ORDER BY scope, scope_ref_id NULLS FIRST, price_tier`
  );
  for (const f of pfs) {
    console.log(`  #${f.id} ${f.scope}(ref=${f.scope_ref_id}) ${f.price_tier} ×${f.multiplier} priority=${f.priority} name=${f.name}`);
  }

  await pool.end();
}

run().catch((err) => {
  console.error('TRACE FAILED:', err);
  process.exit(1);
});
