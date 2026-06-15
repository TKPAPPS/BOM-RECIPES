-- =============================================================
-- BOM & Recipe Management System — PostgreSQL Schema
-- =============================================================

-- ------------------------------------------------------------
-- 1. CATEGORIES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 2. ITEMS  (raw materials AND recipes share this table)
--    item_type = 'raw_material' → synced from Odoo
--    item_type = 'recipe'       → defined internally, has a BOM
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
    id             SERIAL PRIMARY KEY,
    odoo_id        INTEGER UNIQUE,                         -- NULL for internal recipes
    name           VARCHAR(255) NOT NULL,
    category_id    INTEGER      REFERENCES categories(id) ON DELETE SET NULL,
    uom            VARCHAR(50)  NOT NULL DEFAULT 'kg',     -- canonical unit from Odoo
    cost_per_kg    NUMERIC(14, 6),                        -- THE core stored metric
    item_type      VARCHAR(20)  NOT NULL
                     CHECK (item_type IN ('raw_material', 'recipe')),
    is_active      BOOLEAN      DEFAULT TRUE,
    last_synced_at TIMESTAMPTZ,                            -- only set for raw_materials
    created_at     TIMESTAMPTZ  DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_odoo_id      ON items(odoo_id);
CREATE INDEX IF NOT EXISTS idx_items_category_id  ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_item_type    ON items(item_type);

-- ------------------------------------------------------------
-- 3. BOMS  (one BOM per recipe item, holds the yield)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boms (
    id         SERIAL PRIMARY KEY,
    item_id    INTEGER      NOT NULL UNIQUE               -- one BOM per recipe
                             REFERENCES items(id) ON DELETE CASCADE,
    yield_kg   NUMERIC(12, 4) NOT NULL CHECK (yield_kg > 0),
    notes      TEXT,
    version    INTEGER      DEFAULT 1,
    is_active  BOOLEAN      DEFAULT TRUE,
    created_at TIMESTAMPTZ  DEFAULT NOW(),
    updated_at TIMESTAMPTZ  DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 4. BOM_LINES  (ingredients of a BOM)
--    ingredient_item_id can point to EITHER a raw_material OR
--    another recipe → this is what enables nested BOMs.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bom_lines (
    id                   SERIAL PRIMARY KEY,
    bom_id               INTEGER        NOT NULL
                           REFERENCES boms(id) ON DELETE CASCADE,
    ingredient_item_id   INTEGER        NOT NULL
                           REFERENCES items(id),
    quantity_kg          NUMERIC(12, 6) NOT NULL CHECK (quantity_kg > 0),
    notes                TEXT,
    created_at           TIMESTAMPTZ    DEFAULT NOW(),
    UNIQUE (bom_id, ingredient_item_id)
);

CREATE INDEX IF NOT EXISTS idx_bom_lines_bom_id             ON bom_lines(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_lines_ingredient_item_id ON bom_lines(ingredient_item_id);

-- ------------------------------------------------------------
-- 5. PRICING_FORMULAS
--    scope     = 'global'   → applies to everything (scope_ref_id NULL)
--    scope     = 'category' → applies to a category  (scope_ref_id = categories.id)
--    scope     = 'item'     → applies to one item     (scope_ref_id = items.id)
--    price_tier: 'cost' | 'wholesale' | 'retail'
--
--    Resolution order (highest wins): item > category > global
--    Final price = cost_per_kg * multiplier
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pricing_formulas (
    id           SERIAL PRIMARY KEY,
    scope        VARCHAR(20)    NOT NULL
                   CHECK (scope IN ('global', 'category', 'item')),
    scope_ref_id INTEGER,                                  -- NULL for global
    price_tier   VARCHAR(20)    NOT NULL
                   CHECK (price_tier IN ('cost', 'wholesale', 'retail')),
    multiplier   NUMERIC(10, 4) NOT NULL CHECK (multiplier > 0),
    is_active    BOOLEAN        DEFAULT TRUE,
    created_at   TIMESTAMPTZ    DEFAULT NOW(),
    updated_at   TIMESTAMPTZ    DEFAULT NOW(),

    CONSTRAINT chk_scope_ref CHECK (
        (scope = 'global'   AND scope_ref_id IS NULL) OR
        (scope IN ('category', 'item') AND scope_ref_id IS NOT NULL)
    ),
    UNIQUE (scope, scope_ref_id, price_tier)
);

-- ------------------------------------------------------------
-- 6. TRIGGER — auto-update updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_items_updated_at
    BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_boms_updated_at
    BEFORE UPDATE ON boms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_pricing_formulas_updated_at
    BEFORE UPDATE ON pricing_formulas
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 7. SEED — default global pricing formulas
--   Conditional INSERT because the UNIQUE constraint on
--   (scope, scope_ref_id, price_tier) treats NULL scope_ref_id
--   rows as distinct, so a plain ON CONFLICT … DO NOTHING would
--   re-insert duplicates on every migration run.  Each tier is
--   only seeded when NO row for that tier exists at all (active
--   or inactive) so re-running migrations is a no-op.
-- ------------------------------------------------------------
INSERT INTO pricing_formulas (scope, scope_ref_id, price_tier, multiplier)
SELECT 'global', NULL, 'cost', 1.0
WHERE NOT EXISTS (SELECT 1 FROM pricing_formulas WHERE scope='global' AND scope_ref_id IS NULL AND price_tier='cost');

INSERT INTO pricing_formulas (scope, scope_ref_id, price_tier, multiplier)
SELECT 'global', NULL, 'wholesale', 2.5
WHERE NOT EXISTS (SELECT 1 FROM pricing_formulas WHERE scope='global' AND scope_ref_id IS NULL AND price_tier='wholesale');

INSERT INTO pricing_formulas (scope, scope_ref_id, price_tier, multiplier)
SELECT 'global', NULL, 'retail', 5.0
WHERE NOT EXISTS (SELECT 1 FROM pricing_formulas WHERE scope='global' AND scope_ref_id IS NULL AND price_tier='retail');

-- ------------------------------------------------------------
-- 8. MIGRATIONS — run safely on existing databases
-- ------------------------------------------------------------

-- Bilingual product names on items
ALTER TABLE items ADD COLUMN IF NOT EXISTS name_en VARCHAR(255);
ALTER TABLE items ADD COLUMN IF NOT EXISTS name_he VARCHAR(255);

-- Odoo category ID on categories (for synced Odoo categories)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS odoo_id INTEGER UNIQUE;

CREATE INDEX IF NOT EXISTS idx_categories_odoo_id ON categories(odoo_id);

-- SKU / reference code from Odoo default_code
ALTER TABLE items ADD COLUMN IF NOT EXISTS reference VARCHAR(100);

-- Raw Odoo unit price (standard_price before weight normalisation)
ALTER TABLE items ADD COLUMN IF NOT EXISTS raw_cost NUMERIC(14, 6);

-- Package weight from Odoo (used to derive cost_per_kg)
ALTER TABLE items ADD COLUMN IF NOT EXISTS volume_weight NUMERIC(12, 4);

-- ------------------------------------------------------------
-- Name-regex weight fallback
--   When Odoo's volume_weight is NULL/0 we try to parse a weight
--   out of the product name ("Coffee 200 gr" → 200 g).  The parsed
--   value is stored SEPARATELY so the original Odoo field stays
--   untouched — a real Odoo weight always wins.
--   weight_source = 'odoo'       → volume_weight came from Odoo
--                 = 'name_regex' → no Odoo weight; weight_extracted_grams used
--                 = 'none'       → no weight resolvable from any source
-- ------------------------------------------------------------
ALTER TABLE items ADD COLUMN IF NOT EXISTS weight_extracted_grams NUMERIC(12, 4);
ALTER TABLE items ADD COLUMN IF NOT EXISTS weight_source VARCHAR(20) NOT NULL DEFAULT 'none';

DO $$ BEGIN
  ALTER TABLE items
    ADD CONSTRAINT chk_items_weight_source
    CHECK (weight_source IN ('odoo', 'name_regex', 'none'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_items_weight_source ON items(weight_source);

-- ------------------------------------------------------------
-- Manual cost/weight overrides (Products tab inline editing)
--   When a value is parsed wrong (or missing) an admin can override
--   the cost price, the weight, and/or the cost-per-kg directly.
--   These columns are NULL until overridden and are NEVER touched by
--   the Odoo sync, so a manual correction survives future syncs.
--   cost_overridden is the guard the sync checks before overwriting
--   the canonical items.cost_per_kg.
-- ------------------------------------------------------------
ALTER TABLE items ADD COLUMN IF NOT EXISTS manual_raw_cost     NUMERIC(14, 6);
ALTER TABLE items ADD COLUMN IF NOT EXISTS manual_weight_grams NUMERIC(12, 4);
ALTER TABLE items ADD COLUMN IF NOT EXISTS manual_cost_per_kg  NUMERIC(14, 6);
ALTER TABLE items ADD COLUMN IF NOT EXISTS cost_overridden     BOOLEAN NOT NULL DEFAULT FALSE;

-- Archived-in-Odoo flag.  The sync also pulls Odoo's archived products
-- (active = false) but stores them with is_active = FALSE so they stay
-- out of recipes, search and the dashboard count.  This flag lets the
-- Products tab optionally surface them via an "include archived" toggle.
ALTER TABLE items ADD COLUMN IF NOT EXISTS odoo_archived BOOLEAN NOT NULL DEFAULT FALSE;

-- ------------------------------------------------------------
-- Reference-code categories
--   A recipe reference code is 3–5 uppercase letters + "-" + 4 digits
--   (e.g. BAK-0001).  The manager defines the category prefixes here;
--   the next free number per prefix is derived LIVE from the codes
--   actually in use (boms / test_recipes / items.reference) so it never
--   desyncs with manual edits or Excel imports.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reference_code_categories (
    id          SERIAL PRIMARY KEY,
    prefix      VARCHAR(5)  NOT NULL UNIQUE
                  CHECK (prefix ~ '^[A-Z]{3,5}$'),
    description TEXT,
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Product thumbnail image synced from Odoo (stored as base64 data URI)
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Reference/SKU code for recipe BOMs (internal use)
ALTER TABLE boms ADD COLUMN IF NOT EXISTS reference_code VARCHAR(100);

-- Calculated cost snapshot stored on the BOM itself (enables fast sub-assembly search)
ALTER TABLE boms ADD COLUMN IF NOT EXISTS cost_per_kg NUMERIC(14, 6);
ALTER TABLE boms ADD COLUMN IF NOT EXISTS total_cost  NUMERIC(14, 6);

-- ------------------------------------------------------------
-- P2-1: UOM per BOM line (the unit the user entered the qty in)
-- ------------------------------------------------------------
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS line_uom VARCHAR(20) NOT NULL DEFAULT 'kg';

-- ------------------------------------------------------------
-- P2-2: Waste / shrinkage percentage per BOM line
--        effective_quantity = quantity_kg / (1 - waste_pct / 100)
-- ------------------------------------------------------------
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS waste_pct NUMERIC(7, 4) NOT NULL DEFAULT 0
  CHECK (waste_pct >= 0 AND waste_pct < 100);

-- ------------------------------------------------------------
-- P2-3: Per-batch production cost fields on BOMs
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS labor_cost     NUMERIC(14, 6) NOT NULL DEFAULT 0;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS overhead_cost  NUMERIC(14, 6) NOT NULL DEFAULT 0;
-- packaging_cost removed: packaging is entered as BOM ingredient lines instead

-- ------------------------------------------------------------
-- P2-5: BOM Version Snapshots (immutable history per save)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bom_snapshots (
    id             SERIAL PRIMARY KEY,
    bom_id         INTEGER        NOT NULL REFERENCES boms(id)   ON DELETE CASCADE,
    item_id        INTEGER        NOT NULL REFERENCES items(id)  ON DELETE CASCADE,
    version        INTEGER        NOT NULL,
    yield_kg       NUMERIC(12, 4) NOT NULL,
    cost_per_kg    NUMERIC(14, 6),
    total_cost     NUMERIC(14, 6),
    labor_cost     NUMERIC(14, 6) DEFAULT 0,
    overhead_cost  NUMERIC(14, 6) DEFAULT 0,
    packaging_cost NUMERIC(14, 6) DEFAULT 0,
    reference_code VARCHAR(100),
    snapshot       JSONB          NOT NULL,  -- full ingredient list at time of save
    created_at     TIMESTAMPTZ    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bom_snapshots_bom_id  ON bom_snapshots(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_snapshots_item_id ON bom_snapshots(item_id);

-- ------------------------------------------------------------
-- P2-4: Cost History Ledger (append-only price audit log)
--        source = 'odoo_sync' | 'bom_save'
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_history (
    id          SERIAL PRIMARY KEY,
    item_id     INTEGER        NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    cost_per_kg NUMERIC(14, 6) NOT NULL,
    recorded_at TIMESTAMPTZ    DEFAULT NOW(),
    source      VARCHAR(20)    NOT NULL
                  CHECK (source IN ('odoo_sync', 'bom_save'))
);

CREATE INDEX IF NOT EXISTS idx_cost_history_item_id     ON cost_history(item_id);
CREATE INDEX IF NOT EXISTS idx_cost_history_recorded_at ON cost_history(recorded_at);

-- ------------------------------------------------------------
-- Recipe Type: WIP sub-assembly vs sellable finished good
--   'base'  = Base Recipe / WIP  — raw food mixture, no pricing
--   'final' = Final Packaged Product — sellable SKU, has pricing
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS recipe_type VARCHAR(20) NOT NULL DEFAULT 'base'
  CHECK (recipe_type IN ('base', 'final'));

-- =============================================================
-- STEP 1 — Recipe Book Extensions  (additive migration block)
-- =============================================================
-- All changes here are ADDITIVE and IDEMPOTENT:
--   • ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS
--   • CHECK constraints wrapped in DO $$ … EXCEPTION blocks
--   • No DROPs that would lose data; no rewrites of existing data
--
-- Modeling decisions (confirmed in audit before writing):
--   1. Recipes stay unified with `items` + `boms` — no parallel
--      `recipes` table — so the recursive costing service and the
--      sub-assembly nesting in bom_lines keep working untouched.
--   2. `bom_lines` keeps its polymorphic FK to items; we add an
--      explicit `ingredient_type` mirror column (synced from
--      items.item_type) so the line itself is self-describing.
--   3. `pricing_formulas` keeps the tall shape (one row per
--      price_tier). We add `name` + `priority` columns and widen
--      the scope CHECK to accept the plan's 'product' / 'recipe'
--      aliases alongside the existing 'item'.
--   4. `users` is a CACHE of Odoo users (auth stays external to
--      Odoo) — no hashed_password column.
--   5. `can_view_prices` is a per-user override on top of role
--      (NULL = follow role default).
--   6. `audit_logs` covers GAPS only — login events, user changes,
--      pricing changes, sync triggers, quantity calcs.  Recipe
--      edit history remains in bom_snapshots.
-- =============================================================

-- ------------------------------------------------------------
-- STEP 1.1 — USERS (Odoo-user cache, no local password)
--   • odoo_uid links back to the Odoo res.users record
--   • role: 'admin' (full access) | 'customer' (recipe book +
--     quantity calc only)
--   • can_view_prices: NULL → follow role default
--     (admin → true, customer → false); TRUE / FALSE → override
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id               SERIAL PRIMARY KEY,
    odoo_uid         INTEGER       UNIQUE,                    -- Odoo res.users.id; NULL if local-only
    username         VARCHAR(100)  NOT NULL UNIQUE,
    email            VARCHAR(255),
    name             VARCHAR(255),
    role             VARCHAR(20)   NOT NULL DEFAULT 'customer'
                       CHECK (role IN ('admin', 'customer', 'manager')),
    can_view_prices  BOOLEAN,                                 -- NULL = follow role default
    is_active        BOOLEAN       NOT NULL DEFAULT TRUE,
    last_login       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ   DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

-- Local password hash (scrypt) for admin-created accounts that don't
-- authenticate via Odoo.  NULL for Odoo / dev-admin users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_users_odoo_uid  ON users(odoo_uid);
CREATE INDEX IF NOT EXISTS idx_users_username  ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);

-- Widen the role CHECK on already-existing databases to add 'manager'
-- (a privileged role: superset of admin + the exclusive right to promote
-- test recipes into the real lists).  Idempotent.
DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD  CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'customer', 'manager'));
END $$;

-- ------------------------------------------------------------
-- Test Recipes (kitchen sandbox)
--   Recipes still in development.  Stored SEPARATELY from the real
--   items/boms pipeline as a JSONB draft so they never leak into the
--   real Base/Final lists and can't be used as ingredients elsewhere.
--   A draft may contain "ad-hoc" ingredients (a name/code for a product
--   that doesn't exist yet) — those show red and block promotion until
--   resolved.  A manager promotes a finished draft into the real lists.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS test_recipes (
    id             SERIAL PRIMARY KEY,
    name           TEXT          NOT NULL,
    reference_code TEXT,
    recipe_type    VARCHAR(20)   NOT NULL DEFAULT 'base'
                     CHECK (recipe_type IN ('base', 'final')),
    -- 'draft'   → editable in the Test Recipes list
    -- 'pending' → submitted for the main manager's approval
    status         VARCHAR(20)   NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'pending')),
    review_note    TEXT,
    draft          JSONB         NOT NULL DEFAULT '{}'::jsonb,
    created_by     INTEGER       REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ   DEFAULT NOW(),
    updated_at     TIMESTAMPTZ   DEFAULT NOW()
);

-- Add status to existing test_recipes tables (idempotent).
ALTER TABLE test_recipes ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'draft';
-- Manager's feedback when sending a recipe back for re-editing.
ALTER TABLE test_recipes ADD COLUMN IF NOT EXISTS review_note TEXT;
DO $$ BEGIN
  ALTER TABLE test_recipes DROP CONSTRAINT IF EXISTS test_recipes_status_check;
  ALTER TABLE test_recipes ADD  CONSTRAINT test_recipes_status_check
    CHECK (status IN ('draft', 'pending'));
END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- STEP 1.2 — AUDIT_LOGS (gap-coverage log only)
--   action_type examples:
--     'login_success', 'login_failure',
--     'user_create', 'user_update', 'user_deactivate',
--     'pricing_formula_create', 'pricing_formula_update',
--     'pricing_formula_delete',
--     'odoo_sync_trigger', 'odoo_sync_complete',
--     'quantity_calculation'
--   entity / entity_id point at the affected row when applicable
--   (e.g. entity='pricing_formula', entity_id=42).
--   value_before / value_after hold a JSON snapshot of the
--   changed columns for diffable changes; NULL for events.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER      REFERENCES users(id) ON DELETE SET NULL,  -- NULL for system/anon actions
    action_type  VARCHAR(50)  NOT NULL,
    entity       VARCHAR(50),
    entity_id    INTEGER,
    description  TEXT,
    value_before JSONB,
    value_after  JSONB,
    ip_address   INET,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id     ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity      ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at  ON audit_logs(created_at DESC);

-- ------------------------------------------------------------
-- STEP 1.3 — RECIPE BRANDING & PRESENTATION FIELDS (on boms)
--   Recipes already share the items/boms unification; we extend
--   `boms` so the recursive costing and snapshot pipeline stay
--   untouched.  Image lives on `items.image_url` (already exists)
--   so recipe rows reuse the same column raw materials use.
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS full_name           VARCHAR(255);
ALTER TABLE boms ADD COLUMN IF NOT EXISTS description         TEXT;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS allergens           TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE boms ADD COLUMN IF NOT EXISTS is_spicy            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS serving_suggestion  TEXT;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS servings_count      INTEGER
  CHECK (servings_count IS NULL OR servings_count > 0);
-- total_weight = finished/packed weight (may differ from yield_kg
-- once shrinkage / packaging is accounted for).  yield_kg stays
-- as the costing denominator; total_weight is the consumer-facing
-- net weight on the recipe card.
ALTER TABLE boms ADD COLUMN IF NOT EXISTS total_weight        NUMERIC(12, 4)
  CHECK (total_weight IS NULL OR total_weight > 0);

-- ------------------------------------------------------------
-- STEP 1.4 — STORED PRICE SNAPSHOTS on boms
--   Pricing currently derives at query time from pricing_formulas.
--   The plan calls for stored wholesale/retail prices so a
--   recipe card shows a stable price even if multipliers change
--   afterwards.  These are SNAPSHOTS — written on BOM save,
--   not authoritative; the formula chain remains the source of
--   truth for re-computation.
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS wholesale_price     NUMERIC(14, 6);
ALTER TABLE boms ADD COLUMN IF NOT EXISTS retail_price        NUMERIC(14, 6);

-- ------------------------------------------------------------
-- STEP 1.5 — Pinned pricing formula on boms
--   Optional explicit override: if set, the recipe uses THIS
--   formula directly instead of walking item→category→global.
--   ON DELETE SET NULL so deleting a formula falls back to the
--   normal resolution chain rather than orphaning the recipe.
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS pricing_formula_id  INTEGER
  REFERENCES pricing_formulas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_boms_pricing_formula_id ON boms(pricing_formula_id);

-- ------------------------------------------------------------
-- STEP 1.6 — created_by / updated_by on boms
--   Both nullable + ON DELETE SET NULL so a removed user does
--   not cascade-delete recipes.  Populated by routes/boms.js in
--   a follow-up step (req.user.id once the auth middleware
--   resolves the local users row).
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS created_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE boms ADD COLUMN IF NOT EXISTS updated_by INTEGER
  REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_boms_created_by ON boms(created_by);
CREATE INDEX IF NOT EXISTS idx_boms_updated_by ON boms(updated_by);

-- ------------------------------------------------------------
-- STEP 1.7 — Restore packaging_cost on boms
--   It existed before, was dropped from the migration list but
--   the column itself remained in any DB that had run the
--   earlier migration.  The costing service still references it,
--   so we re-declare it idempotently — a no-op where it exists,
--   a recovery where it was somehow lost.
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS packaging_cost NUMERIC(14, 6) NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- Recipe archive — distinct from soft-delete (is_active=FALSE).
-- Archived recipes stay in the DB and remain restorable; they are
-- hidden from the main Kitchen Recipes list (the list filters
-- archived = FALSE) but can be surfaced via an "archived" view.
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- ------------------------------------------------------------
-- Sale unit of measure for FINAL products: 'kg' (default) or
-- 'unit'.  When 'unit' the whole recipe yield is one sellable
-- unit, so prices/costs are shown per unit (= the per-yield total)
-- instead of per kg.
-- ------------------------------------------------------------
ALTER TABLE boms ADD COLUMN IF NOT EXISTS sale_uom VARCHAR(8) NOT NULL DEFAULT 'kg'
  CHECK (sale_uom IN ('kg', 'unit'));

-- ------------------------------------------------------------
-- Per-role sidebar tab visibility.  The manager configures which
-- menu tabs each role (customer/admin/manager) may see.  `tabs` is
-- an array of canonical tab keys (dashboard, book, kitchen, test,
-- pending, whereused, products, settings, logs).  Seeded once with
-- the historical defaults; ON CONFLICT DO NOTHING so re-running the
-- migration never clobbers a manager's customisation.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_tab_permissions (
  role       VARCHAR(20) PRIMARY KEY CHECK (role IN ('customer', 'admin', 'manager')),
  tabs       TEXT[] NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO role_tab_permissions (role, tabs) VALUES
  ('customer', '{book}'),
  ('admin',    '{book,test,products}'),
  ('manager',  '{dashboard,book,kitchen,test,pending,whereused,products,settings,logs}')
ON CONFLICT (role) DO NOTHING;

-- ------------------------------------------------------------
-- STEP 1.8 — bom_lines extensions
--   • ingredient_type: explicit mirror of items.item_type so the
--     line row is self-describing without a JOIN.  Values match
--     items.item_type exactly ('raw_material' = the plan's
--     "product"; 'recipe' = a nested sub-assembly).
--   • price_per_kg_snapshot: frozen cost-per-kg at save time.
--   • line_cost: persisted line total (qty/(1-waste) * snapshot).
--     These two are populated by the BOM save path in a
--     follow-up step; for now they remain NULL on legacy rows.
-- ------------------------------------------------------------
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS ingredient_type        VARCHAR(20);
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS price_per_kg_snapshot  NUMERIC(14, 6);
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS line_cost              NUMERIC(14, 6);

-- ------------------------------------------------------------
-- Preparation steps (Kitchen Recipes builder)
--   A recipe's ingredients can be grouped into numbered prep steps,
--   each with a name and a free-text process explanation.  Steps are
--   an ADDITIVE metadata layer: bom_lines stay flat (costing / recipe
--   book / calculator are untouched); bom_lines.step_number links a
--   line to its step.  Recipes saved before this feature have
--   step_number NULL and load as a single default step.
-- ------------------------------------------------------------
ALTER TABLE bom_lines ADD COLUMN IF NOT EXISTS step_number INT;

CREATE TABLE IF NOT EXISTS bom_steps (
  id          SERIAL PRIMARY KEY,
  bom_id      INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  step_number INT     NOT NULL,
  step_name   TEXT,
  description TEXT,
  UNIQUE (bom_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_bom_steps_bom_id ON bom_steps(bom_id);

-- Back-fill ingredient_type on existing rows from items.item_type
UPDATE bom_lines bl
SET    ingredient_type = i.item_type
FROM   items i
WHERE  i.id = bl.ingredient_item_id
  AND  bl.ingredient_type IS NULL;

-- Constrain ingredient_type once the back-fill has run
DO $$ BEGIN
  ALTER TABLE bom_lines
    ADD CONSTRAINT chk_bom_lines_ingredient_type
    CHECK (ingredient_type IS NULL OR ingredient_type IN ('raw_material', 'recipe'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_bom_lines_ingredient_type ON bom_lines(ingredient_type);

-- ------------------------------------------------------------
-- STEP 1.9 — pricing_formulas: name, priority, widened scope
--   • name: human label shown in FormulaManager
--   • priority: tiebreaker when multiple formulas resolve to the
--     same scope+ref (higher wins).  Default 0 = legacy behavior.
--   • scope CHECK widened to accept 'product' and 'recipe' as
--     plan-language aliases for 'item'.  Existing 'item' rows
--     are untouched and remain valid.  The resolver code (in a
--     follow-up step) treats {item, product, recipe} as one
--     bucket so old rows keep matching.
-- ------------------------------------------------------------
ALTER TABLE pricing_formulas ADD COLUMN IF NOT EXISTS name     VARCHAR(100);
ALTER TABLE pricing_formulas ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pricing_formulas_priority ON pricing_formulas(priority DESC);

-- Widen the scope CHECK constraint: drop the inline original (auto-
-- named pricing_formulas_scope_check) and re-add a superset.  No
-- existing rows can violate the superset, so this is data-safe.
DO $$ BEGIN
  ALTER TABLE pricing_formulas DROP CONSTRAINT pricing_formulas_scope_check;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pricing_formulas
    ADD CONSTRAINT pricing_formulas_scope_check
    CHECK (scope IN ('global', 'category', 'item', 'product', 'recipe'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Widen chk_scope_ref the same way so the new aliases also
-- require a non-NULL scope_ref_id.
DO $$ BEGIN
  ALTER TABLE pricing_formulas DROP CONSTRAINT chk_scope_ref;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE pricing_formulas
    ADD CONSTRAINT chk_scope_ref CHECK (
      (scope = 'global' AND scope_ref_id IS NULL) OR
      (scope IN ('category', 'item', 'product', 'recipe') AND scope_ref_id IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================
-- End of STEP 1 — Recipe Book Extensions
-- =============================================================

-- ------------------------------------------------------------
-- STEP 1.10 — (deprecated)
--   This previously created a partial unique index forcing
--   at most one ACTIVE global pricing formula per price_tier.
--   STEP 2 below replaces that rule with the is_default flag
--   (many active formulas, exactly one default), so the index
--   is no longer created here.  STEP 2 also drops the index
--   defensively in case an older DB still has it.
-- ------------------------------------------------------------

-- =============================================================
-- STEP 2 — Simplified pricing model: default formula + manual pin
--   Replaces the old scope/category/product hierarchy with a flat
--   list of formulas, exactly one of which is the default.
--   • formula_uid groups the wholesale + retail tier rows that
--     together make up ONE formula (the per-tier table layout is
--     kept so existing boms.pricing_formula_id pins survive).
--   • is_default marks the chosen default; exactly one formula
--     carries it among active rows.
--   • scope / scope_ref_id / priority remain in the DB for safety
--     but are NO LONGER consulted by the resolver — every new
--     formula goes in as scope='global' / scope_ref_id=NULL.
-- =============================================================

CREATE SEQUENCE IF NOT EXISTS pricing_formulas_uid_seq;

ALTER TABLE pricing_formulas ADD COLUMN IF NOT EXISTS formula_uid INTEGER;
ALTER TABLE pricing_formulas ADD COLUMN IF NOT EXISTS is_default  BOOLEAN NOT NULL DEFAULT FALSE;

-- Free-form pricing formula expression per tier (e.g. "cost * 1.5 * 1.07").
-- When set it is the human-editable source of truth; the numeric
-- `multiplier` is kept in sync (= the formula's value at cost=1) so the
-- existing multiplier-based pricing engine keeps working unchanged.
ALTER TABLE pricing_formulas ADD COLUMN IF NOT EXISTS formula_expr TEXT;

-- Backfill formula_uid for existing rows: each distinct
-- (scope, scope_ref_id, name) group gets a uid = MIN(id) within
-- the group.  Deterministic and idempotent.
UPDATE pricing_formulas pf
SET    formula_uid = sub.uid
FROM (
  SELECT id,
         MIN(id) OVER (PARTITION BY scope, scope_ref_id, COALESCE(name, '')) AS uid
  FROM   pricing_formulas
) sub
WHERE  pf.id = sub.id
  AND  pf.formula_uid IS NULL;

-- Advance the sequence past any backfilled uids so future
-- nextval() calls do not collide.
SELECT setval(
  'pricing_formulas_uid_seq',
  GREATEST((SELECT COALESCE(MAX(formula_uid), 0) FROM pricing_formulas), 1),
  true
);

CREATE INDEX IF NOT EXISTS idx_pricing_formulas_formula_uid ON pricing_formulas(formula_uid);

-- Drop the old "one active global formula" rule — the new model
-- supports many active formulas distinguished by formula_uid.
DROP INDEX IF EXISTS uq_pricing_formulas_global_active;

-- Seed the initial default: pick the currently-active "Kitchen"
-- global formula if present; otherwise the most-recently-updated
-- active formula.  Idempotent: only fires when no default exists.
DO $$
DECLARE
  v_uid INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pricing_formulas WHERE is_default = TRUE AND is_active = TRUE
  ) THEN
    -- Prefer the active Kitchen formula
    SELECT formula_uid INTO v_uid
    FROM   pricing_formulas
    WHERE  is_active = TRUE
      AND  name = 'Kitchen'
    LIMIT  1;

    -- Fallback: any active formula (newest first)
    IF v_uid IS NULL THEN
      SELECT formula_uid INTO v_uid
      FROM   pricing_formulas
      WHERE  is_active = TRUE
        AND  formula_uid IS NOT NULL
      ORDER  BY updated_at DESC NULLS LAST, id DESC
      LIMIT  1;
    END IF;

    IF v_uid IS NOT NULL THEN
      UPDATE pricing_formulas
      SET    is_default = TRUE
      WHERE  formula_uid = v_uid
        AND  is_active   = TRUE;
    END IF;
  END IF;
END $$;

-- Enforce: at most ONE default formula among active rows.
-- Per-tier so the wholesale + retail rows of the default formula
-- can both carry the flag.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_formulas_default_active
  ON pricing_formulas (price_tier)
  WHERE is_default = TRUE AND is_active = TRUE;
