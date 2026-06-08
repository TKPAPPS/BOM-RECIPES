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
const tls    = require('tls');
const cron   = require('node-cron');
const pool   = require('../config/db');
const { logAudit } = require('./auditService');
const { resolveProductCost } = require('../utils/costResolver');

// ─── XML-RPC client factory ──────────────────────────────────────────────────

function makeClient(path) {
  const url     = new URL(process.env.ODOO_URL);
  const isHttps = url.protocol === 'https:';
  const opts = { host: url.hostname, port: url.port || (isHttps ? 443 : 80), path };

  if (isHttps) {
    // Odoo's "*.odoo.com" wildcard certificate only covers single-level
    // subdomains, so a multi-level staging host like
    // "<db>.dev.odoo.com" fails Node's default hostname check even though
    // the certificate is valid and CA-signed.  Keep full chain validation
    // (rejectUnauthorized stays true) but accept the hostname mismatch for
    // the EXACT host we were configured to talk to in ODOO_URL.
    opts.checkServerIdentity = (host, cert) => {
      const err = tls.checkServerIdentity(host, cert);
      if (err && host === url.hostname) return undefined; // trust the configured Odoo host
      return err;
    };
    return xmlrpc.createSecureClient(opts);
  }
  return xmlrpc.createClient(opts);
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

// ─── Resolve the company to scope the sync to ────────────────────────────────
//
// The Odoo instance is multi-company (one company per Kosher Place
// location).  We only want raw materials belonging to a single company.
// Configure it with either ODOO_COMPANY_ID (exact id, skips the lookup)
// or ODOO_COMPANY_NAME (looked up by name).  Defaults to the Thailand HQ.
//
// Returns the numeric company id, or null when no company could be
// resolved (in which case the sync falls back to pulling all companies
// and logs a prominent warning so the misconfiguration is visible).
const DEFAULT_COMPANY_NAME = 'The Kosher Place (Thailand) Co. Ltd';

async function resolveCompanyId(uid) {
  const explicit = parseInt(process.env.ODOO_COMPANY_ID, 10);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;

  const name = (process.env.ODOO_COMPANY_NAME || DEFAULT_COMPANY_NAME).trim();
  const obj  = makeClient('/xmlrpc/2/object');
  const ids  = await rpcCall(obj, 'execute_kw', [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_PASSWORD,
    'res.company',
    'search',
    [[['name', 'ilike', name]]],
    { limit: 1 },
  ]);

  if (Array.isArray(ids) && ids.length > 0) return ids[0];

  console.error(
    `[odooSync] WARNING: company "${name}" not found in Odoo — ` +
    `syncing ALL companies. Set ODOO_COMPANY_ID or fix ODOO_COMPANY_NAME.`
  );
  return null;
}

// ─── Fetch products from Odoo (one language at a time) ───────────────────────

async function fetchOdooProducts(uid, lang, companyId, opts = {}) {
  const obj = makeClient('/xmlrpc/2/object');
  const archived = !!opts.archived;

  // Normal fetch → active products only.  Archived fetch → active = false.
  // Naming `active` in the domain disables Odoo's implicit hide-archived
  // filter; active_test:false is required so the archived branch can see
  // inactive rows at all (harmless for the normal branch since the domain
  // pins active = true).
  const domain = [['type', 'in', ['consu', 'product']], ['active', '=', !archived]];
  if (companyId != null) {
    // Scope to the target company.  Include `false` so company-shared
    // products (available to every company, including this one) are not
    // dropped — only OTHER companies' exclusive products are excluded.
    domain.push(['company_id', 'in', [companyId, false]]);
  }

  const args = [
    process.env.ODOO_DB,
    uid,
    process.env.ODOO_PASSWORD,
    'product.template',
    'search_read',
    [domain],
    {
      fields: ['id', 'name', 'default_code', 'uom_id', 'standard_price', 'weight', 'image_128', 'categ_id'],
      limit: 0,
      context: { lang, active_test: archived ? false : true },
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
    const archivedFlags = chunk.map((r) => r.odooArchived);

    // UNNEST into a derived table first, then LEFT JOIN categories to resolve
    // the Odoo category ID → our local categories.id FK in a single round-trip.
    await client.query(
      `INSERT INTO items
         (odoo_id, name, name_en, name_he, uom, reference, raw_cost, volume_weight,
          cost_per_kg, image_url, category_id,
          weight_extracted_grams, weight_source, odoo_archived, is_active,
          item_type, last_synced_at, updated_at)
       SELECT
         u.odoo_id, u.name, u.name_en, u.name_he, u.uom, u.reference,
         u.raw_cost, u.volume_weight, u.cost_per_kg, u.image_url,
         c.id AS category_id,
         u.weight_extracted_grams,
         u.weight_source,
         u.odoo_archived,
         (NOT u.odoo_archived) AS is_active,   -- archived → inactive, active → active
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
           unnest($13::text[])    AS weight_source,
           unnest($14::bool[])    AS odoo_archived
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
         -- Preserve a manually-overridden cost-per-kg; the manual_*
         -- columns themselves are never in this upsert, so they survive.
         cost_per_kg            = CASE WHEN items.cost_overridden
                                       THEN items.cost_per_kg
                                       ELSE EXCLUDED.cost_per_kg END,
         image_url              = EXCLUDED.image_url,
         category_id            = EXCLUDED.category_id,
         weight_extracted_grams = EXCLUDED.weight_extracted_grams,
         weight_source          = EXCLUDED.weight_source,
         odoo_archived          = EXCLUDED.odoo_archived,
         -- Re-activate un-archived products and deactivate newly-archived
         -- ones in lock-step with the archived flag.
         is_active              = EXCLUDED.is_active,
         last_synced_at         = NOW(),
         updated_at             = NOW()`,
      [odooIds, names, namesEN, namesHE, uoms, references, rawCosts, volumeWeights,
       costPerKgs, imageUrls, categOdooIds, extractedG, weightSrcs, archivedFlags]
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

// ─── Product row builder ─────────────────────────────────────────────────────

/**
 * Shape one Odoo product.template record into the row our bulk upsert
 * expects.  `archived` flags products fetched from Odoo's archive — they
 * are stored but later forced is_active = FALSE by the deactivation step.
 */
function buildProductRow(p, heMap, archived) {
  const rawCost = parseFloat(p.standard_price) || 0;
  const odooKg  = parseFloat(p.weight);
  const hasOdoo = Number.isFinite(odooKg) && odooKg > 0;
  // Auto-resolved cost (no manual overrides here — those are applied
  // at read time and preserved across syncs via cost_overridden).
  const c = resolveProductCost({ name: p.name, rawCost, odooWeightKg: p.weight });

  // Image guard: Odoo returns Python False (→ JS false), empty string, or
  // a base64 PNG string.  Only store it when it looks like real image data.
  const rawImage = (typeof p.image_128 === 'string' && p.image_128.length > 100)
    ? p.image_128
    : null;
  const imageUrl = rawImage ? `data:image/png;base64,${rawImage}` : null;

  return {
    odooId:                p.id,
    name:                  p.name,
    nameEN:                p.name,
    nameHE:                heMap.get(p.id) ?? null,
    uom:                   p.uom_id ? p.uom_id[1] : 'kg',
    reference:             p.default_code || null,
    rawCost,
    volumeWeight:          hasOdoo ? odooKg : null,        // only real Odoo weight
    weightExtractedGrams:  c.weightExtractedGrams,         // real weight only (g)
    weightSource:          c.weightSource,                 // 'odoo' | 'name_regex' | 'none'
    costPerKg:             c.costPerKg,                     // kg / litre / unit / raw-cost fallback
    imageUrl,
    categoryOdooId:        Array.isArray(p.categ_id) ? p.categ_id[0] : null,
    odooArchived:          !!archived,
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

  // Resolve which company to scope the catalogue to (multi-company Odoo).
  let companyId = null;
  try {
    companyId = await resolveCompanyId(uid);
    if (companyId != null) {
      console.log(`[odooSync] Scoping products to company id ${companyId} ` +
        `(${process.env.ODOO_COMPANY_NAME || DEFAULT_COMPANY_NAME}).`);
    }
  } catch (err) {
    console.error('[odooSync] Company lookup failed (syncing all companies):', err.message);
  }

  // Fetch products in both languages (parallel for speed).  We also pull
  // ARCHIVED products (in EN only) — stored but flagged so the Products tab
  // can optionally surface them; they stay out of recipes/search/dashboard.
  let productsEN, productsHE, productsArchived;
  try {
    [productsEN, productsHE, productsArchived] = await Promise.all([
      fetchOdooProducts(uid, 'en_US', companyId),
      fetchOdooProducts(uid, 'he_IL', companyId).catch((err) => {
        // Hebrew locale may not exist in all Odoo instances — degrade gracefully
        console.warn('[odooSync] Hebrew fetch failed (he_IL may not be installed):', err.message);
        return [];
      }),
      fetchOdooProducts(uid, 'en_US', companyId, { archived: true }).catch((err) => {
        console.warn('[odooSync] Archived fetch failed (continuing without archived):', err.message);
        return [];
      }),
    ]);
    console.log(`[odooSync] Fetched ${productsEN.length} active (EN), ${productsHE.length} (HE), ${productsArchived.length} archived`);
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

  // Build product rows — active first, then archived (flagged).  A product
  // is either active or archived in Odoo, never both, so no odoo_id clashes.
  const productRows = [
    ...productsEN.map((p) => buildProductRow(p, heMap, false)),
    ...productsArchived.map((p) => buildProductRow(p, heMap, true)),
  ];

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
