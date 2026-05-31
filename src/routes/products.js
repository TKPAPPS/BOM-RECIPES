/**
 * products.js — Admin-only catalogue of raw materials synced from Odoo.
 *
 * This is intentionally a separate route from /items because the
 * Products tab is a flat, raw-data view of the synced catalogue
 * (image / name / reference / Odoo weight / cost / cost-per-kg)
 * rather than the BOM-aware item picker used elsewhere.
 *
 * Weight & cost source policy:
 *   - volume_weight holds ONLY what Odoo returned (NULL when missing).
 *   - weight_extracted_grams holds a name-regex fallback (in grams),
 *     populated by the sync and by the one-time backfill.
 *   - weight_source = 'odoo' | 'name_regex' | 'none' tells the UI
 *     which source the effective weight came from, so estimated
 *     values can be color-coded blue.
 *   - cost_per_kg_stored is whatever the sync wrote into items.cost_per_kg.
 *   - cost_per_kg_computed is the live row-level recompute using
 *     EITHER the Odoo weight (preferred) or the regex grams as a
 *     fallback — formula stays raw_cost / weight_in_grams * 1000.
 *   - cost_per_kg_source mirrors weight_source: 'odoo' when costing
 *     used the real Odoo weight, 'name_regex' when it used the
 *     extracted grams, 'none' when no weight could be resolved.
 *   - weight_missing remains TRUE only when NEITHER source resolved
 *     a weight.
 */

const express = require('express');
const pool    = require('../config/db');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/products — admin-only listing of raw_material items
router.get('/', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id,
            i.odoo_id,
            COALESCE(i.name_en, i.name) AS name,
            i.name_en,
            i.name_he,
            i.reference,
            i.uom,
            i.volume_weight,
            i.weight_extracted_grams,
            i.weight_source,
            i.raw_cost,
            i.cost_per_kg                  AS cost_per_kg_stored,
            i.image_url,
            i.last_synced_at,
            c.name                         AS category_name
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.item_type = 'raw_material'
        AND i.is_active  = TRUE
      ORDER BY COALESCE(i.name_en, i.name)`
  );

  const products = rows.map((r) => {
    const rawCost          = r.raw_cost != null ? parseFloat(r.raw_cost) : null;
    const odooWeightKg     = r.volume_weight != null ? parseFloat(r.volume_weight) : null;
    const extractedGrams   = r.weight_extracted_grams != null ? parseFloat(r.weight_extracted_grams) : null;
    const weightSource     = r.weight_source || 'none';

    // Effective weight (grams) — Odoo wins, regex is fallback.
    let effectiveWeightGrams = null;
    let costPerKgSource      = 'none';
    if (odooWeightKg != null && odooWeightKg > 0) {
      effectiveWeightGrams = odooWeightKg * 1000;
      costPerKgSource      = 'odoo';
    } else if (extractedGrams != null && extractedGrams > 0) {
      effectiveWeightGrams = extractedGrams;
      costPerKgSource      = 'name_regex';
    }

    // Compute via grams: cost / weight_in_grams * 1000.  Same formula
    // for both sources so the UI can rely on a single number.
    const costPerKgComputed =
      rawCost != null && effectiveWeightGrams != null && effectiveWeightGrams > 0
        ? (rawCost / effectiveWeightGrams) * 1000
        : null;

    return {
      ...r,
      raw_cost:               rawCost,
      volume_weight:          odooWeightKg,
      weight_extracted_grams: extractedGrams,
      weight_source:          weightSource,
      cost_per_kg_stored:     r.cost_per_kg_stored != null ? parseFloat(r.cost_per_kg_stored) : null,
      cost_per_kg_computed:   costPerKgComputed,
      cost_per_kg_source:     costPerKgSource,
      effective_weight_grams: effectiveWeightGrams,
      weight_missing:         weightSource === 'none',
    };
  });

  res.json(products);
});

module.exports = router;
