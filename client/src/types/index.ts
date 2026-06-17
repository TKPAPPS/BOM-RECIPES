export type ItemType = 'raw_material' | 'material' | 'recipe';
export type RecipeType = 'base' | 'final';

export interface SearchResult {
  id: number;
  name: string;        // canonical (en) name
  name_en: string | null;
  name_he: string | null;
  reference: string | null;  // Odoo default_code / SKU
  type: ItemType;
  cost_per_kg: number;
  unit: string;              // native Odoo UOM (e.g. 'kg', 'g', 'L', 'each')
  volume_weight: number | null; // package weight in kg (for 'each' conversion)
  image_url: string | null;
}

/** A preparation step in the Kitchen Recipes builder (draft, client-side). */
export interface RecipeStepDraft {
  id: string;
  name: string;
  description: string;
}

/** One ingredient line inside a stored test-recipe draft (JSONB). */
export interface TestDraftLine {
  step_number: number | null;
  item_id: number | null;
  name: string | null;
  reference: string | null;
  cost_per_kg: number | null;
  unit: string | null;
  line_uom: string;
  quantity_kg: number;
  quantity_input: number;
  waste_pct: number;
  is_adhoc: boolean;
  /** Added by the server on GET: does this resolve to a real item? */
  resolved_item_id?: number | null;
  resolved_item?: {
    id: number;
    name: string;
    reference: string | null;
    cost_per_kg: number | null;
    uom: string | null;
    image_url: string | null;
    item_type: ItemType;
  } | null;
  is_red?: boolean;
}

export interface TestRecipeDraft {
  yieldKg: number;
  recipeType: RecipeType;
  full_name?: string | null;
  description?: string | null;
  image_url?: string | null;
  allergens?: string[];
  is_spicy?: boolean;
  serving_suggestion?: string | null;
  servings_count?: number | null;
  total_weight?: number | null;
  pricing_formula_id?: number | null;
  labor_cost?: number;
  overhead_cost?: number;
  packaging_cost?: number;
  steps: { step_number: number; name: string; description: string }[];
  lines: TestDraftLine[];
}

export type TestRecipeStatus = 'draft' | 'pending';

export interface TestRecipeSummary {
  id: number;
  name: string;
  reference_code: string | null;
  recipe_type: RecipeType;
  status: TestRecipeStatus;
  review_note: string | null;
  updated_at: string;
  created_by_name: string | null;
  line_count: number;
  red_count: number;
}

export interface TestRecipeDetail {
  id: number;
  name: string;
  reference_code: string | null;
  recipe_type: RecipeType;
  status: TestRecipeStatus;
  review_note: string | null;
  red_count: number;
  draft: TestRecipeDraft;
}

export interface IngredientLine {
  lineId: string;
  /** Legacy: previously grouped lines into steps. Ingredients are now a
   *  flat list; kept optional for backward compatibility. */
  stepId?: string;
  item: SearchResult | null;
  /** Ad-hoc ingredient (test recipes only): a product not in the
   *  catalogue yet. When set with item===null the line shows red. */
  adhocName?: string;
  adhocReference?: string;
  /** Server-resolved redness for an ad-hoc line (test recipe load). */
  isRed?: boolean;
  /** Quantity as entered by the user in line_uom */
  quantity_input: number;
  /** Canonical kg value = quantity_input × toKgFactor(line_uom, item.volume_weight) */
  quantity_kg: number;
  /** UOM the user is working in for this line */
  line_uom: string;
  /** Waste / shrinkage percentage (0–99.99) */
  waste_pct: number;
}

export interface CostTier {
  cost_per_kg: number;
  /** Σ(effective_qty × cost_per_kg) — material cost only */
  cost_for_yield: number;
  /** labor + overhead */
  production_cost: number;
  /** material_cost + production_cost */
  total_cost: number;
  wholesale_for_yield: number;
  retail_for_yield: number;
}

export interface PricingFormula {
  /** Tier-row id (the value boms.pricing_formula_id pins to). */
  id: number;
  /** Stable formula identity that groups the wholesale + retail rows. */
  formula_uid: number;
  name: string;
  wholesale_multiplier: number;
  retail_multiplier: number;
  /** Free-form expression (e.g. "cost * 1.5 * 1.07"); null on legacy rows. */
  wholesale_formula?: string | null;
  retail_formula?: string | null;
  is_default: boolean;
}

export interface Category {
  id: number;
  odoo_id: number | null;
  name: string;
}

export interface BomLine {
  line_id: number;
  ingredient_id: number;
  ingredient: string;
  name_en: string | null;
  name_he: string | null;
  reference: string | null;
  step_number: number | null;
  quantity_kg: number;
  line_uom: string;
  waste_pct: number;
  cost_per_kg: number;
  line_cost: number;
  image_url: string | null;
  unit: string;
  item_type: ItemType;
}

/** Persisted preparation-step metadata returned by GET /boms/:itemId. */
export interface BomStep {
  step_number: number;
  step_name: string | null;
  description: string | null;
}

export interface BomDetail {
  id: number;
  item_id: number;
  recipe_name: string;
  full_name?: string | null;
  description?: string | null;
  allergens?: string[] | null;
  is_spicy?: boolean;
  serving_suggestion?: string | null;
  servings_count?: number | null;
  total_weight?: number | null;
  reference_code: string | null;
  recipe_type: RecipeType;
  /** Final-product sale unit: 'kg' (default) or 'unit' (whole yield = 1 unit). */
  sale_uom?: 'kg' | 'unit';
  yield_kg: number;
  /** Cost fields may be absent (stripped) for customers without view-price permission. */
  cost_per_kg?: number | null;
  labor_cost?: number | null;
  overhead_cost?: number | null;
  packaging_cost?: number | null;
  wholesale_price?: number | null;
  retail_price?: number | null;
  pricing_formula_id?: number | null;
  image_url?: string | null;
  lines: BomLine[];
  steps?: BomStep[] | null;
}

export interface BomSummary {
  id: number;
  item_id: number;
  recipe_name: string;
  full_name?: string | null;
  reference_code: string | null;
  recipe_type: RecipeType;
  sale_uom?: 'kg' | 'unit';
  yield_kg: number;
  total_weight?: number | null;
  servings_count?: number | null;
  is_spicy?: boolean;
  allergens?: string[] | null;
  image_url?: string | null;
  pricing_formula_id?: number | null;
  /** Cost / price fields are stripped server-side for users without view-price permission. */
  cost_per_kg?: number | null;
  total_cost?: number | null;
  wholesale_price?: number | null;
  retail_price?: number | null;
  wholesale_for_yield?: number | null;
  retail_for_yield?: number | null;
  formula_name?: string | null;
  pricing_selection?: 'manual' | 'auto' | null;
  version: number;
  line_count: number;
  created_at: string;
  updated_at: string;
}

// ─── Quantity Calculator (POST /api/boms/:itemId/calculate) ───────────────────

export interface CalcIngredient {
  line_id: number;
  ingredient_id: number;
  ingredient_name: string;
  ingredient_type: 'raw_material' | 'recipe';
  step_number: number | null;
  reference: string | null;
  image_url: string | null;
  unit: string;
  base_quantity_kg: number;
  waste_pct: number;
  scaled_quantity_kg: number;
  /** Price fields may be absent (stripped) for users without permission. */
  cost_per_kg?: number | null;
  line_cost?: number | null;
  sub_recipe: CalcResult | null;
}

export interface CalcAggregatedRawMaterial {
  ingredient_id: number;
  ingredient_name: string;
  reference: string | null;
  image_url: string | null;
  unit: string;
  total_quantity_kg: number;
  cost_per_kg?: number | null;
  total_cost?: number | null;
}

export interface CalcResult {
  recipe_id: number;
  recipe_name: string;
  recipe_type: RecipeType;
  image_url: string | null;
  yield_kg: number;
  desired_weight_kg: number;
  scale_factor: number;
  ingredients: CalcIngredient[];
  material_cost_total?: number | null;
  labor_cost_total?: number | null;
  overhead_cost_total?: number | null;
  packaging_cost_total?: number | null;
  total_cost?: number | null;
  cost_per_kg?: number | null;
  pricing?: {
    item_id: number;
    cost_per_kg?: number | null;
    formula: {
      id: number | null;
      formula_uid: number | null;
      name: string | null;
      is_default: boolean;
    };
    selection: 'manual' | 'auto';
    wholesale_multiplier?: number | null;
    retail_multiplier?: number | null;
    wholesale_price?: number | null;
    retail_price?: number | null;
  } | null;
  wholesale_total?: number | null;
  retail_total?: number | null;
  aggregated_raw_materials?: CalcAggregatedRawMaterial[];
  steps?: BomStep[] | null;
}

export interface BomSnapshotIngredient {
  ingredient_id: number;
  ingredient: string;
  quantity_kg: number;
  line_uom: string;
  waste_pct: number;
  cost_per_kg: number;
  line_cost: number;
}

export interface BomSnapshot {
  id: number;
  version: number;
  yield_kg: number;
  cost_per_kg: number | null;
  total_cost: number | null;
  labor_cost: number;
  overhead_cost: number;
  packaging_cost: number;
  reference_code: string | null;
  created_at: string;
  snapshot: {
    yield_kg: number;
    cost_per_kg: number;
    total_cost: number;
    labor_cost: number;
    overhead_cost: number;
    packaging_cost: number;
    ingredients: BomSnapshotIngredient[];
  };
}

export interface AffectedRecipe {
  item_id: number;
  recipe_name: string;
  cost_per_kg: number | null;
  version: number;
  yield_kg: number;
  recipe_type?: RecipeType;
  reference_code: string | null;
  depth: number;
  direct_quantity_kg?: number | null;
  is_direct?: boolean;
  via_sub_recipe?: boolean;
}

export interface AffectedRecipesResult {
  item: { id: number; name: string; item_type: string };
  affected_count: number;
  recipes: AffectedRecipe[];
}

// ─── Admin: Users / Audit / Sync / Dashboard ──────────────────────────

export interface UserRow {
  id: number;
  odoo_uid: number | null;
  username: string;
  name: string | null;
  email: string | null;
  role: 'admin' | 'customer';
  can_view_prices: boolean | null;     // three-state: null=default
  is_active: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

/** Single item (read-only ingredient page). */
export interface ItemDetail {
  id: number;
  name: string;
  name_en: string | null;
  name_he: string | null;
  reference: string | null;
  reference_code: string | null;
  uom: string | null;
  item_type: ItemType;
  cost_per_kg?: number | null;   // stripped for users without price permission
  raw_cost?: number | null;
  volume_weight: number | null;
  weight_source: string | null;
  image_url: string | null;
  is_active: boolean;
  odoo_archived: boolean;
  last_synced_at: string | null;
  category_name: string | null;
}

/** The current user's own profile (GET/PATCH /users/me). */
export interface MeProfile {
  id: number;
  odoo_uid: number | null;
  username: string;
  name: string | null;
  email: string | null;
  role: string;
  can_view_prices: boolean | null;
  is_active: boolean;
  avatar_url: string | null;
}

export interface AuditLog {
  id: number;
  user_id: number | null;
  username: string | null;
  user_name: string | null;
  action_type: string;
  entity: string | null;
  entity_id: number | null;
  description: string | null;
  value_before: unknown;
  value_after: unknown;
  ip_address: string | null;
  created_at: string;
}

export interface AuditLogPage {
  total: number;
  rows: AuditLog[];
}

export interface SyncStatus {
  last_outcome: {
    action_type: 'odoo_sync_complete' | 'odoo_sync_failure';
    description: string | null;
    value_after: unknown;
    created_at: string;
    user_id: number | null;
  } | null;
  last_trigger: {
    description: string | null;
    created_at: string;
    user_id: number | null;
  } | null;
  active_products: number;
  cron_schedule: string;
}

/** Where the effective weight came from. */
export type WeightSource = 'manual' | 'odoo' | 'name_regex' | 'none';
/** Where the effective cost-per-kg came from. 'raw_cost' = no measure
 *  found, so the cost itself is used as the per-kg/per-unit price. */
export type CostPerKgSource = 'manual' | 'odoo' | 'name_regex' | 'raw_cost' | 'none';
/** Family of the parsed measure: weight (kg/g), volume (litre), count (unit). */
export type Measure = 'weight' | 'volume' | 'count' | null;

/** Fields an admin can override on the Products tab. Weight is in KG. */
export interface ProductOverride {
  manual_raw_cost?: number | null;
  manual_weight_kg?: number | null;
  manual_cost_per_kg?: number | null;
}

export interface ProductRow {
  id: number;
  odoo_id: number | null;
  name: string;
  name_en: string | null;
  name_he: string | null;
  reference: string | null;
  uom: string | null;
  /** Effective weight from Odoo (kg). null when Odoo had nothing. */
  volume_weight: number | null;
  /** Raw Odoo weight (kg) before any override — drives placeholders. */
  odoo_weight_kg: number | null;
  /** Real name-regex weight in grams (volume/count are NOT stored here). */
  weight_extracted_grams: number | null;
  /** Where the effective weight came from. */
  weight_source: WeightSource;
  /** Family of the parsed measure (weight/volume/count) or null. */
  measure: Measure;
  /** Effective weight in grams used as the cost divisor. */
  effective_weight_grams: number | null;
  /** Effective cost price (manual override → Odoo standard_price). */
  raw_cost: number | null;
  /** Raw Odoo cost before any override — drives placeholders. */
  odoo_raw_cost: number | null;
  /** Effective, live-resolved cost per kg / litre / unit. */
  cost_per_kg: number | null;
  /** Where the effective cost-per-kg came from. */
  cost_per_kg_source: CostPerKgSource;
  /** True when neither manual, Odoo nor regex resolved a weight/measure. */
  weight_missing: boolean;

  // Manual overrides (null when not set) — pre-fill the edit form.
  manual_raw_cost: number | null;
  manual_weight_grams: number | null;
  manual_cost_per_kg: number | null;
  cost_overridden: boolean;

  /** True when the product is archived in Odoo (hidden unless opted in). */
  odoo_archived: boolean;

  image_url: string | null;
  category_name: string | null;
  last_synced_at: string | null;
}

export interface ReferenceCodeCategory {
  id: number;
  prefix: string;
  description: string | null;
}

export interface DashboardSummary {
  recipes:  { base_count: number; final_count: number; total_recipes: number };
  products: { active_products: number; archived_products: number };
  test_recipes: { pending_count: number; draft_count: number; total: number };
  users:    { manager_count: number; admin_count: number; customer_count: number; inactive_count: number };
}

/* ── Recipe Excel Import / Export ─────────────────────────────────── */

export type RecipeImportRowStatus = 'created' | 'updated' | 'skipped' | 'failed';

export interface RecipeImportRowDetail {
  row:     number;
  name:    string;
  status:  RecipeImportRowStatus;
  message: string;
}

export interface RecipeImportReport {
  total:   number;
  created: number;
  updated: number;
  skipped: number;
  failed:  number;
  details: RecipeImportRowDetail[];
}

export interface RecipeExportFilters {
  /** Restrict to one recipe-type list when set. */
  type?:          RecipeType;
  /** Free-text needle matched against name / name_en / name_he / reference_code. */
  q?:             string;
  /** ISO datetime — lower bound on updated_at (inclusive). */
  from?:          string;
  /** ISO datetime — upper bound on updated_at (inclusive). */
  to?:            string;
  /** When non-empty, exports ONLY these item ids (server still applies type). */
  ids?:           number[];
  /** Include cost / price columns. Defaults to true server-side. */
  includePrices?: boolean;
}
