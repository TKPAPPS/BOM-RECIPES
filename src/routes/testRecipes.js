/**
 * testRecipes.js — sandbox recipes still in development.
 *
 * Test recipes are stored SEPARATELY from the real items/boms pipeline
 * as a JSONB draft (one row per recipe).  They never appear in the real
 * Base/Final lists, never show up in ingredient search, and can't be
 * used inside real recipes.  A draft may contain "ad-hoc" ingredients
 * (a name/code for a product that doesn't exist in the catalogue yet);
 * those are flagged red.  A MANAGER promotes a finished draft into the
 * real lists once every ingredient resolves to a real item.
 *
 * The draft shape (built/consumed by the client RecipeBuilder):
 *   {
 *     yieldKg, recipeType, full_name, description, image_url, allergens,
 *     is_spicy, serving_suggestion, servings_count, total_weight,
 *     pricing_formula_id, labor_cost, overhead_cost, packaging_cost,
 *     steps: [{ step_number, name, description }],
 *     lines: [{ step_number, item_id|null, name, reference, cost_per_kg,
 *               unit, line_uom, quantity_kg, quantity_input, waste_pct,
 *               is_adhoc }]
 *   }
 */

const express = require('express');
const pool    = require('../config/db');
const { saveRecipeBom } = require('../services/recipeWriteService');
const { buildExportWorkbook } = require('../services/recipeIOService');
const { requireAdmin, requireManager } = require('../middleware/authMiddleware');
const { logAudit, getIp } = require('../services/auditService');

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const router = express.Router();

// ── Resolution: map one draft line to a real item, or null (red) ──
// Prefer the stored item_id (if still an active item); else an exact
// reference (SKU) match; else a case-insensitive name match.  null means
// the ingredient does not (yet) exist in the catalogue → shown red.
const RESOLVE_COLS =
  'id, COALESCE(name_en, name) AS name, reference, cost_per_kg, uom, image_url, item_type';

async function resolveLineItem(line, db = pool) {
  // 1. Stored item id still valid?
  const id = parseInt(line.item_id, 10);
  if (Number.isInteger(id) && id > 0) {
    const { rows } = await db.query(
      `SELECT ${RESOLVE_COLS} FROM items WHERE id = $1 AND is_active = TRUE`, [id]
    );
    if (rows.length) return rows[0];
  }
  // 2. Exact reference (SKU) match.
  const ref = (line.reference || '').toString().trim();
  if (ref) {
    const { rows } = await db.query(
      `SELECT ${RESOLVE_COLS} FROM items
        WHERE is_active = TRUE AND reference IS NOT NULL
          AND LOWER(reference) = LOWER($1)
        ORDER BY id LIMIT 1`, [ref]
    );
    if (rows.length) return rows[0];
  }
  // 3. Case-insensitive name match (name_en or name).
  const name = (line.name || '').toString().trim();
  if (name) {
    const { rows } = await db.query(
      `SELECT ${RESOLVE_COLS} FROM items
        WHERE is_active = TRUE
          AND (LOWER(name_en) = LOWER($1) OR LOWER(name) = LOWER($1))
        ORDER BY id LIMIT 1`, [name]
    );
    if (rows.length) return rows[0];
  }
  return null;
}

/** Annotate every draft line with the resolved item (+ is_red). */
async function annotateDraft(draft, db = pool) {
  const lines = Array.isArray(draft?.lines) ? draft.lines : [];
  const annotated = [];
  let redCount = 0;
  for (const line of lines) {
    const item = await resolveLineItem(line, db);
    const isRed = item == null;
    if (isRed) redCount++;
    annotated.push({
      ...line,
      resolved_item_id: item ? item.id : null,
      resolved_item:    item || null,    // {id,name,reference,cost_per_kg,uom,image_url,item_type}
      is_red:           isRed,
    });
  }
  return { lines: annotated, redCount };
}

// ── GET / — list test recipes with a red-ingredient count ──
// ?status=draft|pending filters; default returns all.
router.get('/', requireAdmin, async (req, res) => {
  const status = req.query.status === 'pending' || req.query.status === 'draft'
    ? req.query.status : null;
  const { rows } = await pool.query(
    `SELECT tr.id, tr.name, tr.reference_code, tr.recipe_type,
            tr.status, tr.review_note, tr.draft, tr.updated_at,
            COALESCE(u.name, u.username) AS created_by_name
       FROM test_recipes tr
       LEFT JOIN users u ON u.id = tr.created_by
      WHERE ($1::text IS NULL OR tr.status = $1)
      ORDER BY tr.updated_at DESC`,
    [status]
  );

  // Batch-resolve EVERY ingredient identity across all drafts in ONE query
  // (the old per-line resolveLineItem storm took ~30s for 100+ recipes).
  // Mirrors resolveLineItem: stored item_id → reference → name, active only.
  const idSet = new Set(), refSet = new Set(), nameSet = new Set();
  for (const r of rows) {
    for (const l of (Array.isArray(r.draft?.lines) ? r.draft.lines : [])) {
      const id = parseInt(l.item_id, 10);
      if (Number.isInteger(id) && id > 0) idSet.add(id);
      const ref = (l.reference || '').toString().trim().toLowerCase();
      if (ref) refSet.add(ref);
      const nm = (l.name || '').toString().trim().toLowerCase();
      if (nm) nameSet.add(nm);
    }
  }
  const okId = new Set(), okRef = new Set(), okName = new Set();
  if (idSet.size || refSet.size || nameSet.size) {
    const { rows: items } = await pool.query(
      `SELECT id, reference, name, name_en FROM items
        WHERE is_active = TRUE AND (
          id = ANY($1::int[])
          OR LOWER(reference) = ANY($2::text[])
          OR LOWER(name)      = ANY($3::text[])
          OR LOWER(name_en)   = ANY($3::text[]))`,
      [[...idSet], [...refSet], [...nameSet]]
    );
    for (const it of items) {
      okId.add(it.id);
      if (it.reference) okRef.add(it.reference.toLowerCase());
      if (it.name)      okName.add(it.name.toLowerCase());
      if (it.name_en)   okName.add(it.name_en.toLowerCase());
    }
  }
  const lineResolves = (l) => {
    const id = parseInt(l.item_id, 10);
    if (Number.isInteger(id) && id > 0 && okId.has(id)) return true;
    const ref = (l.reference || '').toString().trim().toLowerCase();
    if (ref && okRef.has(ref)) return true;
    const nm = (l.name || '').toString().trim().toLowerCase();
    if (nm && okName.has(nm)) return true;
    return false;
  };

  const list = rows.map((r) => {
    const lines = Array.isArray(r.draft?.lines) ? r.draft.lines : [];
    let red = 0;
    for (const l of lines) if (!lineResolves(l)) red++;
    return {
      id:              r.id,
      name:            r.name,
      reference_code:  r.reference_code,
      recipe_type:     r.recipe_type,
      status:          r.status,
      review_note:     r.review_note,
      updated_at:      r.updated_at,
      created_by_name: r.created_by_name,
      line_count:      lines.length,
      red_count:       red,
    };
  });
  res.json(list);
});

// ── GET /:id — full draft with per-line resolution annotations ──
router.get('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

  const { rows } = await pool.query(`SELECT * FROM test_recipes WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Test recipe not found' });

  const r = rows[0];
  const draft = r.draft || {};
  const { lines, redCount } = await annotateDraft(draft);
  res.json({
    id:             r.id,
    name:           r.name,
    reference_code: r.reference_code,
    recipe_type:    r.recipe_type,
    status:         r.status,
    review_note:    r.review_note,
    updated_at:     r.updated_at,
    red_count:      redCount,
    draft:          { ...draft, lines },
  });
});

// ── POST / — create or update a test recipe ──
// Body: { id?, name, reference_code, recipe_type, draft }
router.post('/', requireAdmin, async (req, res) => {
  const { id, name, reference_code = null, recipe_type = 'base', draft } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const type = recipe_type === 'final' ? 'final' : 'base';
  const draftJson = draft && typeof draft === 'object' ? draft : {};
  const userId = req.localUser?.id ?? null;

  if (id) {
    const { rows } = await pool.query(
      `UPDATE test_recipes
          SET name = $1, reference_code = $2, recipe_type = $3,
              draft = $4, updated_at = NOW()
        WHERE id = $5
      RETURNING id`,
      [name.trim(), reference_code, type, draftJson, parseInt(id, 10)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Test recipe not found' });
    return res.json({ id: rows[0].id, message: 'Test recipe saved' });
  }

  const { rows } = await pool.query(
    `INSERT INTO test_recipes (name, reference_code, recipe_type, draft, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name.trim(), reference_code, type, draftJson, userId]
  );
  res.status(201).json({ id: rows[0].id, message: 'Test recipe created' });
});

// ── POST /:id/submit — send a draft for the main manager's approval ──
// Any admin (recipe author) may submit; it then leaves the Test Recipes
// list and appears in the manager-only "Pending Approval" tab.
router.post('/:id/submit', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  // Submitting clears any prior review note — it's a fresh round.
  const { rows } = await pool.query(
    `UPDATE test_recipes SET status = 'pending', review_note = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING id`, [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Test recipe not found' });

  await logAudit({
    userId:      req.localUser?.id ?? null,
    actionType:  'test_recipe_submit',
    entity:      'test_recipe',
    entityId:    id,
    description: 'Submitted a test recipe for the manager\'s approval.',
    ipAddress:   getIp(req),
  });
  res.json({ id, message: 'Submitted for approval' });
});

// ── POST /:id/send-back — MANAGER ONLY ──
// Manager returns a pending recipe to the author for re-editing, with an
// optional note describing what to complete.  Status → 'draft'.
router.post('/:id/send-back', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const note = (req.body?.note ?? '').toString().trim() || null;

  const { rows } = await pool.query(
    `UPDATE test_recipes SET status = 'draft', review_note = $2, updated_at = NOW()
      WHERE id = $1 RETURNING id`, [id, note]
  );
  if (!rows.length) return res.status(404).json({ error: 'Test recipe not found' });

  await logAudit({
    userId:      req.localUser?.id ?? null,
    actionType:  'test_recipe_send_back',
    entity:      'test_recipe',
    entityId:    id,
    description: `Sent a test recipe back for re-editing${note ? `: ${note}` : ''}.`,
    ipAddress:   getIp(req),
  });
  res.json({ id, message: 'Sent back for re-editing' });
});

// ── DELETE /:id ──
router.delete('/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  await pool.query(`DELETE FROM test_recipes WHERE id = $1`, [id]);
  res.json({ message: 'Test recipe deleted' });
});

// Promote ONE test recipe → real recipe.  Returns a status object instead
// of touching res, so it can back both the single and bulk routes.
//   { id, name, status: 'promoted'|'blocked'|'failed'|'notfound', ... }
async function promoteOne(id, userId, ip) {
  const { rows } = await pool.query(`SELECT * FROM test_recipes WHERE id = $1`, [id]);
  if (!rows.length) return { id, status: 'notfound' };
  const tr = rows[0];
  const draft = tr.draft || {};

  const { lines: annotated, redCount } = await annotateDraft(draft);
  if (redCount > 0) {
    return { id, name: tr.name, status: 'blocked',
      red: annotated.filter((l) => l.is_red).map((l) => l.name || l.reference || '?') };
  }
  const validLines = annotated.filter((l) => l.resolved_item_id && Number(l.quantity_kg) > 0);
  if (validLines.length === 0) return { id, name: tr.name, status: 'failed', error: 'No valid ingredient lines' };

  // Merge lines that resolve to the SAME item (e.g. one matched by code,
  // another by name, or a genuine duplicate) — bom_lines enforces
  // UNIQUE(bom_id, ingredient_item_id), so sum quantities / keep the
  // higher waste instead of failing on a duplicate key.
  const byItem = new Map();
  for (const l of validLines) {
    const key = l.resolved_item_id;
    const ex = byItem.get(key);
    if (ex) {
      ex.quantity_kg += Number(l.quantity_kg);
      ex.waste_pct = Math.max(ex.waste_pct, Number(l.waste_pct) || 0);
    } else {
      byItem.set(key, {
        ingredient_item_id: key,
        quantity_kg:        Number(l.quantity_kg),
        line_uom:           l.line_uom || 'kg',
        waste_pct:          Number(l.waste_pct) || 0,
        step_number:        l.step_number ?? null,
      });
    }
  }
  const mergedLines = [...byItem.values()];

  const payload = {
    name:               tr.name,
    reference_code:     tr.reference_code,
    yield_kg:           Number(draft.yieldKg) > 0 ? Number(draft.yieldKg) : 1,
    recipe_type:        tr.recipe_type,
    labor_cost:         Number(draft.labor_cost)     || 0,
    overhead_cost:      Number(draft.overhead_cost)  || 0,
    packaging_cost:     Number(draft.packaging_cost) || 0,
    full_name:          draft.full_name || null,
    description:        draft.description || null,
    image_url:          draft.image_url || null,
    allergens:          Array.isArray(draft.allergens) ? draft.allergens : [],
    is_spicy:           !!draft.is_spicy,
    serving_suggestion: draft.serving_suggestion || null,
    servings_count:     draft.servings_count ?? null,
    total_weight:       draft.total_weight ?? null,
    pricing_formula_id: draft.pricing_formula_id ?? null,
    lines: mergedLines,
    steps: Array.isArray(draft.steps)
      ? draft.steps.map((s) => ({
          step_number: s.step_number,
          step_name:   s.name ?? s.step_name ?? null,
          description: s.description ?? null,
        }))
      : [],
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await saveRecipeBom(client, payload, userId);
    await client.query(`DELETE FROM test_recipes WHERE id = $1`, [id]);
    await logAudit({
      userId, actionType: 'test_recipe_promote', entity: 'recipe', entityId: result.item_id,
      description: `Promoted test recipe "${tr.name}" (${tr.recipe_type}) to the real ${tr.recipe_type} list.`,
      ipAddress: ip,
    }, client);
    await client.query('COMMIT');
    return { id, name: tr.name, status: 'promoted', item_id: result.item_id, recipe_type: tr.recipe_type };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { id, name: tr.name, status: 'failed', error: err.message };
  } finally {
    client.release();
  }
}

// ── POST /:id/promote — MANAGER ONLY ──
router.post('/:id/promote', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const r = await promoteOne(id, req.localUser?.id ?? null, getIp(req));
  if (r.status === 'notfound') return res.status(404).json({ error: 'Test recipe not found' });
  if (r.status === 'blocked')  return res.status(409).json({ error: 'unresolved_ingredients', message: 'Some ingredients do not exist in the catalogue yet.', red: r.red });
  if (r.status === 'failed')   return res.status(400).json({ error: r.error });
  res.json({ item_id: r.item_id, recipe_type: r.recipe_type, message: 'Test recipe promoted' });
});

// ── POST /bulk-promote — MANAGER ONLY ──
// Promote many; recipes with red ingredients are reported as blocked.
router.post('/bulk-promote', requireManager, async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((n) => parseInt(n, 10)).filter(Number.isInteger))];
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  const userId = req.localUser?.id ?? null;
  const ip = getIp(req);
  let promoted = 0;
  const blocked = [];

  // Bounded concurrency — promoting dozens one-at-a-time on a remote DB
  // takes minutes and looks "stuck".  Run a handful in parallel (each its
  // own transaction).  Conservative limit to avoid lock contention on
  // shared sub-recipes whose cost gets recomputed.
  const CONCURRENCY = 4;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= ids.length) return;
      const r = await promoteOne(ids[i], userId, ip);
      if (r.status === 'promoted') promoted++;
      else if (r.status !== 'notfound') blocked.push({ id: ids[i], name: r.name, reason: r.status === 'blocked' ? 'red' : (r.error || 'failed') });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  res.json({ promoted, blocked });
});

// ── POST /bulk-delete ──
router.post('/bulk-delete', requireAdmin, async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((n) => parseInt(n, 10)).filter(Number.isInteger))];
  if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
  const { rowCount } = await pool.query(`DELETE FROM test_recipes WHERE id = ANY($1::int[])`, [ids]);
  res.json({ count: rowCount });
});

// ── POST /export — selected pending test recipes → Excel (from drafts) ──
router.post('/export', requireAdmin, async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((n) => parseInt(n, 10)).filter(Number.isInteger))];
  const where = ids.length ? `WHERE id = ANY($1::int[])` : '';
  const { rows } = await pool.query(`SELECT id, name, reference_code, recipe_type, draft FROM test_recipes ${where} ORDER BY name`, ids.length ? [ids] : []);
  if (!rows.length) return res.status(404).json({ error: 'No pending recipes to export.' });

  const recipesForSheet = rows.map((tr) => {
    const d = tr.draft || {};
    const lines = (Array.isArray(d.lines) ? d.lines : []).map((l) => ({
      name:        l.resolved_item?.name || l.name || '',
      code:        l.resolved_item?.reference || l.reference || '',
      quantity_kg: l.quantity_kg != null ? Number(l.quantity_kg) : null,
      waste_pct:   l.waste_pct != null ? Number(l.waste_pct) : 0,
      line_uom:    l.line_uom || 'kg',
    }));
    return {
      image_url: d.image_url || null,
      name: tr.name,
      reference_code: tr.reference_code,
      recipe_type: tr.recipe_type,
      yield_kg: Number(d.yieldKg) || null,
      full_name: d.full_name || null,
      description: d.description || null,
      allergens: Array.isArray(d.allergens) ? d.allergens : [],
      is_spicy: !!d.is_spicy,
      serving_suggestion: d.serving_suggestion || null,
      servings_count: d.servings_count ?? null,
      total_weight: d.total_weight ?? null,
      cost_per_kg: null, total_cost: null, wholesale_price: null, retail_price: null,
      version: null, updated_at: '',
      lines,
    };
  });

  const buf = await buildExportWorkbook(recipesForSheet, { includePrices: false });
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="pending-recipes-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.setHeader('Content-Length', buf.length);
  res.send(Buffer.from(buf));
});

module.exports = router;
