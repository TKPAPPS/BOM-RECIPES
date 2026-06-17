import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { getImageSrc, fmtQty, fmtMoney, CURRENCY_SYMBOL } from './imageHelpers';
import { RecipeCalculator } from './RecipeCalculator';
import type { BomDetail, BomLine, CalcIngredient } from '../../types';

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

  // Which sub-recipe lines are expanded (by line_id).
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (lineId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return next;
    });

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
  const steps = detail.steps ?? [];

  // Print / Save-as-PDF the WHOLE recipe page (hero + ingredients +
  // steps) as shown.  A body class flips the print stylesheet from the
  // calculator's prep-sheet to the full recipe-book detail.
  const handlePrintPage = () => {
    const prevTitle = document.title;
    document.title = (detail.full_name || detail.recipe_name).replace(/[\\/:*?"<>|]/g, '-');
    document.body.classList.add('print-detail');
    const cleanup = () => {
      document.body.classList.remove('print-detail');
      document.title = prevTitle;
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    setTimeout(cleanup, 1500);
  };

  // One ingredient row (+ its sub-recipe expansion when toggled open).
  const renderLineRow = (l: BomLine) => {
    const isRecipe = l.item_type === 'recipe';
    const isOpen = expanded.has(l.line_id);
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
                <span className="recipe-view__ing-name">{l.ingredient}</span>
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
          <td className="recipe-view__ref">{l.reference || ''}</td>
          <td className="recipe-view__num">{`${fmtQty(l.quantity_kg)} kg`}</td>
        </tr>
        {isRecipe && isOpen && (
          <tr className="rb-subrecipe-row">
            <td colSpan={3}>
              <SubRecipeExpansion itemId={l.ingredient_id} quantityKg={l.quantity_kg} />
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  const renderTable = (rows: BomLine[]) => (
    <div className="recipe-view__table-wrap">
      <table className="recipe-view__table">
        <thead>
          <tr>
            <th>{t.ingredient}</th>
            <th>{t.refCode}</th>
            <th className="recipe-view__num">{t.rbQuantityHeader}</th>
          </tr>
        </thead>
        <tbody>{rows.map(renderLineRow)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="rb-detail">
      <div className="rb-detail__back rb-detail__print-bar">
        <Link to="/book" className="rb-detail__back-link">{t.rbBackToList}</Link>
        <div className="rb-detail__print-actions">
          <button type="button" className="recipe-view__action-btn" onClick={handlePrintPage} title={t.rbViewPrintTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            <span>{t.rbViewPrint}</span>
          </button>
          <button type="button" className="recipe-view__action-btn recipe-view__action-btn--pdf" onClick={handlePrintPage} title={t.rbViewPrintTitle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="18" x2="12" y2="12"/>
              <polyline points="9 15 12 12 15 15"/>
            </svg>
            <span>{t.rbViewPdf}</span>
          </button>
        </div>
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

      {/* ── Per-yield ingredients (flat list) ─────────────────── */}
      <section className="rb-detail__ingredients">
        <h2 className="rb-detail__section-title">{t.rbIngredientsHeader}</h2>
        <p className="rb-detail__section-note">
          {t.yieldKg}: {fmtQty(detail.yield_kg)} kg
        </p>
        {renderTable(detail.lines)}
      </section>

      {/* ── Preparation steps (optional instructions) ─────────── */}
      {steps.length > 0 && (
        <section className="rb-detail__ingredients">
          <h2 className="rb-detail__section-title">{t.prepStepsSection}</h2>
          {steps.map((step, idx) => (
            <div className="rb-detail__step" key={step.step_number}>
              <h3 className="rb-detail__step-title">
                <span className="rb-detail__step-num">{t.stepLabel} {idx + 1}</span>
                {step.step_name && <span className="rb-detail__step-name">{step.step_name}</span>}
              </h3>
              {step.description && (
                <p className="rb-detail__step-process">{step.description}</p>
              )}
            </div>
          ))}
        </section>
      )}

      {/* ── Embedded calculator ───────────────────────────── */}
      <RecipeCalculator recipe={detail} />
    </div>
  );
};

/**
 * Expanded breakdown for a single sub-recipe line.  Fetches the
 * sub-recipe scaled to the quantity required by the parent line and
 * renders every ingredient (recursing into deeper sub-recipes) with
 * the scaled quantities — no prices.
 */
export const SubRecipeExpansion: React.FC<{ itemId: number; quantityKg: number }> = ({
  itemId, quantityKg,
}) => {
  const { t } = useLang();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['subrecipe-calc', itemId, quantityKg],
    queryFn: () => api.calculateRecipe(itemId, quantityKg),
    staleTime: 60_000,
  });

  if (isLoading) {
    return <div className="rb-subrecipe rb-subrecipe--state">{t.loading}</div>;
  }
  if (isError || !data) {
    return (
      <div className="rb-subrecipe rb-subrecipe--state">
        {(error as Error)?.message || t.failedToLoad}
      </div>
    );
  }

  return (
    <div className="rb-subrecipe">
      <SubRecipeLines ingredients={data.ingredients} depth={0} />
    </div>
  );
};

const SubRecipeLines: React.FC<{ ingredients: CalcIngredient[]; depth: number }> = ({
  ingredients, depth,
}) => {
  const { t } = useLang();
  return (
    <>
      {ingredients.map((ing) => (
        <React.Fragment key={ing.line_id}>
          <div
            className="rb-subrecipe__row"
            style={depth > 0 ? { paddingInlineStart: depth * 18 } : undefined}
          >
            <div className="recipe-view__ing-cell">
              {getImageSrc(ing.image_url) ? (
                <img className="recipe-view__ing-thumb" src={getImageSrc(ing.image_url)!} alt="" loading="lazy" />
              ) : (
                <span className="recipe-view__ing-thumb recipe-view__ing-thumb--placeholder" aria-hidden="true">
                  {ing.ingredient_name.trim().charAt(0).toUpperCase() || '·'}
                </span>
              )}
              <Link
                to={ing.ingredient_type === 'recipe' ? `/recipes/view/${ing.ingredient_id}` : `/ingredient/${ing.ingredient_id}`}
                className="recipe-view__ing-name recipe-view__ing-name--link"
                title={ing.ingredient_type === 'recipe' ? t.openBaseRecipe : t.openIngredient}
              >
                {ing.ingredient_name}
              </Link>
              {ing.ingredient_type === 'recipe' && (
                <span className="recipe-view__sub-pill">{t.subRecipe}</span>
              )}
            </div>
            <span className="recipe-view__ref">{ing.reference || ''}</span>
            <span className="rb-subrecipe__qty">{fmtQty(ing.scaled_quantity_kg)} kg</span>
            <span className="rb-subrecipe__num">{ing.cost_per_kg != null ? `${CURRENCY_SYMBOL}${fmtMoney(ing.cost_per_kg)}` : ''}</span>
            <span className="rb-subrecipe__num">{ing.line_cost != null ? `${CURRENCY_SYMBOL}${fmtMoney(ing.line_cost)}` : ''}</span>
          </div>
          {ing.ingredient_type === 'recipe' && ing.sub_recipe && (
            <SubRecipeLines ingredients={ing.sub_recipe.ingredients} depth={depth + 1} />
          )}
        </React.Fragment>
      ))}
    </>
  );
};
