import React from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { getImageSrc, fmtMoney, fmtQty, toNum } from './imageHelpers';
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
        <Link to="/recipes/final" className="btn btn--ghost">←</Link>
      </div>
    );
  }

  const detail = recipe as BomDetail;
  const backTo = detail.recipe_type === 'base' ? '/recipes/base' : '/recipes/final';
  const backLabel = detail.recipe_type === 'base' ? t.baseRecipes : t.finalProducts;

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
  const money = (n: number | string | null | undefined) => `₪${fmtMoney(n)}`;

  const hasLabor     = has(detail.labor_cost);
  const hasOverhead  = has(detail.overhead_cost);
  const hasPackaging = has(detail.packaging_cost);
  const hasBatchAdditions = hasLabor || hasOverhead || hasPackaging;

  const hasCostPerKg = has(detail.cost_per_kg);
  const hasTotalCost = has(summary?.total_cost);
  const hasTkp       = has(summary?.wholesale_for_yield);
  const hasSelling   = has(summary?.retail_for_yield);
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
          <button
            type="button"
            className="recipe-view__action-btn"
            onClick={handlePrint}
            title={t.rbViewPrintTitle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            <span>{t.rbViewPrint}</span>
          </button>

          <button
            type="button"
            className="recipe-view__action-btn recipe-view__action-btn--pdf"
            onClick={handlePrint}
            title={t.rbViewPrintTitle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <polyline points="9 15 12 12 15 15"/>
            </svg>
            <span>{t.rbViewPdf}</span>
          </button>

          <Link to={`/recipe/${detail.item_id}`} className="btn btn--ghost recipe-view__edit-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            <span>{t.edit}</span>
          </Link>
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
        return (
          <section className="recipe-view__section">
            <h2 className="recipe-view__section-title">{t.rbIngredientsHeader}</h2>
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
                  {detail.lines.map((l) => (
                    <tr key={l.line_id}>
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
                            <span className="recipe-view__ing-name">{l.ingredient}</span>
                            {l.item_type === 'recipe' && (
                              <span className="recipe-view__sub-pill">{t.subRecipe}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      {showRef    && <td className="recipe-view__ref">{l.reference || ''}</td>}
                      <td className="recipe-view__num">{has(l.quantity_kg) ? `${fmtQty(l.quantity_kg)} kg` : ''}</td>
                      {showCostKg && <td className="recipe-view__num">{has(l.cost_per_kg) ? money(l.cost_per_kg) : ''}</td>}
                      {showLine   && <td className="recipe-view__num recipe-view__num--price">{has(l.line_cost) ? money(l.line_cost) : ''}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}
    </div>
  );
};
