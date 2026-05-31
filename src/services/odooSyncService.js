/**
 * odooSyncService.js
 *
 * Syncs raw materials and product categories from Odoo v18 via XML-RPC.
 *
 * Odoo XML-RPC endpoints:
 *   /xmlrpc/2/common  → authenticate
 *   /xmlrpc/2/object  → call model methods
 *
 * Products fetched in both en_US and he_IL contexts to populate
 * name_en and name_he columns for bilingual search & display.
 */

const xmlrpc = require('xmlrpc');
const cron   = require('node-cron');
const pool   = require('../config/db');
const { logAudit } = require('./auditService');
const { extractWeightFromName } = require('../utils/weightExtractor');

// ─── XML-RPC client factory ──────────────────────────────────────────────────

function makeClient(path) {
  const url  = new URL(process.env.ODOO_URL);
  const opts = { host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path };
  return url.protocol === 'https:'
    ? xmlrpc.createSecureClient(opts)
    : xmlrpc.createClient(opts);
}

function rpcCall(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => (err ? reject(err) : resolve(val)));
  });
}

// ─── Authenticate ────────────────────────────────────────────────────────────

async function authenticate() {
  const common = makeClient('/xmlrpc/2/common');
  const uid = await rpcCall(common, 'authenticate', [
    process.env.ODOO_DB,
    process.env.ODOO_USER,
    process.env.ODOO_PASSWORD,
    {},
  ]);
  if (!uid) throw new Error('Odoo authentication failed — check credentials');
  return uid;
}

// ─── Fetch products from Odoo (one language at a time) ───────────────────────

async function fetchOdooProducts(uid, lang) {
  const obj = makeClient('/xmlrpc/2/object');
  const args = [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_PASSWORD,
    'product.template',
    'search_read',
    [[['type', 'in', ['consu', 'product']], ['active', '=', true]]],
    {
      fields: ['id', 'name', 'default_code', 'uom_id', 'standard_price', 'weight', 'image_128', 'categ_id'],
      limit: 0,
      context: { lang },
    },
  ];
  return rpcCall(obj, 'execute_kw', args);
}

// ─── Fetch product categories from Odoo ──────────────────────────────────────

async function fetchOdooCategories(uid) {
  const obj = makeClient('/xmlrpc/2/object');
  const args = [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_PASSWORD,
    'product.category',
    'search_read',
    [[]],
    { fields: ['id', 'name', 'complete_name'], limit: 0 },
  ];
  return rpcCall(obj, 'execute_kw', args);
}

// ─── Bulk upsert helpers (UNNEST-based — single round-trip) ──────────────────

/**
 * Upsert all products in one query using UNNEST array parameters.
 * Replaces N individual INSERT … VALUES ($1,$2,…) calls with a single
 * parameterised statement, reducing DB round-trips from O(n) → O(1).
 *
 * category_id is resolved at query-time via a LEFT JOIN on categories.odoo_id
 * so no application-side lookup is needed.  Because categories are upserted
 * in the same transaction before this call, the FK always resolves correctly.
 */
async function bulkUpsertProducts(client, rows) {
  if (rows.length === 0) return 0;

  const CHUNK = 500; // keep individual statements small (image data makes rows large)
  let total = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    const odooIds       = chunk.map((r) => r.odooId);
    const names         = chunk.map((r) => r.name);
    const namesEN       = chunk.map((r) => r.nameEN);
    const namesHE       = chunk.map((r) => r.nameHE);
    const uoms          = chunk.map((r) => r.uom);
    const references    = chunk.map((r) => r.reference);
    const rawCosts      = chunk.map((r) => r.rawCost);
    const volumeWeights = chunk.map((r) => r.volumeWeight);
    const costPerKgs    = chunk.map((r) => r.costPerKg);
    const imageUrls     = chunk.map((r) => r.imageUrl);
    const categOdooIds  = chunk.map((r) => r.categoryOdooId); // may contain NULLs
    const extractedG    = chunk.map((r) => r.weightExtractedGrams);
    const weightSrcs    = chunk.map((r) => r.weightSource);

    // UNNEST into a derived table first, then LEFT JOIN categories to resolve
    // the Odoo category ID → our local categories.id FK in a single round-trip.
    await client.query(
      `INSERT INTO items
         (odoo_id, name, name_en, name_he, uom, reference, raw_cost, volume_weight,
          cost_per_kg, image_url, category_id,
          weight_extracted_grams, weight_source,
          item_type, last_synced_at, updated_at)
       SELECT
         u.odoo_id, u.name, u.name_en, u.name_he, u.uom, u.reference,
         u.raw_cost, u.volume_weight, u.cost_per_kg, u.image_url,
         c.id AS category_id,
         u.weight_extracted_grams,
         u.weight_source,
         'raw_material',
         NOW(),
         NOW()
       FROM (
         SELECT
           unnest($1::int[])     AS odoo_id,
           unnest($2::text[])    AS name,
           unnest($3::text[])    AS name_en,
           unnest($4::text[])    AS name_he,
           unnest($5::text[])    AS uom,
           unnest($6::text[])    AS reference,
           unnest($7::numeric[]) AS raw_cost,
           unnest($8::numeric[]) AS volume_weight,
           unnest($9::numeric[]) AS cost_per_kg,
           unnest($10::text[])   AS image_url,
           unnest($11::int[])    AS categ_odoo_id,
           unnest($12::numeric[]) AS weight_extracted_grams,
           unnest($13::text[])    AS weight_source
       ) u
       LEFT JOIN categories c ON c.odoo_id = u.categ_odoo_id
       ON CONFLICT (odoo_id) DO UPDATE SET
         name                   = EXCLUDED.name,
         name_en                = EXCLUDED.name_en,
         name_he                = EXCLUDED.name_he,
         uom                    = EXCLUDED.uom,
         reference              = EXCLUDED.reference,
         raw_cost               = EXCLUDED.raw_cost,
         volume_weight          = EXCLUDED.volume_weight,
         cost_per_kg            = EXCLUDED.cost_per_kg,
         image_url              = EXCLUDED.image_url,
         category_id            = EXCLUDED.category_id,
         weight_extracted_grams = EXCLUDED.weight_extracted_grams,
         weight_source          = EXCLUDED.weight_source,
         last_synced_at         = NOW(),
         updated_at             = NOW()`,
      [odooIds, names, namesEN, namesHE, uoms, references, rawCosts, volumeWeights,
       costPerKgs, imageUrls, categOdooIds, extractedG, weightSrcs]
    );

    total += chunk.length;
    console.log(`[odooSync] Upserted ${total}/${rows.length} products…`);
  }

  return total;
}

/**
 * Upsert all categories in one query using UNNEST array parameters.
 */
async function bulkUpsertCategories(client, rows) {
  if (rows.length === 0) return 0;

  const odooIds = rows.map((r) => r.odooId);
  const names   = rows.map((r) => r.name);

  await client.query(
    `INSERT INTO categories (odoo_id, name)
     SELECT unnest($1::int[]), unnest($2::text[])
     ON CONFLICT (odoo_id) DO UPDATE SET
       name = EXCLUDED.name`,
    [odooIds, names]
  );

  return rows.length;
}

/**
 * Resolve the weight situation for one product.
 *
 * Returns a small struct so the caller knows BOTH the value to use
 * for cost calc AND where the value came from — critical so the
 * UI can flag estimated rows.
 *
 *   {
 *     odooWeightKg:           number|null,  // exactly what Odoo sent
 *     weightExtractedGrams:   number|null,  // regex on the name, in grams
 *     weightSource:           'odoo' | 'name_regex' | 'none',
 *     effectiveWeightKg:      number|null,  // value to use for cost_per_kg
 *   }
 *
 * The real Odoo weight ALWAYS wins when present.  We still try to
 * extract from the name even when Odoo has a weight, so the extracted
 * value is saved as a backup but is not used for costing.
 */
function resolveWeight(weight, productName) {
  const odooKg = parseFloat(weight);
  const hasOdoo = Number.isFinite(odooKg) && odooKg > 0;

  const extracted = extractWeightFromName(productName);
  const extractedGrams = extracted ? extracted.grams : null;

  let source;
  let effectiveKg;
  if (hasOdoo) {
    source      = 'odoo';
    effectiveKg = odooKg;
  } else if (extractedGrams != null && extractedGrams > 0) {
    source      = 'name_regex';
    effectiveKg = extractedGrams / 1000;
  } else {
    source      = 'none';
    effectiveKg = null;
  }

  return {
    odooWeightKg:         hasOdoo ? odooKg : null,
    weightExtractedGrams: extractedGrams,
    weightSource:         source,
    effectiveWeightKg:    effectiveKg,
  };
}

// ─── Main sync function ───────────────────────────────────────────────────────

async function syncFromOdoo() {
  console.log('[odooSync] Starting sync…');
  const startedAt = Date.now();

  let uid;
  try {
    uid = await authenticate();
    console.log(`[odooSync] Authenticated with UID ${uid}`);
  } catch (err) {
    console.error('[odooSync] Auth error:', err.message);
    throw err;
  }

  // Fetch products in both languages (parallel for speed)
  let productsEN, productsHE;
  try {
    [productsEN, productsHE] = await Promise.all([
      fetchOdooProducts(uid, 'en_US'),
      fetchOdooProducts(uid, 'he_IL').catch((err) => {
        // Hebrew locale may not exist in all Odoo instances — degrade gracefully
        console.warn('[odooSync] Hebrew fetch failed (he_IL may not be installed):', err.message);
        return [];
      }),
    ]);
    console.log(`[odooSync] Fetched ${productsEN.length} products (EN), ${productsHE.length} (HE)`);
  } catch (err) {
    console.error('[odooSync] Product fetch error:', err.message);
    throw err;
  }

  // Build a map of odooId → Hebrew name
  const heMap = new Map(productsHE.map((p) => [p.id, p.name]));

  // Fetch categories
  let odooCategories = [];
  try {
    odooCategories = await fetchOdooCategories(uid);
    console.log(`[odooSync] Fetched ${odooCategories.length} product categories`);
  } catch (err) {
    console.warn('[odooSync] Category fetch failed (continuing without categories):', err.message);
  }

  // Build category rows
  const catRows = odooCategories.map((cat) => ({
    odooId: cat.id,
    name:   cat.complete_name || cat.name,
  }));

  // Build product rows
  const productRows = productsEN.map((p) => {
    const rawCost = parseFloat(p.standard_price) || 0;
    const w       = resolveWeight(p.weight, p.name);

    // Image guard: Odoo returns Python False (→ JS false), empty string, or
    // a base64 PNG string.  Only store it when it looks like real image data.
    const rawImage = (typeof p.image_128 === 'string' && p.image_128.length > 100)
      ? p.image_128
      : null;
    const imageUrl = rawImage ? `data:image/png;base64,${rawImage}` : null;

    // volume_weight stores ONLY what Odoo returned — never the regex
    // fallback.  When Odoo has no weight we save NULL, and the
    // weight_extracted_grams / weight_source columns carry the fallback.
    return {
      odooId:                p.id,
      name:                  p.name,
      nameEN:                p.name,
      nameHE:                heMap.get(p.id) ?? null,
      uom:                   p.uom_id ? p.uom_id[1] : 'kg',
      reference:             p.default_code || null,
      rawCost,
      volumeWeight:          w.odooWeightKg,                // only real Odoo weight
      weightExtractedGrams:  w.weightExtractedGrams,        // always saved when extractable
      weightSource:          w.weightSource,                // 'odoo' | 'name_regex' | 'none'
      costPerKg:             w.effectiveWeightKg && w.effectiveWeightKg > 0
                                ? rawCost / w.effectiveWeightKg
                                : rawCost,
      imageUrl,
      categoryOdooId:        Array.isArray(p.categ_id) ? p.categ_id[0] : null,
    };
  });

  const client = await pool.connect();
  let synced = 0, catsSynced = 0, errors = 0;

  try {
    await client.query('BEGIN');

    // ── Bulk upsert categories (single round-trip) ──
    try {
      catsSynced = await bulkUpsertCategories(client, catRows);
    } catch (err) {
      console.error('[odooSync] Bulk category upsert failed:', err.message);
      errors++;
    }

    // ── Bulk upsert products (single round-trip) ──
    try {
      synced = await bulkUpsertProducts(client, productRows);
    } catch (err) {
      console.error('[odooSync] Bulk product upsert failed:', err.message);
      errors++;
      throw err; // re-throw so the transaction rolls back
    }

    // Mark items no longer in Odoo as inactive
    const odooIds = productsEN.map((p) => p.id);
    if (odooIds.length) {
      await client.query(
        `UPDATE items SET is_active = FALSE, updated_at = NOW()
         WHERE  item_type = 'raw_material'
           AND  odoo_id IS NOT NULL
           AND  odoo_id != ALL($1::int[])`,
        [odooIds]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── P2-4: Cost History Ledger — record price changes for synced raw materials ──
  // Insert a cost_history row only when the price differs from the last recorded entry.
  let costHistoryInserted = 0;
  try {
    const odooIdList = productsEN.map((p) => p.id);
    if (odooIdList.length > 0) {
      const { rowCount } = await pool.query(
        `INSERT INTO cost_history (item_id, cost_per_kg, source)
         SELECT i.id, i.cost_per_kg, 'odoo_sync'
         FROM   items i
         WHERE  i.item_type = 'raw_material'
           AND  i.odoo_id = ANY($1::int[])
           AND  i.cost_per_kg IS NOT NULL
           AND  (
                  -- No previous record exists for this item
                  NOT EXISTS (
                    SELECT 1 FROM cost_history ch
                    WHERE  ch.item_id = i.id AND ch.source = 'odoo_sync'
                  )
                  OR
                  -- Cost has changed since the last sync record
                  i.cost_per_kg IS DISTINCT FROM (
                    SELECT ch2.cost_per_kg
                    FROM   cost_history ch2
                    WHERE  ch2.item_id = i.id AND ch2.source = 'odoo_sync'
                    ORDER BY ch2.recorded_at DESC
                    LIMIT  1
                  )
                )`,
        [odooIdList]
      );
      costHistoryInserted = rowCount ?? 0;
    }
  } catch (err) {
    console.warn('[odooSync] cost_history insert failed (non-fatal):', err.message);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[odooSync] Done — products synced: ${synced}, categories synced: ${catsSynced}, price changes logged: ${costHistoryInserted}, errors: ${errors}, elapsed: ${elapsed}s`
  );
  return { synced, catsSynced, costHistoryInserted, errors };
}

// ─── Audited sync wrapper (used by non-route triggers) ───────────────────────
//
// The manual route in src/routes/sync.js writes its own audit rows
// (with user_id + IP).  Non-user-triggered runs — cron jobs and the
// optional SYNC_ON_START boot path — need their own audit entries
// with user_id=NULL and a 'reason' tag in the description.  This
// wrapper handles those cases without touching syncFromOdoo itself.
async function runScheduledSync(reason = 'scheduled') {
  await logAudit({
    userId:      null,
    actionType:  'odoo_sync_trigger',
    entity:      'sync_job',
    description: `${reason}-triggered Odoo sync.`,
  });

  try {
    const result = await syncFromOdoo();
    await logAudit({
      userId:      null,
      actionType:  'odoo_sync_complete',
      entity:      'sync_job',
      description: `${reason} Odoo sync completed.`,
      valueAfter:  result,
    });
    return result;
  } catch (err) {
    await logAudit({
      userId:      null,
      actionType:  'odoo_sync_failure',
      entity:      'sync_job',
      description: `${reason} Odoo sync failed: ${err.message}`,
    });
    throw err;
  }
}

// ─── Cron scheduler ──────────────────────────────────────────────────────────

function startSyncJob() {
  const schedule = process.env.ODOO_SYNC_SCHEDULE || '0 */6 * * *';
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid ODOO_SYNC_SCHEDULE cron expression: "${schedule}"`);
  }

  cron.schedule(schedule, () => {
    runScheduledSync('cron').catch((err) =>
      console.error('[odooSync] Cron run failed:', err.message)
    );
  });

  console.log(`[odooSync] Cron scheduled: "${schedule}"`);
}

module.exports = { syncFromOdoo, startSyncJob, runScheduledSync };
