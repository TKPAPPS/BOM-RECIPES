import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { getImageSrc, fmtMoney, fmtQty } from './imageHelpers';
import { RecipeCalculator } from './RecipeCalculator';
import type { BomDetail } from '../../types';

/**
 * Customer-facing single-recipe view.
 *
 * Renders the recipe card (image, full_name, description, allergens,
 * spicy tag, total_weight, serving_suggestion, ~servings).  Then an
 * ingredients table for the recipe's NATURAL yield (per-yield qty —
 * NOT scaled), and finally the embedded calculator for scaling.
 *
 * Price columns appear ONLY when the server returned price fields,
 * which it does not for customers without view-price permission.
 */
export const RecipeBookDetail: React.FC = () => {
  const { itemId } = useParams<{ itemId: string }>();
  const id = itemId ? parseInt(itemId) : NaN;
  const { t } = useLang();

  const { data: recipe, isLoading, isError, error } = useQuery({
    queryKey: ['bom-detail', id],
    queryFn: () => api.getBom(id),
    enabled: Number.isFinite(id),
    retry: false,
  });

  if (isLoading) return <div className="view-placeholder"><p>{t.loading}</p></div>;
  if (isError || !recipe) {
    return (
      <div className="view-placeholder">
        <p>{(error as Error)?.message || t.failedToLoad}</p>
        <Link to="/book" className="btn btn--ghost">{t.rbBackToList}</Link>
      </div>
    );
  }

  const detail = recipe as BomDetail;
  const linesHavePrices = detail.lines.some((l) => l.line_cost != null);

  return (
    <div className="rb-detail">
      <div className="rb-detail__back">
        <Link to="/book" className="rb-detail__back-link">{t.rbBackToList}</Link>
      </div>

      {/* ── Hero ───────────────────────────────────────────── */}
      <header className="rb-detail__hero">
        <div className="rb-detail__hero-media">
          {getImageSrc(detail.image_url) ? (
            <img src={getImageSrc(detail.image_url)!} alt={detail.recipe_name} />
          ) : (
            <div className="rb-detail__hero-fallback" aria-hidden="true">◈</div>
          )}
        </div>
        <div className="rb-detail__hero-body">
          <h1 className="rb-detail__title">{detail.full_name || detail.recipe_name}</h1>
          {detail.reference_code && (
            <p className="rb-detail__ref">{detail.reference_code}</p>
          )}
          {detail.description && (
            <p className="rb-detail__desc">{detail.description}</p>
          )}

          <div className="rb-detail__chips">
            {detail.is_spicy && (
              <span className="rb-chip rb-chip--spicy">🌶 {t.rbSpicyTag}</span>
            )}
            {(detail.allergens && detail.allergens.length > 0) && (
              <span className="rb-chip rb-chip--allergens" title={t.rbAllergenLabel}>
                {t.rbAllergenLabel}: {detail.allergens.join(' · ')}
              </span>
            )}
            {detail.total_weight != null && (
              <span className="rb-chip">{t.rbTotalWeight}: {fmtQty(detail.total_weight)} kg</span>
            )}
            {detail.servings_count != null && (
              <span className="rb-chip">{t.rbServings}: ~{detail.servings_count}</span>
            )}
          </div>

          {detail.serving_suggestion && (
            <p className="rb-detail__serving">
              <em>{t.rbServingSuggestion}:</em> {detail.serving_suggestion}
            </p>
          )}
        </div>
      </header>

      {/* ── Per-yield ingredients table ───────────────────── */}
      <section className="rb-detail__ingredients">
        <h2 className="rb-detail__section-title">{t.rbIngredientsHeader}</h2>
        <p className="rb-detail__section-note">
          {t.yieldKg}: {fmtQty(detail.yield_kg)} kg
        </p>
        <table className="rb-calculator__table">
          <thead>
            <tr>
              <th>{t.rbIngredientsHeader}</th>
              <th className="rb-calculator__num">{t.rbQuantityHeader}</th>
              {linesHavePrices && <th className="rb-calculator__num">{t.rbCostPerKgHeader}</th>}
              {linesHavePrices && <th className="rb-calculator__num">{t.rbLineCostHeader}</th>}
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((l) => (
              <tr key={l.line_id}>
                <td>
                  {l.ingredient}
                  {l.reference && <small className="rb-calculator__ref"> · {l.reference}</small>}
                  {l.item_type === 'recipe' && (
                    <small className="rb-pill rb-pill--sub" style={{ marginInlineStart: 8 }}>
                      {t.calcSubRecipeOf}
                    </small>
                  )}
                </td>
                <td className="rb-calculator__num">{fmtQty(l.quantity_kg)} kg</td>
                {linesHavePrices && (
                  <td className="rb-calculator__num">
                    {l.cost_per_kg != null ? fmtMoney(l.cost_per_kg) : '—'}
                  </td>
                )}
                {linesHavePrices && (
                  <td className="rb-calculator__num">
                    {l.line_cost != null ? fmtMoney(l.line_cost) : '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Per-batch additions footer (per-yield) — only if server
            returned the values, which it strips for customers. */}
        {linesHavePrices &&
          ((detail.labor_cost ?? 0) > 0 ||
           (detail.overhead_cost ?? 0) > 0 ||
           (detail.packaging_cost ?? 0) > 0) && (
          <div className="rb-detail__batch-additions">
            <span className="rb-detail__batch-additions-label">{t.rbBatchCostsLabel} ({t.perBatch}):</span>
            <ul>
              {(detail.labor_cost ?? 0) > 0 &&
                <li>{t.labor}: {fmtMoney(detail.labor_cost)}</li>}
              {(detail.overhead_cost ?? 0) > 0 &&
                <li>{t.overhead}: {fmtMoney(detail.overhead_cost)}</li>}
              {(detail.packaging_cost ?? 0) > 0 &&
                <li>{t.calcPackaging}: {fmtMoney(detail.packaging_cost)}</li>}
              {detail.cost_per_kg != null &&
                <li><strong>{t.costPerKg}: {fmtMoney(detail.cost_per_kg)}</strong></li>}
            </ul>
          </div>
        )}
      </section>

      {/* ── Embedded calculator ───────────────────────────── */}
      <RecipeCalculator recipe={detail} />
    </div>
  );
};
