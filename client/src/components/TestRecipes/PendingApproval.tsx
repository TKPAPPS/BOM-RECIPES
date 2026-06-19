import React, { useState, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, triggerBlobDownload } from '../../api';
import { useLang } from '../../context/LanguageContext';
import type { TestRecipeSummary } from '../../types';
import { useToastStore } from '../../stores/useToastStore';
import { RecipeImportModal } from '../RecipeIO/RecipeImportModal';
import { useAuth } from '../../context/AuthContext';

type SortKey = 'name' | 'reference_code' | 'type' | 'red';

/**
 * Pending Approval — manager review queue with cards / list views, bulk
 * selection and bulk actions (Export, Print, PDF, Delete, Approve).
 * Approve promotes a recipe into the real Base/Final list; it is blocked
 * while any ingredient is still red (not in the catalogue).
 */
export const PendingApproval: React.FC = () => {
  const { t } = useLang();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);
  // Only a MANAGER can finally approve (promote) a recipe. The kitchen team
  // (admin) may view and edit pending recipes, but not approve them.
  const { user } = useAuth();
  const isManager = user?.role === 'manager';

  const [viewMode, setViewMode] = useState<'cards' | 'list'>('list');
  const [filter, setFilter] = useState<'all' | 'ready' | 'issues'>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['test-recipes', 'pending'],
    queryFn: () => api.getTestRecipes('pending'),
  });

  // Click a header to sort by it; click the same header again to flip
  // the direction (A→Z ⇄ Z→A).
  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const sortArrow = (key: SortKey) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  // Pipeline: status filter → free-text search (name + ref code) → sort.
  const filtered = useMemo(() => {
    const byStatus = recipes.filter((r) =>
      filter === 'ready' ? r.red_count === 0 : filter === 'issues' ? r.red_count > 0 : true
    );
    const q = search.trim().toLowerCase();
    const bySearch = q
      ? byStatus.filter((r) =>
          r.name.toLowerCase().includes(q) ||
          (r.reference_code ?? '').toLowerCase().includes(q))
      : byStatus;
    const dir = sortDir === 'asc' ? 1 : -1;
    const val = (r: TestRecipeSummary): string | number => {
      switch (sortKey) {
        case 'name': return r.name.toLowerCase();
        case 'reference_code': return (r.reference_code ?? '').toLowerCase();
        case 'type': return r.recipe_type === 'final' ? t.finalProductOption : t.baseRecipeOption;
        case 'red': return r.red_count;
      }
    };
    return [...bySearch].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [recipes, filter, search, sortKey, sortDir, t]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['test-recipes'] });
    qc.invalidateQueries({ queryKey: ['boms'] });
  };
  const clearSel = () => setSelected(new Set());
  const ids = () => [...selected];

  const toggleOne = (id: number) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(filtered.map((r) => r.id)));

  // ── Single approve ──
  const approve = useMutation({
    mutationFn: (id: number) => api.promoteTestRecipe(id),
    onSuccess: (data) => {
      invalidate();
      toast(t.promoteDone, { type: 'success', message: data.recipe_type === 'final' ? t.finalProductOption : t.baseRecipeOption });
    },
    onError: (e: Error) => toast(t.promoteFailed, { type: 'error', message: e.message }),
  });

  // ── Bulk actions ──
  const bulkApprove = async () => {
    if (!selected.size) return;
    setBusy(true);
    toast(t.bulkApproving.replace('{n}', String(selected.size)), { type: 'info' });
    try {
      const r = await api.bulkPromoteTestRecipes(ids());
      invalidate(); clearSel();
      const blocked = r.blocked?.length
        ? ` ${t.bulkBlocked.replace('{n}', String(r.blocked.length))}`
        : '';
      toast(t.promoteDone, { type: r.blocked?.length ? 'warning' : 'success', message: `${r.promoted} ✓${blocked}` });
    } catch (e) { toast(t.promoteFailed, { type: 'error', message: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const bulkDelete = async () => {
    if (!selected.size) return;
    if (!window.confirm(t.confirmDeleteRecipe)) return;
    setBusy(true);
    try {
      const r = await api.bulkDeleteTestRecipes(ids());
      invalidate(); clearSel();
      toast(t.recipeDeleted, { type: 'success', message: String(r.count) });
    } catch (e) { toast(t.deleteFailed, { type: 'error', message: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const bulkExport = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const blob = await api.exportTestRecipes(ids());
      triggerBlobDownload(blob, `pending-recipes-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) { toast(t.deleteFailed, { type: 'error', message: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const bulkPrint = () => {
    if (!selected.size) return;
    navigate(`/test-recipes/print?ids=${ids().join(',')}`);
  };

  // Toolbar export: exports every recipe currently shown (after filter +
  // search), or all pending when nothing is filtered.
  const exportAll = async () => {
    const list = filtered.length ? filtered : recipes;
    if (!list.length) return;
    setExporting(true);
    try {
      const blob = await api.exportTestRecipes(list.map((r) => r.id));
      triggerBlobDownload(blob, `pending-recipes-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) { toast(t.rioExportFailed, { type: 'error', message: (e as Error).message }); }
    finally { setExporting(false); }
  };
  const closeImport = () => { setImportOpen(false); invalidate(); };

  const typeLabel = (r: TestRecipeSummary) => r.recipe_type === 'final' ? t.finalProductOption : t.baseRecipeOption;

  return (
    <div className="bom-history">
      <div className="bom-history__header">
        <h2 className="bom-history__title">
          {t.pendingApproval}
          <span className="kr-tab__count" style={{ marginInlineStart: 8 }}>{filtered.length}</span>
        </h2>
      </div>
      <p className="bom-history__subtitle">{t.pendingApprovalHint}</p>

      {/* Toolbar — styled like Kitchen Recipes: search + Export + Import
          (no "Build new recipe" here). */}
      <div className="rio-toolbar">
        <div className="rio-toolbar__filters">
          <div className="rio-toolbar__search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.rioSearchPlaceholder}
              aria-label={t.rioSearchPlaceholder}
            />
          </div>
        </div>
        <div className="rio-toolbar__actions">
          <button className="btn btn--ghost rio-toolbar__btn" onClick={exportAll} disabled={exporting || recipes.length === 0} title={t.rioExportBtn}>
            {exporting ? <span className="btn-spinner" aria-hidden="true" /> : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
            <span>{t.rioExportBtn}</span>
          </button>
          <button className="btn btn--primary rio-toolbar__btn" onClick={() => setImportOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>{t.rioImportBtn}</span>
          </button>
        </div>
      </div>

      {/* Toolbar: status filter + bulk bar (when selected) + view toggle */}
      <div className="kr-viewbar">
        <div className="kr-view-toggle pend-filter" role="group" aria-label={t.pendFilterLabel}>
          <button type="button" className={`kr-view-toggle__btn${filter === 'all' ? ' kr-view-toggle__btn--active' : ''}`} onClick={() => setFilter('all')} title={t.pendFilterAll}>{t.pendFilterAll}</button>
          <button type="button" className={`kr-view-toggle__btn${filter === 'ready' ? ' kr-view-toggle__btn--active' : ''}`} onClick={() => setFilter('ready')} title={t.pendFilterReady} aria-label={t.pendFilterReady}>✓</button>
          <button type="button" className={`kr-view-toggle__btn${filter === 'issues' ? ' kr-view-toggle__btn--active' : ''}`} onClick={() => setFilter('issues')} title={t.pendFilterIssues} aria-label={t.pendFilterIssues}>⚠</button>
        </div>
        {selected.size > 0 && (
          <div className="kr-bulkbar">
            <span className="kr-bulkbar__count">{t.bulkSelected.replace('{n}', String(selected.size))}</span>
            <div className="kr-bulkbar__actions">
              <button className="btn btn--ghost btn--sm" onClick={bulkExport} disabled={busy}>⭳ {t.rioExportBtn}</button>
              <button className="btn btn--ghost btn--sm" onClick={bulkPrint} disabled={busy}>⎙ {t.rbViewPrint}</button>
              <button className="btn btn--ghost btn--sm" onClick={bulkPrint} disabled={busy}>📄 {t.pdf}</button>
              {isManager && <button className="btn btn--primary btn--sm" onClick={bulkApprove} disabled={busy}>{busy ? '…' : `✓ ${t.approveRecipe}`}</button>}
              <button className="btn btn--ghost btn--sm kr-bulkbar__danger" onClick={bulkDelete} disabled={busy}>🗑 {t.delete}</button>
              <button className="btn btn--ghost btn--sm" onClick={clearSel} disabled={busy}>✕ {t.clear}</button>
            </div>
          </div>
        )}
        <div className="kr-viewbar__right">
          <div className="kr-view-toggle" role="group" aria-label={t.viewMode}>
            <button type="button" className={`kr-view-toggle__btn${viewMode === 'cards' ? ' kr-view-toggle__btn--active' : ''}`} onClick={() => setViewMode('cards')} title={t.viewCards}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            </button>
            <button type="button" className={`kr-view-toggle__btn${viewMode === 'list' ? ' kr-view-toggle__btn--active' : ''}`} onClick={() => setViewMode('list')} title={t.viewList}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="view-placeholder"><p>{t.loading}</p></div>
      ) : recipes.length === 0 ? (
        <div className="view-placeholder"><p>{t.pendingApprovalEmpty}</p></div>
      ) : filtered.length === 0 ? (
        <div className="view-placeholder"><p>{t.pendFilterEmpty}</p></div>
      ) : viewMode === 'cards' ? (
        <div className="kr-cards">
          {filtered.map((r) => {
            const hasRed = r.red_count > 0;
            return (
              <div className="kr-card" key={r.id}>
                <Link to={`/test-recipe/view/${r.id}`} className="kr-card__media kr-card__img kr-card__img--name">
                  <span className="kr-card__name-on-media">{r.name}</span>
                </Link>
                <div className="kr-card__body">
                  <Link to={`/test-recipe/view/${r.id}`} className="kr-card__name">{r.name}</Link>
                  <div className="kr-card__meta">
                    {r.reference_code && <span className="kr-card__ref">{r.reference_code}</span>}
                    <span className="kr-card__meta-dot">·</span>
                    <span>{typeLabel(r)}</span>
                    <span className="kr-card__meta-dot">·</span>
                    {hasRed ? <span className="test-red-badge" title={t.testRedTooltip}>{r.red_count}</span> : <span className="test-ok-badge">✓</span>}
                  </div>
                  <div className="kr-card__actions">
                    <button className="btn btn--ghost btn--sm" onClick={() => navigate(`/test-recipe/${r.id}`)}>{t.edit}</button>
                    {isManager && <button className="btn btn--primary btn--sm" disabled={hasRed || approve.isPending} title={hasRed ? t.promoteBlockedRed : t.approveRecipe} onClick={() => { if (window.confirm(t.approveConfirm.replace('{name}', r.name))) approve.mutate(r.id); }}>{t.approveRecipe}</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <table className="bom-history__table">
          <thead>
            <tr>
              <th style={{ width: 36 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="select all" /></th>
              <th className="th-sortable" onClick={() => onSort('name')} title={t.recipeName}>{t.recipeName}{sortArrow('name')}</th>
              <th className="th-sortable" onClick={() => onSort('reference_code')} title={t.refCode}>{t.refCode}{sortArrow('reference_code')}</th>
              <th className="th-sortable" onClick={() => onSort('type')} title={t.recipeTypeLabel}>{t.recipeTypeLabel}{sortArrow('type')}</th>
              <th className="th-sortable bom-history__num" onClick={() => onSort('red')} title={t.testRedColumn}>{t.testRedColumn}{sortArrow('red')}</th>
              <th style={{ width: 200 }} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const hasRed = r.red_count > 0;
              return (
                <tr key={r.id} className={selected.has(r.id) ? 'bom-history__row--selected' : undefined}>
                  <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} /></td>
                  <td className="bom-history__name"><Link to={`/test-recipe/view/${r.id}`} className="bom-history__name-cell">{r.name}</Link></td>
                  <td className="bom-history__ref">{r.reference_code ?? ''}</td>
                  <td>{typeLabel(r)}</td>
                  <td className="bom-history__num">
                    {hasRed ? <span className="test-red-badge" title={t.testRedTooltip}>{r.red_count}</span> : <span className="test-ok-badge">✓</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'end' }}>
                    <button className="btn btn--ghost btn--sm" onClick={() => navigate(`/test-recipe/${r.id}`)}>{t.edit}</button>
                    {isManager && <button className="btn btn--primary btn--sm" style={{ marginInlineStart: 6 }} disabled={hasRed || approve.isPending} title={hasRed ? t.promoteBlockedRed : t.approveRecipe} onClick={() => { if (window.confirm(t.approveConfirm.replace('{name}', r.name))) approve.mutate(r.id); }}>{t.approveRecipe}</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <RecipeImportModal open={importOpen} onClose={closeImport} defaultType="base" />
    </div>
  );
};
