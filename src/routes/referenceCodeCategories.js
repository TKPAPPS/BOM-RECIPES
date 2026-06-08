/**
 * referenceCodeCategories.js — manager-defined reference-code prefixes.
 *
 * A reference code is PREFIX-#### (3–5 uppercase letters + 4 digits).
 * Managers define the prefixes; the next free number per prefix is
 * computed LIVE from every code in use (recipes, test recipes and raw
 * materials) so it fills gaps and never collides with imported codes.
 */

const express = require('express');
const pool    = require('../config/db');
const { requireAdmin, requireManager } = require('../middleware/authMiddleware');
const { logAudit, getIp } = require('../services/auditService');

const router = express.Router();

const PREFIX_RE = /^[A-Z]{3,5}$/;

/**
 * Collect every USED number for a prefix across recipes, test recipes
 * and raw materials.  Matches codes shaped exactly PREFIX-#### .
 * @returns {Promise<Set<number>>}
 */
async function usedNumbersForPrefix(prefix, db = pool) {
  const like = `${prefix}-%`;
  // Only ACTIVE rows occupy a number.  Soft-deleted recipes / inactive
  // raw materials free their number up again so the next-free helper can
  // reuse it (consistent with the import collision guard).
  const { rows } = await db.query(
    `SELECT reference_code AS code FROM boms          WHERE reference_code ILIKE $1 AND is_active = TRUE
     UNION ALL
     SELECT reference_code AS code FROM test_recipes  WHERE reference_code ILIKE $1
     UNION ALL
     SELECT reference      AS code FROM items         WHERE reference      ILIKE $1 AND is_active = TRUE`,
    [like]
  );
  const re = new RegExp(`^${prefix}-(\\d{4})$`, 'i');
  const used = new Set();
  for (const r of rows) {
    const m = re.exec((r.code || '').trim());
    if (m) used.add(parseInt(m[1], 10));
  }
  return used;
}

/** Smallest unused number 1..9999 for a prefix, or null if exhausted. */
function nextFree(used) {
  for (let n = 1; n <= 9999; n++) if (!used.has(n)) return n;
  return null;
}

const pad4 = (n) => String(n).padStart(4, '0');

// ── GET / — active categories (admins + managers; used by the builder) ──
router.get('/', requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, prefix, description FROM reference_code_categories
      WHERE is_active = TRUE ORDER BY prefix`
  );
  res.json(rows);
});

// ── GET /next?prefix=BAK — next free code for a prefix ──
router.get('/next', requireAdmin, async (req, res) => {
  const prefix = (req.query.prefix || '').toString().trim().toUpperCase();
  if (!PREFIX_RE.test(prefix)) {
    return res.status(400).json({ error: 'prefix must be 3–5 uppercase letters' });
  }
  const used = await usedNumbersForPrefix(prefix);
  const n = nextFree(used);
  if (n == null) return res.status(409).json({ error: 'full', message: `Category ${prefix} is full (9999 codes).` });
  res.json({ prefix, n, code: `${prefix}-${pad4(n)}` });
});

// ── POST / — create a category (manager) ──
router.post('/', requireManager, async (req, res) => {
  const prefix = (req.body?.prefix || '').toString().trim().toUpperCase();
  const description = (req.body?.description || '').toString().trim() || null;
  if (!PREFIX_RE.test(prefix)) {
    return res.status(400).json({ error: 'prefix must be 3–5 uppercase English letters' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO reference_code_categories (prefix, description, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (prefix) DO UPDATE SET
         description = EXCLUDED.description, is_active = TRUE, updated_at = NOW()
       RETURNING id, prefix, description`,
      [prefix, description, req.localUser?.id ?? null]
    );
    await logAudit({
      userId: req.localUser?.id ?? null, actionType: 'refcode_category_create',
      entity: 'reference_code_category', entityId: rows[0].id,
      description: `Reference-code category "${prefix}" saved.`, ipAddress: getIp(req),
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /reference-codes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /:id — update description (manager) ──
router.put('/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const description = (req.body?.description || '').toString().trim() || null;
  const { rows } = await pool.query(
    `UPDATE reference_code_categories SET description = $2, updated_at = NOW()
      WHERE id = $1 RETURNING id, prefix, description`,
    [id, description]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// ── DELETE /:id — soft delete (manager) ──
router.delete('/:id', requireManager, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  await pool.query(
    `UPDATE reference_code_categories SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
    [id]
  );
  await logAudit({
    userId: req.localUser?.id ?? null, actionType: 'refcode_category_delete',
    entity: 'reference_code_category', entityId: id,
    description: 'Reference-code category removed.', ipAddress: getIp(req),
  });
  res.json({ message: 'deleted' });
});

module.exports = router;
module.exports.usedNumbersForPrefix = usedNumbersForPrefix;
