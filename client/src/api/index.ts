import type { SearchResult, PricingFormula, BomDetail, BomSummary, Category, BomSnapshot, AffectedRecipesResult, RecipeType, CalcResult, UserRow, AuditLogPage, SyncStatus, DashboardSummary, ProductRow, ProductOverride, RecipeImportReport, RecipeExportFilters, TestRecipeSummary, TestRecipeDetail, TestRecipeDraft, ReferenceCodeCategory, MeProfile, ItemDetail } from '../types';

const BASE = import.meta.env.VITE_API_URL ?? '/api';

/** Returns the stored JWT (if any) as an Authorization header object. */
function authHeader(): Record<string, string> {
  const token = localStorage.getItem('bom_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Centralised 401 handling: when the JWT has expired the server
 * returns 401 — wipe the stored token + user and bounce to /login
 * so the user lands on the sign-in screen instead of staring at a
 * confusing toast.  Re-entry guard prevents a redirect loop if
 * multiple in-flight requests all 401 at once.
 */
let redirectingTo401 = false;
function handleUnauthorized(): never {
  localStorage.removeItem('bom_token');
  localStorage.removeItem('bom_user');
  if (!redirectingTo401 && typeof window !== 'undefined') {
    redirectingTo401 = true;
    const next = window.location.pathname + window.location.search;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }
  throw new Error('Session expired. Please log in again.');
}

async function request<T>(
  path: string,
  init: RequestInit & { jsonBody?: unknown } = {},
): Promise<T> {
  const { jsonBody, headers, ...rest } = init;
  const mergedHeaders: Record<string, string> = {
    ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...authHeader(),
    ...(headers as Record<string, string> | undefined ?? {}),
  };

  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: mergedHeaders,
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : rest.body,
  });

  if (res.status === 401) handleUnauthorized();
  if (!res.ok) throw new Error(await res.text());

  // 204 No Content / empty bodies should not blow up callers
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function get<T>(path: string)                    { return request<T>(path); }
function post<T>(path: string, body: unknown)    { return request<T>(path, { method: 'POST',   jsonBody: body }); }
function put<T>(path: string, body: unknown)     { return request<T>(path, { method: 'PUT',    jsonBody: body }); }
function patch<T>(path: string, body: unknown)   { return request<T>(path, { method: 'PATCH',  jsonBody: body }); }
function del<T>(path: string)                    { return request<T>(path, { method: 'DELETE' }); }

export const api = {
  /**
   * Liveness + DB connectivity probe. Full round trip:
   * browser → Express (/api/health) → Neon (SELECT 1, NOW()) → back.
   * Returns the DB's server time so you can confirm the connection.
   */
  health: () =>
    get<{ status: string; database: string; serverTime: string }>(`/health`),

  searchItems: (q: string) =>
    get<SearchResult[]>(`/items/search?q=${encodeURIComponent(q)}`),

  getItem: (id: number) =>
    get<ItemDetail>(`/items/${id}`),

  getBom: (itemId: number) =>
    get<BomDetail>(`/boms/${itemId}`),

  getBoms: (type?: RecipeType, opts?: { archived?: boolean }) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (opts?.archived) params.set('archived', 'true');
    const qs = params.toString();
    return get<BomSummary[]>(qs ? `/boms?${qs}` : '/boms');
  },

  /**
   * Live-resolved pricing for an item (walks manual → default →
   * hardcoded).  Returned shape mirrors pricingService.resolvePricingForItem.
   */
  getPricing: (itemId: number) =>
    get<{
      item_id: number;
      cost_per_kg: number | null;
      formula: {
        id: number | null;
        formula_uid: number | null;
        name: string | null;
        is_default: boolean;
      };
      selection: 'manual' | 'auto';
      wholesale_multiplier: number;
      retail_multiplier: number;
      wholesale_price: number | null;
      retail_price: number | null;
    }>(`/items/${itemId}/pricing`),

  resolvePricing: (referenceCode: string) =>
    get<{ wholesale_multiplier: number; retail_multiplier: number; wholesale_formula?: string | null; retail_formula?: string | null }>(
      `/pricing/resolve?reference_code=${encodeURIComponent(referenceCode)}`
    ),

  // ── Role tab permissions ──────────────────────────────────
  getRolePermissions: () =>
    get<Record<string, string[]>>('/role-permissions'),

  updateRolePermissions: (role: string, tabs: string[]) =>
    put<{ role: string; tabs: string[] }>('/role-permissions', { role, tabs }),

  getFormulas: () =>
    get<PricingFormula[]>('/pricing'),

  createFormula: (formula: { name: string; wholesale_formula: string; retail_formula: string }) =>
    post<PricingFormula>('/pricing', formula),

  updateFormula: (id: number, formula: { name: string; wholesale_formula: string; retail_formula: string }) =>
    put<PricingFormula>(`/pricing/${id}`, formula),

  setDefaultFormula: (id: number) =>
    post<PricingFormula>(`/pricing/${id}/default`, {}),

  saveRecipe: (payload: {
    /**
     * When editing an existing recipe, the client passes the item_id
     * it loaded.  The server uses this as the source of truth for
     * which row to update — and renames items.name to the new value
     * — so renaming a recipe edits it in place instead of creating
     * a duplicate (the old name-based find-or-create only worked
     * when the name was unchanged).  Omit on /recipe/new.
     */
    item_id?: number | null;
    name: string;
    reference_code: string;
    yield_kg: number;
    labor_cost: number;
    overhead_cost: number;
    packaging_cost?: number;
    recipe_type: RecipeType;
    // STEP 6: optional recipe-book / branding fields
    full_name?: string | null;
    description?: string | null;
    image_url?: string | null;
    allergens?: string[];
    is_spicy?: boolean;
    serving_suggestion?: string | null;
    servings_count?: number | null;
    total_weight?: number | null;
    pricing_formula_id?: number | null;
    sale_uom?: 'kg' | 'unit';
    lines: {
      ingredient_item_id: number;
      quantity_kg: number;
      line_uom: string;
      waste_pct: number;
      step_number?: number | null;
    }[];
    // Kitchen Recipes: preparation step metadata (name + process text).
    steps?: {
      step_number: number;
      step_name: string | null;
      description: string | null;
    }[];
  }) => post<{ bom_id: number; item_id: number; message: string }>('/boms', payload),

  deleteBom: (id: number) =>
    del<{ message: string }>(`/boms/${id}`),

  /** Bulk permanently delete recipes by their item ids.
   *  `blocked` lists ids that couldn't be deleted (still used as a sub-recipe). */
  bulkDeleteBoms: (itemIds: number[]) =>
    post<{ message: string; count: number; blocked: number[] }>('/boms/bulk-delete', { itemIds }),

  /** Bulk archive (or unarchive) recipes by their item ids. */
  bulkArchiveBoms: (itemIds: number[], archived = true) =>
    post<{ message: string; count: number }>('/boms/bulk-archive', { itemIds, archived }),

  // ─── Test recipes (sandbox) ──────────────────────────────────────
  getTestRecipes: (status?: 'draft' | 'pending') =>
    get<TestRecipeSummary[]>(`/test-recipes${status ? `?status=${status}` : ''}`),

  /** Submit a draft test recipe for the manager's approval. */
  submitTestRecipe: (id: number) =>
    post<{ id: number; message: string }>(`/test-recipes/${id}/submit`, {}),

  /** Manager-only: send a pending recipe back to the author for re-editing. */
  sendBackTestRecipe: (id: number, note: string) =>
    post<{ id: number; message: string }>(`/test-recipes/${id}/send-back`, { note }),

  // ─── Reference-code categories ───────────────────────────────────
  getReferenceCategories: () =>
    get<ReferenceCodeCategory[]>('/reference-codes'),

  getNextReferenceCode: (prefix: string) =>
    get<{ prefix: string; n: number; code: string }>(`/reference-codes/next?prefix=${encodeURIComponent(prefix)}`),

  createReferenceCategory: (body: { prefix: string; description?: string }) =>
    post<ReferenceCodeCategory>('/reference-codes', body),

  deleteReferenceCategory: (id: number) =>
    del<{ message: string }>(`/reference-codes/${id}`),

  getTestRecipe: (id: number) =>
    get<TestRecipeDetail>(`/test-recipes/${id}`),

  saveTestRecipe: (payload: {
    id?: number | null;
    name: string;
    reference_code: string | null;
    recipe_type: RecipeType;
    draft: TestRecipeDraft;
  }) => post<{ id: number; message: string }>('/test-recipes', payload),

  deleteTestRecipe: (id: number) =>
    del<{ message: string }>(`/test-recipes/${id}`),

  /** Manager-only: promote many pending recipes at once. */
  bulkPromoteTestRecipes: (ids: number[]) =>
    post<{ promoted: number; blocked: { id: number; name: string; reason: string }[] }>('/test-recipes/bulk-promote', { ids }),

  bulkDeleteTestRecipes: (ids: number[]) =>
    post<{ count: number }>('/test-recipes/bulk-delete', { ids }),

  /** Export selected pending recipes to Excel (Blob). */
  exportTestRecipes: async (ids: number[]): Promise<Blob> => {
    const res = await fetch(`${BASE}/test-recipes/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ ids }),
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) throw new Error(await res.text());
    return res.blob();
  },

  /** Manager-only: push a finished test recipe into the real lists. */
  promoteTestRecipe: (id: number) =>
    post<{ item_id: number; recipe_type: RecipeType; message: string }>(
      `/test-recipes/${id}/promote`, {},
    ),

  deleteFormula: (id: number) =>
    del<{ message: string }>(`/pricing/${id}`),

  getCategories: () =>
    get<Category[]>('/categories'),

  getBomSnapshots: (itemId: number) =>
    get<BomSnapshot[]>(`/boms/${itemId}/snapshots`),

  getAffectedRecipes: (itemId: number) =>
    get<AffectedRecipesResult>(`/items/${itemId}/affected-recipes`),

  /**
   * Customer-accessible: scale a recipe to a desired output weight.
   * Returns the full ingredient tree, per-line scaled quantities,
   * and an aggregated raw-material shopping list.  Price fields are
   * stripped server-side for users without view-price permission.
   */
  calculateRecipe: (itemId: number, desiredWeightKg: number) =>
    post<CalcResult>(`/boms/${itemId}/calculate`, { desired_weight_kg: desiredWeightKg }),

  // ─── Admin: Dashboard / Users / Audit / Sync ──────────────────────

  getDashboardSummary: () =>
    get<DashboardSummary>('/boms/summary'),

  getSyncStatus: () =>
    get<SyncStatus>('/sync/status'),

  triggerOdooSync: () =>
    post<{ synced: number; catsSynced: number; costHistoryInserted: number; errors: number }>('/sync/odoo', {}),

  triggerCostRecalc: () =>
    post<{ recalculated: number; failed: unknown[] }>('/sync/costs', {}),

  // ── Self-service profile (any authenticated user) ─────────
  getMe: () => get<MeProfile>('/users/me'),
  updateMe: (body: { name?: string; username?: string; avatar_url?: string | null; password?: string }) =>
    patch<MeProfile>('/users/me', body),

  getUsers: (params?: { role?: string; active?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.role) qs.set('role', params.role);
    if (params?.active != null) qs.set('active', String(params.active));
    const q = qs.toString();
    return get<UserRow[]>(`/users${q ? `?${q}` : ''}`);
  },

  updateUser: (id: number, patchBody: {
    role?: 'admin' | 'customer' | 'manager';
    can_view_prices?: boolean | null;
    is_active?: boolean;
  }) => patch<UserRow>(`/users/${id}`, patchBody),

  /** Create a local user that logs in with username + password. */
  createUser: (body: {
    username: string;
    password: string;
    name?: string;
    role?: 'admin' | 'customer' | 'manager';
    can_view_prices?: boolean | null;
  }) => post<UserRow>('/users', body),

  getAuditLogs: (params: {
    user_id?: number;
    action_type?: string;
    entity?: string;
    from?: string;   // ISO
    to?: string;     // ISO
    limit?: number;
    offset?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.user_id != null)   qs.set('user_id',     String(params.user_id));
    if (params.action_type)       qs.set('action_type', params.action_type);
    if (params.entity)            qs.set('entity',      params.entity);
    if (params.from)              qs.set('from',        params.from);
    if (params.to)                qs.set('to',          params.to);
    if (params.limit != null)     qs.set('limit',       String(params.limit));
    if (params.offset != null)    qs.set('offset',      String(params.offset));
    const q = qs.toString();
    return get<AuditLogPage>(`/audit-logs${q ? `?${q}` : ''}`);
  },

  getAuditActionTypes: () =>
    get<string[]>('/audit-logs/action-types'),

  // ─── Admin: Products (raw Odoo catalogue) ────────────────────────
  getProducts: (includeArchived = false) =>
    get<ProductRow[]>(`/products${includeArchived ? '?includeArchived=true' : ''}`),

  /** Manually override cost price / weight (kg) / cost-per-kg for a product. */
  updateProduct: (id: number, body: ProductOverride) =>
    patch<ProductRow>(`/products/${id}`, body),

  // ─── Admin: Recipe Import / Export ──────────────────────────────
  /**
   * Fetch the downloadable .xlsx template (with one worked example).
   * Returns a Blob the caller saves via triggerBlobDownload().
   */
  downloadRecipeTemplate: async (): Promise<Blob> => {
    const res = await fetch(`${BASE}/recipe-io/template`, { headers: authHeader() });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) throw new Error(await res.text());
    return res.blob();
  },

  /**
   * Export recipes matching the supplied filters / explicit id list to
   * an .xlsx workbook.  Server-side renders headers, freezes the header
   * row, and visually merges multi-ingredient recipes.
   */
  exportRecipes: async (filters: RecipeExportFilters): Promise<Blob> => {
    const res = await fetch(`${BASE}/recipe-io/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(filters),
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) throw new Error(await res.text());
    return res.blob();
  },

  /**
   * Upload a filled .xlsx and create / update the recipes it
   * describes.  Returns a per-recipe report keyed by row number.
   */
  importRecipes: async (
    file: File,
    options: { onDuplicate: 'update' | 'skip'; defaultType: RecipeType },
  ): Promise<RecipeImportReport> => {
    const fd = new FormData();
    fd.append('file',         file);
    fd.append('onDuplicate',  options.onDuplicate);
    fd.append('defaultType',  options.defaultType);

    const res = await fetch(`${BASE}/recipe-io/import`, {
      method: 'POST',
      headers: authHeader(), // do NOT set Content-Type — fetch sets the multipart boundary
      body:    fd,
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) {
      // Server returns { error: '…' } for parse / structural failures.
      // The reference-code collision guard returns 409 { error:'codes_exist',
      // message, conflicts:[…] } — surface those so the modal can list them.
      const text = await res.text();
      let parsed: { error?: string; message?: string; conflicts?: string[] } | null = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      if (parsed?.error === 'codes_exist') {
        const err = new Error(parsed.message || 'codes_exist') as Error & { code?: string; conflicts?: string[] };
        err.code = 'codes_exist';
        err.conflicts = parsed.conflicts || [];
        throw err;
      }
      throw new Error(parsed?.error || text);
    }
    return res.json();
  },
};

/**
 * Browser-side helper: save a Blob to disk under the given name.  The
 * import/export endpoints return Blob responses (they need the JWT
 * header so a plain <a href> download is not an option).
 */
export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so Safari finishes the download
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
