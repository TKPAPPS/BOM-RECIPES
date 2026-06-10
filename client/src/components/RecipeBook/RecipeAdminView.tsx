import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, triggerBlobDownload } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import { getImageSrc, fmtMoney, fmtQty, toNum, CURRENCY_SYMBOL } from './imageHelpers';
import { SubRecipeExpansion } from './RecipeBookDetail';
import type { BomDetail, BomSummary } from '../../types';

/**
 * Admin read-only detail view for a recipe (Base Recipe or Final Product).
 * Linked from the recipe-name cell in the BomHistory list. Shows the
 * complete recipe card — header, description, allergens/badges, pricing
 * summary, batch additions, and the ingredient lines table — without any
 * edit affordances.
 */
export const RecipeAdminView: React.FC = () => {
  const { itemId } = useParams<{ itemId: string }>();
  const id = itemId ? parseInt(itemId) : NaN;
  const { t } = useLang();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);

  // Settings (gear) dropdown menu — edit / delete / archive / export / print.
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  // Which sub-recipe lines are expanded (by line_id) — click the
  // SUB-RECIPE pill to reveal the base recipe's ingredients inline,
  // mirroring the Recipe Book detail view.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (lineId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return next;
    });

  // Desired production quantity (kg).  Empty/invalid → show the recipe's
  // own yield (scale ×1).  Scaling multiplies every ingredient quantity
  // (and nested base-recipe quantities) by desired ÷ yield.
  const [produceKg, setProduceKg] = useState('');
  // Tracks which base sub-recipes actually have preparation steps, so we
  // never render an empty sub-recipe row and can show a single "no steps"
  // line when nothing (recipe or any sub-recipe) has prep info.
  const [subStepsInfo, setSubStepsInfo] = useState<Record<number, boolean>>({});

  const { data: recipe, isLoading, isError, error } = useQuery({
    queryKey: ['bom-detail', id],
    queryFn: () => api.getBom(id),
    enabled: Number.isFinite(id),
    retry: false,
  });

  // BomDetail doesn't carry version / updated_at — pull from the list.
  const { data: summaries } = useQuery({
    queryKey: ['boms'],
    queryFn: () => api.getBoms(),
    staleTime: 30_000,
  });
  const summary: BomSummary | undefined = (summaries ?? []).find((s) => s.item_id === id);

  if (isLoading) return <div className="view-placeholder"><p>{t.loading}</p></div>;
  if (isError || !recipe) {
    return (
      <div className="view-placeholder">
        <p>{(error as Error)?.message || t.failedToLoad}</p>
        <Link to="/kitchen" className="btn btn--ghost">←</Link>
      </div>
    );
  }

  const detail = recipe as BomDetail;
  // Back to the Kitchen Recipes page (which hosts the Base/Final tabs),
  // preserving the right tab via ?tab= so the user lands where they came
  // from instead of the bare /recipes/* route (no tabs).
  const backTo = `/kitchen?tab=${detail.recipe_type === 'base' ? 'base' : 'final'}`;
  const backLabel = t.kitchenRecipes;

  const fmtDate = (iso: string | undefined) =>
    iso
      ? new Date(iso).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' })
      : '—';

  // True only if the value is a positive finite number (handles string numerics).
  const has = (v: unknown): boolean => {
    const n = toNum(v);
    return n != null && n > 0;
  };

  // Money chip helper — only call when has() is already true.
  const money = (n: number | string | null | undefined) => `${CURRENCY_SYMBOL}${fmtMoney(n)}`;

  const hasLabor     = has(detail.labor_cost);
  const hasOverhead  = has(detail.overhead_cost);
  const hasPackaging = has(detail.packaging_cost);
  const hasBatchAdditions = hasLabor || hasOverhead || hasPackaging;

  // Selling prices (wholesale/retail) apply to final products only — base
  // recipes are intermediates, so we show only their cost figures.
  const isFinal      = detail.recipe_type === 'final';
  const hasCostPerKg = has(detail.cost_per_kg);
  const hasTotalCost = has(summary?.total_cost);
  const hasTkp       = isFinal && has(summary?.wholesale_for_yield);
  const hasSelling   = isFinal && has(summary?.retail_for_yield);
  const hasPricing   = hasCostPerKg || hasTotalCost || hasTkp || hasSelling;

  const hasYield    = has(detail.yield_kg);
  const hasNetWt    = has(detail.total_weight);
  const hasServings = detail.servings_count != null && detail.servings_count > 0;

  const handlePrint = () => {
    const prevTitle = document.title;
    const recipeTitle = (detail.full_name || detail.recipe_name).replace(/[\\/:*?"<>|]/g, '-');
    document.title = recipeTitle;
    window.print();
    setTimeout(() => { document.title = prevTitle; }, 500);
  };

  // ── Gear-menu actions ──
  const handleDeleteRecipe = async () => {
    setMenuOpen(false);
    if (!window.confirm(t.confirmDeleteRecipe.replace('{name}', detail.recipe_name))) return;
    setBusy(true);
    try {
      await api.deleteBom(detail.id);
      qc.invalidateQueries({ queryKey: ['boms'] });
      toast(t.recipeDeleted, { type: 'success' });
      navigate(backTo);
    } catch (err) {
      const msg = (err as Error).message || '';
      toast(t.deleteFailed, {
        type: 'error',
        message: msg.includes('in_use') || msg.includes('sub-recipe') ? t.deleteInUse : msg,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleArchiveRecipe = async () => {
    setMenuOpen(false);
    if (!window.confirm(t.bulkConfirmArchive.replace('{n}', '1'))) return;
    setBusy(true);
    try {
      await api.bulkArchiveBoms([detail.item_id], true);
      qc.invalidateQueries({ queryKey: ['boms'] });
      toast(t.bulkArchived.replace('{n}', '1'), { type: 'success' });
      navigate(backTo);
    } catch (err) {
      toast(t.failedToLoad, { type: 'error', message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const handleExportRecipe = async () => {
    setMenuOpen(false);
    setBusy(true);
    try {
      const blob = await api.exportRecipes({ type: detail.recipe_type, ids: [detail.item_id] });
      const stamp = new Date().toISOString().slice(0, 10);
      triggerBlobDownload(blob, `recipe-${detail.reference_code || detail.item_id}-${stamp}.xlsx`);
    } catch (err) {
      toast(t.rioExportFailed, { type: 'error', message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="recipe-view">
      {/* ── Top bar (hidden in print) ───────────────────────── */}
      <div className="recipe-view__topbar recipe-view__no-print">
        <button
          type="button"
          className="recipe-view__back"
          onClick={() => navigate(backTo)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          <span>{backLabel}</span>
        </button>

        <div className="recipe-view__topbar-actions">
          <div className="recipe-view__menu" ref={menuRef}>
            <button
              type="button"
              className={`recipe-view__gear${menuOpen ? ' recipe-view__gear--open' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={t.actions}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>

            {menuOpen && (
              <div className="recipe-view__menu-pop" role="menu">
                <Link to={`/recipe/${detail.item_id}`} className="recipe-view__menu-item" role="menuitem" onClick={() => setMenuOpen(false)}>
                  ✎ {t.edit}
                </Link>
                <button type="button" className="recipe-view__menu-item" role="menuitem" onClick={handlePrint}>
                  ⎙ {t.rbViewPrint} / {t.rbViewPdf}
                </button>
                <button type="button" className="recipe-view__menu-item" role="menuitem" onClick={handleExportRecipe} disabled={busy}>
                  ⭳ {t.rioExportBtn}
                </button>
                <button type="button" className="recipe-view__menu-item" role="menuitem" onClick={handleArchiveRecipe} disabled={busy}>
                  🗄 {t.archive}
                </button>
                <button type="button" className="recipe-view__menu-item recipe-view__menu-item--danger" role="menuitem" onClick={handleDeleteRecipe} disabled={busy}>
                  🗑 {t.delete}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Hero ────────────────────────────────────────────── */}
      <header className="recipe-view__hero">
        <div className="recipe-view__hero-media">
          {getImageSrc(detail.image_url) ? (
            <img src={getImageSrc(detail.image_url)!} alt={detail.recipe_name} />
          ) : (
            <div className="recipe-view__hero-fallback" aria-hidden="true">
              {detail.recipe_name.trim().charAt(0).toUpperCase() || '◈'}
            </div>
          )}
        </div>

        <div className="recipe-view__hero-body">
          <div className="recipe-view__type-tag">
            {detail.recipe_type === 'base' ? t.baseRecipeOption : t.finalProductOption}
          </div>
          <h1 className="recipe-view__title">{detail.full_name || detail.recipe_name}</h1>

          {detail.full_name && detail.full_name !== detail.recipe_name && (
            <p className="recipe-view__subtitle">{detail.recipe_name}</p>
          )}

          {detail.reference_code && (
            <p className="recipe-view__ref">{detail.reference_code}</p>
          )}

          {detail.description && (
            <p className="recipe-view__desc">{detail.description}</p>
          )}

          {(detail.is_spicy || (detail.allergens && detail.allergens.length > 0)) && (
            <div className="recipe-view__chips">
              {detail.is_spicy && (
                <span className="recipe-view__chip recipe-view__chip--spicy">🌶 {t.rbSpicyTag}</span>
              )}
              {detail.allergens && detail.allergens.length > 0 && (
                <span className="recipe-view__chip recipe-view__chip--allergen">
                  <strong>{t.rbAllergenLabel}:</strong> {detail.allergens.join(' · ')}
                </span>
              )}
            </div>
          )}

          {detail.serving_suggestion && (
            <p className="recipe-view__serving">
              <strong>{t.rbServingSuggestion}:</strong> {detail.serving_suggestion}
            </p>
          )}
        </div>
      </header>

      {/* ── Quick facts strip ───────────────────────────────── */}
      <section className="recipe-view__facts">
        {hasYield && (
          <div className="recipe-view__fact">
            <div className="recipe-view__fact-label">{t.yieldKg}</div>
            <div className="recipe-view__fact-value">{fmtQty(detail.yield_kg)} kg</div>
          </div>
        )}
        {hasNetWt && (
          <div className="recipe-view__fact">
            <div className="recipe-view__fact-label">{t.rbTotalWeight}</div>
            <div className="recipe-view__fact-value">{fmtQty(detail.total_weight)} kg</div>
          </div>
        )}
        {hasServings && (
          <div className="recipe-view__fact">
            <div className="recipe-view__fact-label">{t.rbServings}</div>
            <div className="recipe-view__fact-value">~{detail.servings_count}</div>
          </div>
        )}
        {detail.lines.length > 0 && (
          <div className="recipe-view__fact">
            <div className="recipe-view__fact-label">{t.linesHeader}</div>
            <div className="recipe-view__fact-value">{detail.lines.length}</div>
          </div>
        )}
        {summary?.version != null && (
          <div className="recipe-view__fact">
            <div className="recipe-view__fact-label">{t.ver}</div>
            <div className="recipe-view__fact-value">v{summary.version}</div>
          </div>
        )}
        {summary?.updated_at && (
          <div className="recipe-view__fact">
            <div className="recipe-view__fact-label">{t.lastUpdated}</div>
            <div className="recipe-view__fact-value">{fmtDate(summary.updated_at)}</div>
          </div>
        )}
      </section>

      {/* ── Pricing summary ─────────────────────────────────── */}
      {hasPricing && (
        <section className="recipe-view__section">
          <h2 className="recipe-view__section-title">{t.pricingStrategy ?? 'Pricing'}</h2>

          <div className="recipe-view__price-grid">
            {hasCostPerKg && (
              <div className="recipe-view__price-card">
                <div className="recipe-view__price-label">{t.costPerKg}</div>
                <div className="recipe-view__price-value">{money(detail.cost_per_kg)}</div>
              </div>
            )}
            {hasTotalCost && (
              <div className="recipe-view__price-card">
                <div className="recipe-view__price-label">{t.totalCost}</div>
                <div className="recipe-view__price-value">{money(summary?.total_cost)}</div>
              </div>
            )}
            {hasTkp && (
              <div className="recipe-view__price-card recipe-view__price-card--accent">
                <div className="recipe-view__price-label">{t.tkpPrice}</div>
                <div className="recipe-view__price-value">{money(summary?.wholesale_for_yield)}</div>
              </div>
            )}
            {hasSelling && (
              <div className="recipe-view__price-card recipe-view__price-card--accent">
                <div className="recipe-view__price-label">{t.sellingPrice}</div>
                <div className="recipe-view__price-value">{money(summary?.retail_for_yield)}</div>
              </div>
            )}
          </div>

          {hasBatchAdditions && (
            <div className="recipe-view__batch">
              <div className="recipe-view__batch-title">
                {t.rbBatchCostsLabel} ({t.perBatch})
              </div>
              <ul className="recipe-view__batch-list">
                {hasLabor && (
                  <li><span>{t.labor}</span><span>{money(detail.labor_cost)}</span></li>
                )}
                {hasOverhead && (
                  <li><span>{t.overhead}</span><span>{money(detail.overhead_cost)}</span></li>
                )}
                {hasPackaging && (
                  <li><span>{t.calcPackaging ?? 'Packaging'}</span><span>{money(detail.packaging_cost)}</span></li>
                )}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ── Ingredients ─────────────────────────────────────── */}
      {detail.lines.length > 0 && (() => {
        const showRef    = detail.lines.some((l) => !!l.reference);
        const showCostKg = detail.lines.some((l) => has(l.cost_per_kg));
        const showLine   = detail.lines.some((l) => has(l.line_cost));
        const baseYield  = toNum(detail.yield_kg) || 0;
        const desired    = parseFloat(produceKg);
        const scale      = baseYield > 0 && Number.isFinite(desired) && desired > 0 ? desired / baseYield : 1;
        return (
          <section className="recipe-view__section">
            <div className="recipe-view__section-head">
              <h2 className="recipe-view__section-title">{t.rbIngredientsHeader}</h2>
              <div className="recipe-view__scale">
                <span className="recipe-view__scale-label">{t.calcDesiredWeight}</span>
                <input
                  className="recipe-view__scale-input"
                  type="number" min={0} step="any"
                  value={produceKg}
                  placeholder={baseYield ? fmtQty(baseYield) : ''}
                  onChange={(e) => setProduceKg(e.target.value)}
                />
                <span className="recipe-view__scale-unit">kg</span>
                {scale !== 1 && <span className="recipe-view__scale-factor">×{fmtQty(scale, 4)}</span>}
                {produceKg !== '' && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setProduceKg('')}>{t.clear}</button>
                )}
              </div>
            </div>
            <div className="recipe-view__table-wrap">
              <table className="recipe-view__table">
                <thead>
                  <tr>
                    <th>{t.ingredient}</th>
                    {showRef    && <th>{t.refCode}</th>}
                    <th className="recipe-view__num">{t.rbQuantityHeader}</th>
                    {showCostKg && <th className="recipe-view__num">{t.rbCostPerKgHeader}</th>}
                    {showLine   && <th className="recipe-view__num">{t.rbLineCostHeader}</th>}
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l) => {
                    const isRecipe = l.item_type === 'recipe';
                    const isOpen = expanded.has(l.line_id);
                    const colCount = 1 + (showRef ? 1 : 0) + 1 + (showCostKg ? 1 : 0) + (showLine ? 1 : 0);
                    const qty      = has(l.quantity_kg) ? (toNum(l.quantity_kg) || 0) * scale : null;
                    const lineCost = has(l.line_cost)   ? (toNum(l.line_cost)   || 0) * scale : null;
                    return (
                      <React.Fragment key={l.line_id}>
                        <tr>
                          <td>
                            <div className="recipe-view__ing-cell">
                              {getImageSrc(l.image_url) ? (
                                <img className="recipe-view__ing-thumb" src={getImageSrc(l.image_url)!} alt="" loading="lazy" />
                              ) : (
                                <span className="recipe-view__ing-thumb recipe-view__ing-thumb--placeholder" aria-hidden="true">
                                  {l.ingredient.trim().charAt(0).toUpperCase() || '·'}
                                </span>
                              )}
                              <div className="recipe-view__ing-text">
                                {isRecipe ? (
                                  <Link
                                    to={`/recipes/view/${l.ingredient_id}`}
                                    className="recipe-view__ing-name recipe-view__ing-name--link"
                                    title={t.openBaseRecipe}
                                  >
                                    {l.ingredient}
                                  </Link>
                                ) : (
                                  <span className="recipe-view__ing-name">{l.ingredient}</span>
                                )}
                                {isRecipe && (
                                  <button
                                    type="button"
                                    className="recipe-view__sub-pill recipe-view__sub-pill--toggle"
                                    onClick={() => toggleExpanded(l.line_id)}
                                    aria-expanded={isOpen}
                                    title={t.subRecipe}
                                  >
                                    {t.subRecipe}
                                    <span className="recipe-view__sub-caret">{isOpen ? '▲' : '▼'}</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                          {showRef    && <td className="recipe-view__ref">{l.reference || ''}</td>}
                          <td className="recipe-view__num">{qty != null ? `${fmtQty(qty)} kg` : ''}</td>
                          {showCostKg && <td className="recipe-view__num">{has(l.cost_per_kg) ? money(l.cost_per_kg) : ''}</td>}
                          {showLine   && <td className="recipe-view__num recipe-view__num--price">{lineCost != null ? money(lineCost) : ''}</td>}
                        </tr>
                        {isRecipe && isOpen && (
                          <tr className="rb-subrecipe-row">
                            <td colSpan={colCount}>
                              <SubRecipeExpansion itemId={l.ingredient_id} quantityKg={(toNum(l.quantity_kg) || 0) * scale} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      {/* ── Preparation steps (recipe's own + each base sub-recipe's) ── */}
      {(() => {
        const ownSteps = detail.steps ?? [];
        const subLines = detail.lines.filter((l) => l.item_type === 'recipe');
        if (ownSteps.length === 0 && subLines.length === 0) return null;
        const anySubHasSteps = subLines.some((l) => subStepsInfo[l.ingredient_id]);
        return (
          <section className="recipe-view__section">
            <h2 className="recipe-view__section-title">{t.prepStepsSection}</h2>

            {ownSteps.length > 0 ? (
              <ol className="recipe-view__steps">
                {ownSteps.map((s, i) => (
                  <li key={s.step_number ?? i} className="recipe-view__step">
                    <span className="recipe-view__step-num">{t.stepLabel} {i + 1}</span>
                    {s.step_name && <strong className="recipe-view__step-name">{s.step_name}</strong>}
                    {s.description && <p className="recipe-view__step-text">{s.description}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              // No own steps: show a single "no preparation steps" line, but
              // only while no base sub-recipe has steps to show below.
              !anySubHasSteps && <p className="recipe-view__substeps-state">{t.noPrepSteps}</p>
            )}

            {/* Base recipes used as sub-recipes — only those WITH steps are
                rendered (empty ones self-hide so there are no blank rows). */}
            {subLines.map((l) => (
              <SubRecipeSteps
                key={l.line_id}
                itemId={l.ingredient_id}
                name={l.ingredient}
                onResolved={(has) =>
                  setSubStepsInfo((prev) => (prev[l.ingredient_id] === has ? prev : { ...prev, [l.ingredient_id]: has }))
                }
              />
            ))}
          </section>
        );
      })()}
    </div>
  );
};

/**
 * Collapsible block showing a base (sub-)recipe's preparation steps.
 * Fetches the sub-recipe's detail eagerly and renders NOTHING when that
 * sub-recipe has no steps (so the section never shows empty rows).  It
 * reports back via onResolved so the parent can decide whether to show a
 * single "no preparation steps" line.
 */
const SubRecipeSteps: React.FC<{ itemId: number; name: string; onResolved: (hasSteps: boolean) => void }> = ({ itemId, name, onResolved }) => {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['bom-detail', itemId],
    queryFn: () => api.getBom(itemId),
    staleTime: 60_000,
    retry: false,
  });
  const steps = (data as BomDetail | undefined)?.steps ?? [];

  useEffect(() => {
    if (data) onResolved(steps.length > 0);
  }, [data, steps.length, onResolved]);

  // Still loading, or this sub-recipe has no steps → render nothing.
  if (!data || steps.length === 0) return null;

  return (
    <div className="recipe-view__substeps">
      <button
        type="button"
        className="recipe-view__substeps-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="recipe-view__sub-pill recipe-view__sub-pill--sub">{t.subRecipe}</span>
        <span className="recipe-view__substeps-name">{name}</span>
        <span className="recipe-view__sub-caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <ol className="recipe-view__steps recipe-view__steps--sub">
          {steps.map((s, i) => (
            <li key={s.step_number ?? i} className="recipe-view__step">
              <span className="recipe-view__step-num">{t.stepLabel} {i + 1}</span>
              {s.step_name && <strong className="recipe-view__step-name">{s.step_name}</strong>}
              {s.description && <p className="recipe-view__step-text">{s.description}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
