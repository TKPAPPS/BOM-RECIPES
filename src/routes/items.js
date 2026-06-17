const express = require('express');
const pool    = require('../config/db');
const { recalculateItem } = require('../services/costingService');
const { resolvePricingForItem } = require('../services/pricingService');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// GET /items/search — full-text search across raw materials AND saved recipes (sub-assemblies)
// MUST be defined before /:id routes
router.get('/search', async (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  if (q.length < 2) return res.json([]);

  const pattern = `%${q}%`;
  const { rows } = await pool.query(
    `-- Raw materials
     SELECT i.id,
            COALESCE(i.name_en, i.name) AS name,
            i.name_en,
            i.name_he,
            i.reference,
            'material'      AS type,
            i.cost_per_kg,
            i.uom           AS unit,
            i.image_url,
            i.volume_weight,
            c.name          AS category_name
     FROM   items i
     LEFT JOIN categories c ON c.id = i.category_id
     WHERE  i.is_active = TRUE
       AND  i.item_type = 'raw_material'
       AND  (
              i.name      ILIKE $1
           OR i.name_en   ILIKE $1
           OR i.name_he   ILIKE $1
           OR i.reference ILIKE $1
           )

     UNION ALL

     -- Saved recipes (sub-assemblies) — use the BOM's stored cost_per_kg
     SELECT i.id,
            COALESCE(i.name_en, i.name) AS name,
            i.name_en,
            i.name_he,
            b.reference_code            AS reference,
            'recipe'                    AS type,
            COALESCE(b.cost_per_kg, i.cost_per_kg) AS cost_per_kg,
            'kg'                        AS unit,
            NULL                        AS image_url,
            NULL                        AS volume_weight,
            NULL                        AS category_name
     FROM   boms b
     JOIN   items i ON i.id = b.item_id
     WHERE  b.is_active = TRUE
       AND  i.is_active = TRUE
       AND  (
              COALESCE(i.name_en, i.name) ILIKE $1
           OR i.name_he                   ILIKE $1
           OR b.reference_code            ILIKE $1
           )

     ORDER BY name
     LIMIT 50`,
    [pattern]
  );
  res.json(rows);
});

// GET /items — list all active items
router.get('/', async (req, res) => {
  const { type, category_id } = req.query;
  let sql = `SELECT i.*, c.name AS category_name
             FROM items i
             LEFT JOIN categories c ON c.id = i.category_id
             WHERE i.is_active = TRUE`;
  const params = [];
  if (type)        { params.push(type);        sql += ` AND i.item_type = $${params.length}`; }
  if (category_id) { params.push(category_id); sql += ` AND i.category_id = $${params.length}`; }
  sql += ' ORDER BY i.name';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// GET /items/:id/affected-recipes  (admin only — traceability view)
// Recursively finds all active BOMs that use this item anywhere in their tree.
// Uses a recursive CTE so nested sub-assemblies (A uses B uses C) are all returned
// when you query for C.
router.get('/:id/affected-recipes', requireAdmin, async (req, res) => {
  const itemId = parseInt(req.params.id);
  if (!itemId) return res.status(400).json({ error: 'invalid item id' });

  // Verify item exists
  const { rows: itemRows } = await pool.query(
    `SELECT id, COALESCE(name_en, name) AS name, item_type FROM items WHERE id = $1`,
    [itemId]
  );
  if (!itemRows.length) return res.status(404).json({ error: 'item not found' });

  // Walk every BOM that references the target item directly or via
  // sub-recipes.  direct_qty is captured at the base level (the qty
  // on the bom_line where ingredient_item_id = target) and carried
  // as NULL through the recursive step so we can distinguish:
  //   • direct usage (line uses the target as a raw ingredient)
  //   • indirect usage only (target is reached through a sub-recipe)
  //   • both (a recipe that has the target in a line AND also in a
  //     nested sub-recipe — direct quantities still sum cleanly,
  //     and via_sub_recipe stays true).
  const { rows: affected } = await pool.query(
    `WITH RECURSIVE affected(item_id, path, direct_qty) AS (
       -- Base case: BOMs that directly contain this ingredient.
       -- quantity_kg is declared NUMERIC(12,6); cast to unconstrained
       -- NUMERIC so both terms of the CTE produce the SAME column type
       -- (Postgres requires exact type match on a recursive CTE).
       SELECT b.item_id,
              ARRAY[b.item_id],
              bl.quantity_kg::numeric
       FROM   bom_lines bl
       JOIN   boms b ON b.id = bl.bom_id AND b.is_active = TRUE
       WHERE  bl.ingredient_item_id = $1

       UNION ALL

       -- Recursive: BOMs that contain any of the already-found recipe items
       SELECT b.item_id,
              a.path || b.item_id,
              NULL::numeric          -- indirect: no direct line qty
       FROM   affected a
       JOIN   bom_lines bl ON bl.ingredient_item_id = a.item_id
       JOIN   boms b       ON b.id = bl.bom_id AND b.is_active = TRUE
       WHERE  NOT b.item_id = ANY(a.path)   -- cycle guard
     ),
     agg AS (
       SELECT item_id,
              SUM(direct_qty)                        AS direct_quantity_kg,
              BOOL_OR(direct_qty IS NOT NULL)        AS is_direct,
              BOOL_OR(direct_qty IS NULL)            AS via_sub_recipe,
              MIN(array_length(path, 1))             AS depth
       FROM   affected
       GROUP  BY item_id
     )
     SELECT a.item_id,
            COALESCE(i.name_en, i.name) AS recipe_name,
            i.cost_per_kg,
            b.version,
            b.yield_kg,
            b.recipe_type,
            b.reference_code,
            a.depth,
            a.direct_quantity_kg,
            a.is_direct,
            a.via_sub_recipe
     FROM   agg a
     JOIN   items i ON i.id = a.item_id AND i.is_active = TRUE
     JOIN   boms   b ON b.item_id = a.item_id AND b.is_active = TRUE
     ORDER  BY a.depth, recipe_name`,
    [itemId]
  );

  console.log(
    `[affected-recipes] item ${itemId} (${itemRows[0].name}) is used in ${affected.length} recipe(s):`,
    affected.map((r) => `${r.recipe_name} (v${r.version})`).join(', ') || 'none'
  );

  res.json({
    item: itemRows[0],
    affected_count: affected.length,
    recipes: affected,
  });
});

// GET /items/:id/pricing — live-resolved pricing via the formula engine.
// Walks: manual override → item/product/recipe → category → global.
// Always returns a result (global is the guaranteed fallback).
router.get('/:id/pricing', async (req, res) => {
  try {
    const result = await resolvePricingForItem(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 422;
    res.status(status).json({ error: err.message });
  }
});

// POST /items/:id/recalculate — trigger cost recalculation (admin only)
router.post('/:id/recalculate', requireAdmin, async (req, res) => {
  const result = await recalculateItem(parseInt(req.params.id));
  res.json(result);
});

// POST /items — create an internal recipe item (admin only)
router.post('/', requireAdmin, async (req, res) => {
  const { name, category_id, uom = 'kg' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await pool.query(
    `INSERT INTO items (name, category_id, uom, item_type)
     VALUES ($1, $2, $3, 'recipe') RETURNING *`,
    [name, category_id || null, uom]
  );
  res.status(201).json(rows[0]);
});

// GET /items/:id — single item (read-only) for the ingredient page.
// Open to any authenticated user; price fields are stripped by
// pricesMiddleware for users without view-price permission.
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const { rows } = await pool.query(
    `SELECT i.id,
            COALESCE(i.name_en, i.name) AS name,
            i.name_en, i.name_he, i.reference, i.uom, i.item_type,
            i.cost_per_kg, i.raw_cost, i.volume_weight, i.weight_source,
            i.image_url, i.is_active, i.odoo_archived, i.last_synced_at,
            COALESCE(b.reference_code, i.reference) AS reference_code,
            c.name AS category_name
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN boms b ON b.item_id = i.id AND b.is_active = TRUE
      WHERE i.id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

module.exports = router;
