/**
 * routes/recipeIO.js
 *
 * Admin-only Excel import / export endpoints for recipes.
 *
 *   POST /api/recipe-io/import     — multipart upload (.xlsx) →
 *                                     creates / updates recipes,
 *                                     returns a per-recipe report
 *   GET  /api/recipe-io/template   — downloadable sample workbook
 *   POST /api/recipe-io/export     — body filters → .xlsx download
 *
 * Parsing/building of the workbook lives in services/recipeIOService.js
 * (pure, no DB).  Persisting a recipe re-uses services/recipeWriteService
 * so the bulk and the single-save paths cannot drift.
 */

const express = require('express');
const multer  = require('multer');
const pool    = require('../config/db');
const { requireAdmin } = require('../middleware/authMiddleware');
const {
  parseRecipeWorkbook,
  buildTemplateWorkbook,
  buildExportWorkbook,
} = require('../services/recipeIOService');
const { saveRecipeBom }       = require('../services/recipeWriteService');
const { resolvePricingForItem } = require('../services/pricingService');
const { logAudit, getIp }     = require('../services/auditService');
const { usedNumbersForPrefix } = require('./referenceCodeCategories');

const router = express.Router();

// In-memory upload for .xlsx files only.  10 MB ceiling matches what a
// realistic recipe sheet will ever weigh; tighter than the global JSON
// limit because uploads are not chunked here.
const XLSX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls (best-effort)
  'application/octet-stream',                                          // some browsers
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (XLSX_MIME.has(file.mimetype) || /\.xlsx?$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx files are accepted.'));
    }
  },
});

// ── helpers ─────────────────────────────────────────────────────────

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** ISO date → yyyy-mm-dd_HHmm filename suffix (filesystem-safe). */
function timestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Resolve a batch of ingredient {code,name} pairs to item ids in ONE
 * DB round trip.  Match priority: reference (case-insensitive exact),
 * then name across name / name_en / name_he.
 *
 * @returns {Map<string,{id:number,reference:string|null,name:string,item_type:string}>}
 *   Keyed by the upper-cased reference code first, then by upper-cased
 *   name as a fallback for lines that have no code.
 */
async function resolveIngredients(client, codes, names) {
  const refList  = [...new Set(codes.filter(Boolean).map((c) => c.toUpperCase()))];
  const nameList = [...new Set(names.filter(Boolean).map((n) => n.toUpperCase()))];

  if (refList.length === 0 && nameList.length === 0) return new Map();

  const { rows } = await client.query(
    `SELECT id, reference, name, name_en, name_he, item_type
     FROM   items
     WHERE  is_active = TRUE
       AND  ( UPPER(reference) = ANY($1::text[])
           OR UPPER(name)      = ANY($2::text[])
           OR UPPER(name_en)   = ANY($2::text[])
           OR UPPER(name_he)   = ANY($2::text[]) )`,
    [refList, nameList]
  );

  const byRef  = new Map();
  const byName = new Map();
  for (const r of rows) {
    if (r.reference) byRef.set(r.reference.toUpperCase(), r);
    const names = [r.name, r.name_en, r.name_he].filter(Boolean);
    for (const n of names) {
      const k = n.toUpperCase();
      if (!byName.has(k)) byName.set(k, r);
    }
  }
  // Caller uses lookup(line) — collapse into one map keyed by `ref:CODE`
  // / `name:NAME` so a single get() handles either match path.
  const merged = new Map();
  for (const [k, v] of byRef)  merged.set(`ref:${k}`,  v);
  for (const [k, v] of byName) merged.set(`name:${k}`, v);
  return merged;
}

function lookupIngredient(map, line) {
  if (line.code) {
    const hit = map.get(`ref:${line.code.toUpperCase()}`);
    if (hit) return hit;
  }
  if (line.name) {
    const hit = map.get(`name:${line.name.toUpperCase()}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * Look up an existing recipe item by reference_code (preferred) or by
 * case-insensitive name, returning null if no match.  Used to decide
 * between "update in place" and "create new" on import.
 */
async function findExistingRecipe(client, name, referenceCode) {
  if (referenceCode) {
    const { rows } = await client.query(
      `SELECT b.item_id
       FROM   boms b
       WHERE  UPPER(b.reference_code) = UPPER($1)
         AND  b.is_active = TRUE
       LIMIT 1`,
      [referenceCode]
    );
    if (rows.length) return rows[0].item_id;
  }
  const { rows } = await client.query(
    `SELECT i.id
     FROM   items i
     WHERE  LOWER(i.name) = LOWER($1)
       AND  i.item_type   = 'recipe'
       AND  i.is_active   = TRUE
     LIMIT 1`,
    [name]
  );
  return rows.length ? rows[0].id : null;
}

// ── GET /template ───────────────────────────────────────────────────
router.get('/template', requireAdmin, async (_req, res) => {
  const buf = await buildTemplateWorkbook();
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="recipe-import-template.xlsx"`
  );
  res.setHeader('Content-Length', buf.length);
  res.send(Buffer.from(buf));
});

// ── POST /import ────────────────────────────────────────────────────
// multipart field name: "file".  Body field (text): "onDuplicate" =
// 'update' (default) | 'skip'; "defaultType" = 'base' | 'final'.
router.post('/import', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send a .xlsx file in the "file" field.' });
  }

  const onDuplicate = req.body.onDuplicate === 'skip' ? 'skip' : 'update';
  const defaultType = req.body.defaultType === 'final' ? 'final' : 'base';

  const { recipes, fatalError } = await parseRecipeWorkbook(req.file.buffer);
  if (fatalError) {
    return res.status(400).json({ error: fatalError });
  }
  if (recipes.length === 0) {
    return res.status(400).json({ error: 'No recipes were found in the file.' });
  }

  // ── Auto-assign reference codes to BASE recipes left blank ──
  // A base recipe with no Reference Code gets the smallest free BAS-####
  // (filling gaps across all existing codes).  Allocated sequentially so
  // several blank rows in one file each get a distinct code.
  try {
    const usedBAS = await usedNumbersForPrefix('BAS', pool);
    let nextN = 1;
    const allocBAS = () => {
      while (usedBAS.has(nextN)) nextN++;
      usedBAS.add(nextN);
      return `BAS-${String(nextN).padStart(4, '0')}`;
    };
    for (const r of recipes) {
      const rtype = r.recipe_type || defaultType;
      if (rtype === 'base' && !(r.reference_code || '').toString().trim()) {
        r.reference_code = allocBAS();
      }
    }
  } catch (e) {
    console.warn('[recipeIO/import] BAS auto-code skipped:', e.message);
  }

  // ── Pre-flight: reject the WHOLE file if any reference code already
  // exists in the system (recipes / test recipes / raw materials).  The
  // user must change those codes and re-upload — codes are unique.
  //
  // SKIP this guard in 'update' mode: there, existing codes are exactly
  // the recipes the user intends to UPDATE (matched by code), so blocking
  // them would make re-importing to update/add images impossible. ──
  const fileCodes = [...new Set(
    recipes.map((r) => (r.reference_code || '').trim()).filter(Boolean)
  )];
  if (onDuplicate !== 'update' && fileCodes.length) {
    // Only ACTIVE rows reserve a code.  Soft-deleted recipes
    // (is_active = FALSE) and inactive raw materials must NOT block a
    // re-import — otherwise a code is stuck forever once its recipe is
    // deleted.  (Archived recipes stay active, so they still reserve.)
    const { rows: clashRows } = await pool.query(
      `SELECT code FROM (
         SELECT reference_code AS code FROM boms         WHERE reference_code IS NOT NULL AND is_active = TRUE
         UNION ALL
         SELECT reference_code AS code FROM test_recipes WHERE reference_code IS NOT NULL
         UNION ALL
         SELECT reference      AS code FROM items        WHERE reference      IS NOT NULL AND is_active = TRUE
       ) all_codes
       WHERE UPPER(code) = ANY($1::text[])`,
      [fileCodes.map((c) => c.toUpperCase())]
    );
    if (clashRows.length) {
      const conflicts = [...new Set(clashRows.map((r) => r.code))];
      return res.status(409).json({
        error: 'codes_exist',
        message: 'These reference codes already exist in the system — change them and re-upload.',
        conflicts,
      });
    }
  }

  // Batch-resolve every distinct ingredient reference + name across
  // every recipe in the file with one query.
  const allCodes = recipes.flatMap((r) => r.lines.map((l) => l.code));
  const allNames = recipes.flatMap((r) => r.lines.map((l) => l.name));

  const userId = req.localUser?.id ?? null;
  const ingClient = await pool.connect();
  let ingMap;
  try {
    ingMap = await resolveIngredients(ingClient, allCodes, allNames);
  } finally {
    ingClient.release();
  }

  // Per-recipe processing, each in its own transaction so a bad row
  // does not roll the file back.  The report is the response body.
  const report = {
    total:    recipes.length,
    created:  0,
    updated:  0,
    skipped:  0,
    failed:   0,
    details:  [],   // [{ row, name, status, message }]
  };

  // Process a single recipe end-to-end and return its report detail.
  // Pure w.r.t. shared state (no report mutation) so recipes can run
  // concurrently — each opens its own pooled connection + transaction.
  async function processOne(draft) {
    const detail = { row: draft.rowNumber, name: draft.name, status: 'failed', message: '' };

    // ── Pre-flight: every ingredient must resolve ──
    const unresolved = [];
    const resolvedLines = [];
    for (const line of draft.lines) {
      const ing = lookupIngredient(ingMap, line);
      if (!ing) {
        unresolved.push(line.code || line.name || `(row ${line.rowNumber})`);
        continue;
      }
      resolvedLines.push({
        ingredient_item_id: ing.id,
        quantity_kg:        line.quantity_kg,
        line_uom:           line.line_uom || 'kg',
        waste_pct:          line.waste_pct || 0,
      });
    }
    if (unresolved.length) {
      detail.message = `Unknown ingredient code/name: ${unresolved.join(', ')}`;
      return detail;
    }
    if (resolvedLines.length === 0) {
      detail.message = 'No ingredient rows for this recipe.';
      return detail;
    }

    // ── Dedup by ingredient_item_id ──
    // The DB enforces UNIQUE (bom_id, ingredient_item_id) on bom_lines.
    // Two file rows can collide on the same item id for two reasons:
    //   • Genuine duplicates (the same ingredient listed twice in the
    //     spreadsheet — sometimes a copy-paste accident).
    //   • Resolver collision — one line matched by reference code,
    //     another by name, but both names ultimately resolve to the
    //     same items row.
    // Either way we merge them (sum quantities, keep the higher waste,
    // keep the first uom) and note it in the report so the user knows.
    const lineByItem = new Map();
    for (const ln of resolvedLines) {
      const existing = lineByItem.get(ln.ingredient_item_id);
      if (existing) {
        existing.quantity_kg += ln.quantity_kg;
        existing.waste_pct    = Math.max(existing.waste_pct, ln.waste_pct);
      } else {
        lineByItem.set(ln.ingredient_item_id, { ...ln });
      }
    }
    const mergedLines = [...lineByItem.values()];
    const dedupCount  = resolvedLines.length - mergedLines.length;
    const warnings    = [...(draft.warnings || [])];
    if (dedupCount > 0) {
      warnings.push(`Merged ${dedupCount} duplicate ingredient line${dedupCount === 1 ? '' : 's'} (same ingredient appeared twice — quantities summed).`);
    }

    // Decide create / update / skip
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existingId = await findExistingRecipe(client, draft.name, draft.reference_code);

      if (existingId && onDuplicate === 'skip') {
        await client.query('ROLLBACK');
        detail.status  = 'skipped';
        detail.message = 'A recipe with the same name or code already exists.';
        return detail;
      }

      const payload = {
        item_id:            existingId || null,
        name:               draft.name,
        reference_code:     draft.reference_code,
        yield_kg:           draft.yield_kg || 1,
        recipe_type:        draft.recipe_type || defaultType,
        full_name:          draft.full_name,
        description:        draft.description,
        // image_url is only persisted when actually present so we do not
        // blank an existing image on an update with no URL provided.
        image_url:          draft.image_url || undefined,
        allergens:          draft.allergens,
        is_spicy:           draft.is_spicy,
        serving_suggestion: draft.serving_suggestion,
        servings_count:     draft.servings_count,
        total_weight:       draft.total_weight,
        labor_cost:         0,
        overhead_cost:      0,
        packaging_cost:     0,
        pricing_formula_id: null,
        lines:              mergedLines,
      };

      const result = await saveRecipeBom(client, payload, userId);
      await client.query('COMMIT');

      const warningSuffix = warnings.length ? ' ⚠ ' + warnings.join(' ') : '';
      if (existingId) {
        detail.status  = 'updated';
        detail.message = `Recipe updated (v${result.version}).` + warningSuffix;
      } else {
        detail.status  = 'created';
        detail.message = `Recipe created (item #${result.item_id}).` + warningSuffix;
      }
      return detail;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      detail.status  = 'failed';
      detail.message =
        err.message?.includes('Circular dependency')
          ? `Circular dependency detected: ${err.message}`
          : (err.message || 'Unknown error.');
      return detail;
    } finally {
      client.release();
    }
  }

  // ── Bounded-concurrency runner ──
  // The DB is remote (~85ms/round-trip) and each recipe issues dozens of
  // sequential queries, so processing recipes strictly one-at-a-time made
  // an 88-recipe import take minutes.  Running a handful in parallel (each
  // in its own transaction) cuts wall-clock ~N× while staying well under
  // the pool's connection limit.  Results are kept in file order.
  const CONCURRENCY = Math.min(6, recipes.length || 1);
  const results = new Array(recipes.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= recipes.length) return;
      results[i] = await processOne(recipes[i]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const detail of results) {
    if (!detail) continue;
    report.details.push(detail);
    if (detail.status === 'created')      report.created++;
    else if (detail.status === 'updated') report.updated++;
    else if (detail.status === 'skipped') report.skipped++;
    else                                  report.failed++;
  }

  // Single audit entry summarising the whole import (file-level event).
  await logAudit({
    userId,
    actionType:  'recipe_import',
    entity:      'recipe',
    entityId:    null,
    description: `Imported "${req.file.originalname}" — ${report.created} created, ${report.updated} updated, ${report.skipped} skipped, ${report.failed} failed.`,
    valueAfter:  { filename: req.file.originalname, onDuplicate, defaultType, summary: {
      total: report.total, created: report.created, updated: report.updated,
      skipped: report.skipped, failed: report.failed,
    } },
    ipAddress:   getIp(req),
  }).catch((e) => console.warn('[recipeIO/import] audit log skipped:', e.message));

  res.json(report);
});

// ── POST /export ────────────────────────────────────────────────────
// Body: { type?: 'base'|'final', q?: string, from?: ISO, to?: ISO,
//         ids?: number[], includePrices?: boolean }
router.post('/export', requireAdmin, async (req, res) => {
  const { type, q, from, to, ids, includePrices } = req.body || {};

  const filters = [`b.is_active = TRUE`];
  const params  = [];
  if (type === 'base' || type === 'final') {
    params.push(type);
    filters.push(`b.recipe_type = $${params.length}`);
  }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    const i = params.length;
    filters.push(
      `(i.name ILIKE $${i} OR i.name_en ILIKE $${i} OR i.name_he ILIKE $${i} OR b.reference_code ILIKE $${i})`
    );
  }
  if (from) {
    params.push(from);
    filters.push(`b.updated_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    filters.push(`b.updated_at <= $${params.length}`);
  }
  if (Array.isArray(ids) && ids.length) {
    const cleanIds = ids.map(Number).filter(Number.isInteger);
    if (cleanIds.length) {
      params.push(cleanIds);
      filters.push(`b.item_id = ANY($${params.length}::int[])`);
    }
  }

  const { rows: boms } = await pool.query(
    `SELECT b.id,
            b.item_id,
            COALESCE(i.name_en, i.name) AS name,
            b.full_name,
            b.reference_code,
            b.recipe_type,
            b.yield_kg,
            b.total_weight,
            b.servings_count,
            b.is_spicy,
            b.allergens,
            b.description,
            b.serving_suggestion,
            i.image_url,
            i.cost_per_kg,
            b.total_cost,
            b.wholesale_price,
            b.retail_price,
            b.version,
            b.updated_at
     FROM   boms b
     JOIN   items i ON i.id = b.item_id
     WHERE  ${filters.join(' AND ')}
     ORDER BY b.updated_at DESC`,
    params
  );

  if (boms.length === 0) {
    return res.status(404).json({ error: 'No recipes match the export filters.' });
  }

  // Fetch lines for the selected recipes in one query
  const bomIds = boms.map((b) => b.id);
  const { rows: lineRows } = await pool.query(
    `SELECT l.bom_id,
            l.quantity_kg, l.line_uom, l.waste_pct,
            ing.reference  AS ingredient_code,
            COALESCE(ing.name_en, ing.name) AS ingredient_name
     FROM   bom_lines l
     JOIN   items ing ON ing.id = l.ingredient_item_id
     WHERE  l.bom_id = ANY($1::int[])
     ORDER  BY l.bom_id, l.id`,
    [bomIds]
  );

  const linesByBom = new Map();
  for (const r of lineRows) {
    if (!linesByBom.has(r.bom_id)) linesByBom.set(r.bom_id, []);
    linesByBom.get(r.bom_id).push({
      name:        r.ingredient_name,
      code:        r.ingredient_code,
      quantity_kg: r.quantity_kg != null ? parseFloat(r.quantity_kg) : null,
      waste_pct:   r.waste_pct   != null ? parseFloat(r.waste_pct)   : 0,
      line_uom:    r.line_uom || 'kg',
    });
  }

  // Image URLs come in two shapes:
  //   1. http(s) → written as a text URL into the IMAGE URL cell
  //   2. data:image/…;base64,… (uploaded directly to a recipe) → too
  //      long for a cell (Excel's 32 767 character limit would mangle
  //      it) AND useless as text.  buildExportWorkbook embeds these
  //      as actual Excel images instead, and parseRecipeWorkbook
  //      extracts them back to data URIs on re-import — so a recipe
  //      with an uploaded image round-trips cleanly.
  const recipesForSheet = boms.map((b) => ({
    image_url:          b.image_url || null,
    name:               b.name,
    reference_code:     b.reference_code,
    recipe_type:        b.recipe_type,
    yield_kg:           b.yield_kg != null ? parseFloat(b.yield_kg) : null,
    full_name:          b.full_name,
    description:        b.description,
    allergens:          Array.isArray(b.allergens) ? b.allergens : [],
    is_spicy:           !!b.is_spicy,
    serving_suggestion: b.serving_suggestion,
    servings_count:     b.servings_count,
    total_weight:       b.total_weight != null ? parseFloat(b.total_weight) : null,
    cost_per_kg:        b.cost_per_kg != null ? parseFloat(b.cost_per_kg) : null,
    total_cost:         b.total_cost  != null ? parseFloat(b.total_cost)  : null,
    wholesale_price:    b.wholesale_price != null ? parseFloat(b.wholesale_price) : null,
    retail_price:       b.retail_price    != null ? parseFloat(b.retail_price)    : null,
    version:            b.version,
    updated_at:         b.updated_at ? new Date(b.updated_at).toISOString().slice(0, 19).replace('T', ' ') : '',
    lines:              linesByBom.get(b.id) || [],
  }));

  const buf = await buildExportWorkbook(recipesForSheet, { includePrices: includePrices !== false });

  const suffix = type ? `${type}-` : '';
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="recipes-${suffix}${timestampSuffix()}.xlsx"`
  );
  res.setHeader('Content-Length', buf.length);
  res.send(Buffer.from(buf));
});

// Multer errors (file too big, wrong type) come through here.
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.startsWith('Only .xlsx')) {
    return res.status(400).json({ error: err.message });
  }
  throw err;
});

module.exports = router;
