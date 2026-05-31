import React, { useMemo, useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';
import { BomDrillDownModal } from './components/BomDrillDown/BomDrillDownModal';
import { FormulaManager } from './components/FormulaManager/FormulaManager';
import { UserManagementPanel } from './components/Settings/UserManagementPanel';
import { OdooSyncPanel } from './components/Settings/OdooSyncPanel';
import { ToastContainer } from './components/Toast/Toast';
import { RecipeImportModal } from './components/RecipeIO/RecipeImportModal';
import { LanguageProvider, useLang } from './context/LanguageContext';
import { useAuth } from './context/AuthContext';
import { useRecipeStore } from './stores/useRecipeStore';
import { useToastStore } from './stores/useToastStore';
import { api, triggerBlobDownload } from './api';
import type { BomSummary, BomSnapshot, IngredientLine, RecipeType } from './types';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

/* ── Logo ──────────────────────────────────────────────────── */
const KosherPlaceLogo: React.FC = () => (
  <svg
    viewBox="0 0 260 90"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="The Kosher Place"
    direction="ltr"
    style={{ height: 42, width: 'auto', flexShrink: 0, direction: 'ltr' }}
  >
    <text
      x="8" y="22"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight="700" fontSize="18" fill="#CBAA6A" letterSpacing="3"
    >
      THE
    </text>
    <text
      x="4" y="72"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight="700" fontSize="52" fill="#FFFFFF" letterSpacing="-1"
    >
      KOSHER
    </text>
    <text
      x="175" y="88"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight="700" fontSize="18" fill="#CBAA6A" letterSpacing="3"
    >
      PLACE
    </text>
  </svg>
);

/* ── Language Toggle ───────────────────────────────────────── */
const LangToggle: React.FC = () => {
  const { lang, setLang } = useLang();
  return (
    <div className="lang-toggle" aria-label="Language selector">
      <button
        className={`lang-toggle__btn ${lang === 'en' ? 'lang-toggle__btn--active' : ''}`}
        onClick={() => setLang('en')}
        aria-pressed={lang === 'en'}
      >
        EN
      </button>
      <span className="lang-toggle__sep">|</span>
      <button
        className={`lang-toggle__btn ${lang === 'he' ? 'lang-toggle__btn--active' : ''}`}
        onClick={() => setLang('he')}
        aria-pressed={lang === 'he'}
        lang="he"
      >
        עב
      </button>
    </div>
  );
};

/* ── BOM Snapshot Panel ─────────────────────────────────────── */
const SnapshotPanel: React.FC<{ itemId: number; onClose: () => void }> = ({ itemId, onClose }) => {
  const { data: snapshots, isLoading } = useQuery({
    queryKey: ['bom-snapshots', itemId],
    queryFn: () => api.getBomSnapshots(itemId),
  });

  const fmt = (n: number | string | null | undefined) => {
    const num = typeof n === 'string' ? parseFloat(n) : n;
    return num != null && Number.isFinite(num) && num > 0
      ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)
      : '—';
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  return (
    <div className="snapshot-panel">
      <div className="snapshot-panel__header">
        <span className="snapshot-panel__title">Version History</span>
        <button className="snapshot-panel__close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {isLoading && <p className="snapshot-panel__loading">Loading…</p>}
      {!isLoading && (!snapshots || snapshots.length === 0) && (
        <p className="snapshot-panel__empty">No snapshots yet — save this recipe to create the first one.</p>
      )}
      {snapshots && snapshots.length > 0 && (
        <div className="snapshot-panel__versions">
          {(snapshots as BomSnapshot[]).map((s) => (
            <details key={s.id} className="snapshot-version">
              <summary className="snapshot-version__summary">
                <span className="snapshot-version__ver">v{s.version}</span>
                <span className="snapshot-version__cost">{fmt(s.cost_per_kg)} / kg</span>
                <span className="snapshot-version__total">Total: {fmt(s.total_cost)}</span>
                <span className="snapshot-version__yield">Yield: {s.yield_kg} kg</span>
                <span className="snapshot-version__date">{fmtDate(s.created_at)}</span>
              </summary>
              <table className="snapshot-version__table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th className="bom-history__num">Qty (kg)</th>
                    <th className="bom-history__num">Cost/kg</th>
                    <th className="bom-history__num">Line Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {s.snapshot.ingredients.map((ing, i) => (
                    <tr key={i}>
                      <td>{ing.ingredient}</td>
                      <td className="bom-history__num">{ing.quantity_kg}</td>
                      <td className="bom-history__num">{fmt(ing.cost_per_kg)}</td>
                      <td className="bom-history__num">{fmt(ing.line_cost)}</td>
                    </tr>
                  ))}
                </tbody>
                {(s.labor_cost > 0 || s.overhead_cost > 0 || s.packaging_cost > 0) && (
                  <tfoot>
                    {s.labor_cost > 0     && <tr><td colSpan={4}>Labor</td><td className="bom-history__num">{fmt(s.labor_cost)}</td></tr>}
                    {s.overhead_cost > 0  && <tr><td colSpan={4}>Overhead</td><td className="bom-history__num">{fmt(s.overhead_cost)}</td></tr>}
                    {s.packaging_cost > 0 && <tr><td colSpan={4}>Packaging</td><td className="bom-history__num">{fmt(s.packaging_cost)}</td></tr>}
                  </tfoot>
                )}
              </table>
            </details>
          ))}
        </div>
      )}
    </div>
  );
};

/* ── BOM History ───────────────────────────────────────────── */
export const BomHistory: React.FC<{ type: RecipeType }> = ({ type }) => {
  const qc = useQueryClient();
  const { t } = useLang();
  const navigate = useNavigate();
  const loadBom = useRecipeStore((s) => s.loadBom);
  const toast   = useToastStore((s) => s.push);
  const [editingId,      setEditingId]      = useState<number | null>(null);
  const [deletingId,     setDeletingId]     = useState<number | null>(null);
  const [snapshotItemId, setSnapshotItemId] = useState<number | null>(null);

  // ── Import / Export toolbar state ─────────────────────────────
  const [searchText, setSearchText] = useState('');
  const [fromDate,   setFromDate]   = useState('');
  const [toDate,     setToDate]     = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [exporting,  setExporting]  = useState(false);
  // Date filters + per-row selection checkboxes only appear once the
  // user opens the export panel — otherwise the list shows clean.
  const [exportMode, setExportMode] = useState(false);

  // When the route switches between /recipes/base and /recipes/final
  // selection / filters from the previous tab no longer apply.
  React.useEffect(() => {
    setSelectedIds(new Set());
    setSearchText('');
    setFromDate('');
    setToDate('');
    setExportMode(false);
  }, [type]);

  const { data: boms, isLoading, isError } = useQuery({
    queryKey: ['boms', type],
    queryFn: () => api.getBoms(type),
  });

  const pageTitle   = type === 'base'  ? t.baseRecipes  : t.finalProducts;
  const emptyText   = type === 'base'
    ? 'No base recipes saved yet. Create WIP sub-assemblies here.'
    : 'No final products saved yet. Create sellable packaged SKUs here.';

  // ── Client-side filtering (name/ref search + updated_at range) ─
  // Cheap because the recipe count per type is typically < a few
  // hundred; doing it server-side would round-trip on every keystroke.
  const filteredBoms = useMemo<BomSummary[]>(() => {
    const list = (boms ?? []) as BomSummary[];
    const needle = searchText.trim().toLowerCase();
    const fromMs = fromDate ? new Date(fromDate).getTime() : -Infinity;
    // End-of-day for the "to" date so a date-only value is inclusive
    const toMs = toDate ? new Date(toDate).getTime() + 86_399_000 : Infinity;
    return list.filter((b) => {
      if (needle) {
        const hay = `${b.recipe_name} ${b.reference_code ?? ''} ${b.full_name ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      const updated = new Date(b.updated_at).getTime();
      if (updated < fromMs || updated > toMs) return false;
      return true;
    });
  }, [boms, searchText, fromDate, toDate]);

  // Selected ids are visible-list aware: when the user filters the
  // list, only currently-visible selections are counted (others stay
  // in the set so toggling a filter does not silently lose them).
  const visibleSelectedCount = useMemo(() => {
    let n = 0;
    for (const b of filteredBoms) if (selectedIds.has(b.item_id)) n++;
    return n;
  }, [filteredBoms, selectedIds]);

  const allVisibleSelected = filteredBoms.length > 0 && visibleSelectedCount === filteredBoms.length;

  const toggleSelect = (itemId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const b of filteredBoms) next.delete(b.item_id);
      } else {
        for (const b of filteredBoms) next.add(b.item_id);
      }
      return next;
    });
  };

  const clearFilters = () => { setSearchText(''); setFromDate(''); setToDate(''); };

  const cancelExportMode = () => {
    setExportMode(false);
    setSelectedIds(new Set());
    setFromDate('');
    setToDate('');
  };

  const handleExport = async () => {
    // Visible-selected drives the export ids; if none are selected we
    // export the current filtered slice instead.
    const ids = filteredBoms.filter((b) => selectedIds.has(b.item_id)).map((b) => b.item_id);

    if (filteredBoms.length === 0 && ids.length === 0) {
      toast(t.rioExportFailed, { type: 'warning', message: t.rioNoRowsToExport });
      return;
    }

    setExporting(true);
    try {
      const blob = await api.exportRecipes({
        type,
        q:    ids.length ? undefined : (searchText.trim() || undefined),
        from: ids.length ? undefined : (fromDate ? new Date(fromDate).toISOString() : undefined),
        to:   ids.length ? undefined : (toDate   ? new Date(new Date(toDate).getTime() + 86_399_000).toISOString() : undefined),
        ids:  ids.length ? ids : undefined,
      });
      const suffix = type ? `${type}-` : '';
      const stamp  = new Date().toISOString().slice(0, 10);
      triggerBlobDownload(blob, `recipes-${suffix}${stamp}.xlsx`);
      setExportMode(false);
      setSelectedIds(new Set());
      setFromDate('');
      setToDate('');
    } catch (err) {
      const msg = (err as Error).message || '';
      toast(t.rioExportFailed, {
        type: 'error',
        message: msg.includes('No recipes match') ? t.rioNoRowsToExport : msg,
      });
    } finally {
      setExporting(false);
    }
  };

  const fmt = (n: number | string | null | undefined) => {
    const num = typeof n === 'string' ? parseFloat(n) : n;
    return num != null && Number.isFinite(num) && num > 0
      ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)
      : '';
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });

  const handleEdit = async (bom: BomSummary) => {
    setEditingId(bom.id);
    try {
      const detail = await api.getBom(bom.item_id);
      const lines: IngredientLine[] = detail.lines.map((l) => {
        const lineUom = l.line_uom ?? 'kg';
        return {
          lineId: nanoid(),
          item: {
            id:            l.ingredient_id,
            name:          l.ingredient,
            name_en:       l.name_en   ?? null,
            name_he:       l.name_he   ?? null,
            reference:     l.reference ?? null,
            type:          l.item_type,
            cost_per_kg:   l.cost_per_kg,
            unit:          l.unit ?? 'kg',
            volume_weight: null,
            image_url:     l.image_url ?? null,
          },
          line_uom:       lineUom,
          waste_pct:      l.waste_pct ?? 0,
          quantity_kg:    l.quantity_kg,
          quantity_input: l.quantity_kg,
        };
      });
      loadBom(
        {
          recipeName:        detail.recipe_name,
          referenceCode:     detail.reference_code ?? '',
          yieldKg:           detail.yield_kg,
          recipeType:        detail.recipe_type    ?? 'base',
          laborCost:         detail.labor_cost     ?? 0,
          overheadCost:      detail.overhead_cost  ?? 0,
          packagingCost:     detail.packaging_cost ?? 0,
          fullName:          detail.full_name,
          description:       detail.description,
          imageUrl:          detail.image_url,
          allergens:         detail.allergens,
          isSpicy:           detail.is_spicy,
          servingSuggestion: detail.serving_suggestion,
          servingsCount:     detail.servings_count,
          totalWeight:       detail.total_weight,
          pricingFormulaId:  detail.pricing_formula_id,
          lines,
        },
        bom.item_id,
      );
      navigate(`/recipe/${bom.item_id}`);
    } catch {
      alert('Failed to load recipe for editing.');
    } finally {
      setEditingId(null);
    }
  };

  const handleDelete = async (bom: BomSummary) => {
    if (!window.confirm(`Are you sure you want to delete "${bom.recipe_name}"?`)) return;
    setDeletingId(bom.id);
    try {
      await api.deleteBom(bom.id);
      qc.invalidateQueries({ queryKey: ['boms', type] });
    } catch {
      alert('Failed to delete recipe.');
    } finally {
      setDeletingId(null);
    }
  };

  if (isLoading) return <div className="view-placeholder"><p>{t.loading}</p></div>;
  if (isError)   return <div className="view-placeholder"><p>{t.failedToLoad}</p></div>;

  const filtersActive = searchText.trim() !== '' || fromDate !== '' || toDate !== '';
  const totalCount    = (boms ?? []).length;
  const selectedTotal = selectedIds.size;

  // Shared toolbar / import-modal markup so the empty-state path
  // can still expose Import + Template (the user has to be able to
  // create the FIRST recipe via Excel).
  const toolbar = (
    <RecipeIOToolbar
      type={type}
      totalCount={totalCount}
      selectedCount={selectedTotal}
      searchText={searchText}
      onSearchChange={setSearchText}
      fromDate={fromDate}
      toDate={toDate}
      onFromDateChange={setFromDate}
      onToDateChange={setToDate}
      onClearFilters={clearFilters}
      filtersActive={filtersActive}
      onOpenImport={() => setImportOpen(true)}
      onExport={handleExport}
      exporting={exporting}
      exportMode={exportMode}
      onOpenExportMode={() => setExportMode(true)}
      onCancelExportMode={cancelExportMode}
    />
  );

  const importPortal = (
    <RecipeImportModal
      open={importOpen}
      onClose={() => setImportOpen(false)}
      defaultType={type}
    />
  );

  if (!boms?.length) {
    return (
      <div className="bom-history">
        <div className="bom-history__header">
          <h2 className="bom-history__title">{pageTitle}</h2>
          <NavLink to="/recipe/new" className="btn btn--primary bom-history__new-btn">
            + New Recipe
          </NavLink>
        </div>
        {toolbar}
        <div className="view-placeholder view-placeholder--inline">
          <div className="view-placeholder__icon">{type === 'base' ? '◈' : '◉'}</div>
          <h3 className="view-placeholder__title">{pageTitle}</h3>
          <p className="view-placeholder__text">{emptyText}</p>
        </div>
        {importPortal}
      </div>
    );
  }

  return (
    <div className="bom-history">
      <div className="bom-history__header">
        <h2 className="bom-history__title">{pageTitle}</h2>
        <span className="bom-history__count">
          {filtersActive
            ? t.rioRecipesShown.replace('{n}', String(filteredBoms.length)).replace('{total}', String(totalCount))
            : `${totalCount} recipe${totalCount !== 1 ? 's' : ''}`}
        </span>
        <NavLink to="/recipe/new" className="btn btn--primary bom-history__new-btn">
          + New Recipe
        </NavLink>
      </div>
      {toolbar}
      {filteredBoms.length === 0 && (
        <div className="view-placeholder view-placeholder--inline">
          <p className="view-placeholder__text">{t.rioNoRowsToExport}</p>
        </div>
      )}
      {filteredBoms.length > 0 && (
      <table className="bom-history__table">
        <thead>
          <tr>
            {exportMode && (
              <th className="bom-history__select-col">
                <input
                  type="checkbox"
                  aria-label="Select all visible recipes"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAllVisible}
                />
              </th>
            )}
            <th className="bom-history__name-col">{t.recipeName}</th>
            <th className="bom-history__ref-col">{t.refCode}</th>
            <th className="bom-history__num bom-history__num-col">{t.yieldKg}</th>
            {type === 'base' ? (
              <th className="bom-history__num bom-history__num-col">{t.costPerKg}</th>
            ) : (
              <>
                <th className="bom-history__num bom-history__num-col">{t.totalCost}</th>
                <th className="bom-history__num bom-history__num-col">{t.tkpPrice}</th>
                <th className="bom-history__num bom-history__num-col">{t.sellingPrice}</th>
              </>
            )}
            <th className="bom-history__num bom-history__num-col">{t.linesHeader}</th>
            <th className="bom-history__num bom-history__num-col">{t.ver}</th>
            <th className="bom-history__date-col">{t.lastUpdated}</th>
            <th className="bom-history__actions-col">{t.actions}</th>
          </tr>
        </thead>
        <tbody>
          {filteredBoms.map((b) => (
            <React.Fragment key={b.id}>
              <tr className={exportMode && selectedIds.has(b.item_id) ? 'bom-history__row--selected' : undefined}>
                {exportMode && (
                  <td className="bom-history__select-col">
                    <input
                      type="checkbox"
                      aria-label={`Select ${b.recipe_name}`}
                      checked={selectedIds.has(b.item_id)}
                      onChange={() => toggleSelect(b.item_id)}
                    />
                  </td>
                )}
                <td className="bom-history__name">
                  <NavLink to={`/recipes/view/${b.item_id}`} className="bom-history__name-cell">
                    {b.image_url ? (
                      <img
                        className="bom-history__thumb"
                        src={b.image_url}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                          (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty('display', 'flex');
                        }}
                      />
                    ) : null}
                    <span
                      className="bom-history__thumb bom-history__thumb--placeholder"
                      style={{ display: b.image_url ? 'none' : 'flex' }}
                      aria-hidden="true"
                    >
                      {b.recipe_name.trim().charAt(0).toUpperCase() || '·'}
                    </span>
                    <span className="bom-history__name-text">{b.recipe_name}</span>
                  </NavLink>
                </td>
                <td className="bom-history__ref">{b.reference_code ?? ''}</td>
                <td className="bom-history__num">{fmt(b.yield_kg)}</td>
                {type === 'base' ? (
                  <td className="bom-history__num">{fmt(b.cost_per_kg)}</td>
                ) : (
                  <>
                    <td className="bom-history__num bom-history__num--price">{b.total_cost != null ? `₪${fmt(b.total_cost)}` : '—'}</td>
                    <td className="bom-history__num bom-history__num--price">{b.wholesale_for_yield != null ? `₪${fmt(b.wholesale_for_yield)}` : '—'}</td>
                    <td className="bom-history__num bom-history__num--price">{b.retail_for_yield != null ? `₪${fmt(b.retail_for_yield)}` : '—'}</td>
                  </>
                )}
                <td className="bom-history__num">{b.line_count}</td>
                <td className="bom-history__num">
                  <button
                    className="bom-history__ver-btn"
                    onClick={() => setSnapshotItemId(snapshotItemId === b.item_id ? null : b.item_id)}
                    title="View version history"
                  >
                    v{b.version} ▾
                  </button>
                </td>
                <td className="bom-history__date">{fmtDate(b.updated_at)}</td>
                <td className="bom-history__actions">
                  <button
                    className="bom-history__btn bom-history__btn--edit"
                    onClick={() => handleEdit(b)}
                    disabled={editingId === b.id}
                    title={t.edit}
                  >
                    {editingId === b.id ? (
                      '…'
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                        {t.edit}
                      </>
                    )}
                  </button>
                  <button
                    className="bom-history__btn bom-history__btn--delete"
                    onClick={() => handleDelete(b)}
                    disabled={deletingId === b.id}
                    title={t.delete}
                  >
                    {deletingId === b.id ? (
                      '…'
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                          <path d="M10 11v6"/>
                          <path d="M14 11v6"/>
                          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
                        </svg>
                        {t.delete}
                      </>
                    )}
                  </button>
                </td>
              </tr>
              {snapshotItemId === b.item_id && (
                <tr className="bom-history__snapshot-row">
                  <td colSpan={(type === 'base' ? 8 : 10) + (exportMode ? 1 : 0)}>
                    <SnapshotPanel itemId={b.item_id} onClose={() => setSnapshotItemId(null)} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      )}
      {importPortal}
    </div>
  );
};

/* ── Recipe Import / Export Toolbar ───────────────────────────── */
interface RecipeIOToolbarProps {
  type:                RecipeType;
  totalCount:          number;
  selectedCount:       number;
  searchText:          string;
  onSearchChange:      (v: string) => void;
  fromDate:            string;
  toDate:              string;
  onFromDateChange:    (v: string) => void;
  onToDateChange:      (v: string) => void;
  onClearFilters:      () => void;
  filtersActive:       boolean;
  onOpenImport:        () => void;
  onExport:            () => void;
  exporting:           boolean;
  exportMode:          boolean;
  onOpenExportMode:    () => void;
  onCancelExportMode:  () => void;
}

const RecipeIOToolbar: React.FC<RecipeIOToolbarProps> = ({
  totalCount, selectedCount,
  searchText, onSearchChange,
  fromDate, toDate, onFromDateChange, onToDateChange,
  onClearFilters, filtersActive,
  onOpenImport, onExport, exporting,
  exportMode, onOpenExportMode, onCancelExportMode,
}) => {
  const { t } = useLang();
  const exportLabel = exportMode
    ? (selectedCount > 0 ? t.rioExportSelected : t.rioExportFiltered)
    : t.rioExportBtn;

  return (
    <div className={`rio-toolbar${exportMode ? ' rio-toolbar--export' : ''}`}>
      <div className="rio-toolbar__filters">
        <div className="rio-toolbar__search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="search"
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t.rioSearchPlaceholder}
            aria-label={t.rioSearchPlaceholder}
          />
        </div>

        {exportMode && (
          <>
            <label className="rio-toolbar__date">
              <span>{t.rioFromDate}</span>
              <input type="date" value={fromDate} onChange={(e) => onFromDateChange(e.target.value)} />
            </label>
            <label className="rio-toolbar__date">
              <span>{t.rioToDate}</span>
              <input type="date" value={toDate} onChange={(e) => onToDateChange(e.target.value)} />
            </label>
          </>
        )}

        {filtersActive && (
          <button className="btn btn--ghost btn--sm" onClick={onClearFilters}>
            {t.rioClearFilters}
          </button>
        )}

        {exportMode && selectedCount > 0 && (
          <span className="rio-toolbar__selected">
            {t.rioSelectedCount.replace('{n}', String(selectedCount))}
          </span>
        )}
      </div>

      <div className="rio-toolbar__actions">
        {exportMode && (
          <button className="btn btn--ghost rio-toolbar__btn" onClick={onCancelExportMode}>
            <span>{t.rioCancel}</span>
          </button>
        )}
        <button
          className="btn btn--ghost rio-toolbar__btn"
          onClick={exportMode ? onExport : onOpenExportMode}
          disabled={exporting || totalCount === 0}
          title={exportLabel}
        >
          {exporting
            ? <span className="btn-spinner" aria-hidden="true" />
            : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            )}
          <span>{exportLabel}</span>
        </button>
        <button className="btn btn--primary rio-toolbar__btn" onClick={onOpenImport}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span>{t.rioImportBtn}</span>
        </button>
      </div>
    </div>
  );
};

/* ── Settings Page ──────────────────────────────────────────── */
export const SettingsPage: React.FC = () => {
  const { t } = useLang();
  const [tab, setTab] = useState<'formulas' | 'users' | 'sync'>('formulas');

  return (
    <div className="settings-page">
      <div className="settings-page__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'formulas'}
          className={`settings-page__tab ${tab === 'formulas' ? 'settings-page__tab--active' : ''}`}
          onClick={() => setTab('formulas')}
        >
          {t.settingsTabFormulas}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'users'}
          className={`settings-page__tab ${tab === 'users' ? 'settings-page__tab--active' : ''}`}
          onClick={() => setTab('users')}
        >
          {t.settingsTabUsers}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'sync'}
          className={`settings-page__tab ${tab === 'sync' ? 'settings-page__tab--active' : ''}`}
          onClick={() => setTab('sync')}
        >
          {t.settingsTabSync}
        </button>
      </div>

      <div className="settings-page__body">
        {tab === 'formulas' && <FormulaManager />}
        {tab === 'users'    && <UserManagementPanel />}
        {tab === 'sync'     && <OdooSyncPanel />}
      </div>
    </div>
  );
};

/* ── Inner App (needs useLang, so must be inside LanguageProvider) */
const AppInner: React.FC = () => {
  const { t }    = useLang();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  // Nav items are tagged with `adminOnly` so the renderer below can
  // hide admin entries for customer accounts.  The client-side gate
  // is cosmetic — server enforcement (STEP 2) is the real policy.
  const isAdmin = user?.role === 'admin';

  const NAV_ITEMS: Array<{ to: string; label: string; end: boolean; icon: React.ReactNode; adminOnly?: boolean }> = [
    {
      to: '/dashboard', label: t.dashboard, end: true, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="9"/>
          <rect x="14" y="3" width="7" height="5"/>
          <rect x="14" y="12" width="7" height="9"/>
          <rect x="3" y="16" width="7" height="5"/>
        </svg>
      ),
    },
    {
      to: '/book', label: t.recipeBook, end: false,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
      ),
    },
    {
      to: '/recipes/base', label: t.baseRecipes, end: true, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="12 2 2 7 12 12 22 7 12 2"/>
          <polyline points="2 17 12 22 22 17"/>
          <polyline points="2 12 12 17 22 12"/>
        </svg>
      ),
    },
    {
      to: '/recipes/final', label: t.finalProducts, end: true, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
          <line x1="12" y1="22.08" x2="12" y2="12"/>
        </svg>
      ),
    },
    {
      to: '/recipe/new', label: t.recipeBuilder, end: false, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      ),
    },
    {
      to: '/where-used', label: t.whereUsed, end: true, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3"/>
          <circle cx="6" cy="12" r="3"/>
          <circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
      ),
    },
    {
      to: '/products', label: t.products, end: true, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20.5 7.27L12 12 3.5 7.27"/>
          <path d="M12 22V12"/>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
      ),
    },
    {
      to: '/settings', label: t.settings, end: true, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
          <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
          <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
          <line x1="1" y1="14" x2="7" y2="14"/>
          <line x1="9" y1="8" x2="15" y2="8"/>
          <line x1="17" y1="16" x2="23" y2="16"/>
        </svg>
      ),
    },
    {
      to: '/logs', label: t.logs, end: true, adminOnly: true,
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
      ),
    },
  ].filter((item) => !item.adminOnly || isAdmin);

  return (
    <div className="app">
      {/* ── Top header ────────────────────────────────────── */}
      <header className="app__header">
        <button
          className="app__menu-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-label="Toggle navigation"
        >
          <span className="app__menu-toggle-icon">{collapsed ? '☰' : '✕'}</span>
        </button>

        <KosherPlaceLogo />

        <div className="app__header-meta">
          <span className="app__header-title">{t.bomSystem}</span>
          <span className="app__header-sub">{t.productionMgmt}</span>
        </div>

        <LangToggle />

        {/* ── User / logout ──────────────────────────────── */}
        <div className="app__user-menu">
          {user && <span className="app__user-name">{user.name}</span>}
          <button
            className="app__logout-btn"
            onClick={logout}
            title={t.logout}
            aria-label={t.logout}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ── Body: sidebar + main ──────────────────────────── */}
      <div className="app__body">
        <aside className={`app__sidebar ${collapsed ? 'app__sidebar--collapsed' : ''}`}>
          <nav className="sidebar-nav" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `sidebar-nav__item${isActive ? ' sidebar-nav__item--active' : ''}`
                }
                title={collapsed ? item.label : undefined}
                aria-current={undefined}
              >
                <span className="sidebar-nav__icon">{item.icon}</span>
                <span className="sidebar-nav__label">{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="app__main">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

/* ── App root ──────────────────────────────────────────────── */
export const App: React.FC = () => (
  <LanguageProvider>
    <QueryClientProvider client={queryClient}>
      <AppInner />
      <BomDrillDownModal />
      <ToastContainer />
    </QueryClientProvider>
  </LanguageProvider>
);
