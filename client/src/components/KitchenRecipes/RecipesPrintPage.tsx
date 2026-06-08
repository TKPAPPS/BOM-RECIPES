import React, { useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { getImageSrc, fmtQty } from '../RecipeBook/imageHelpers';
import type { BomDetail } from '../../types';

/**
 * Bulk recipe print page.  Reached via /recipes/print?ids=1,2,3 (item ids).
 * Fetches every selected recipe and stacks a full recipe page per recipe
 * with a page-break between them, then auto-opens the browser print dialog
 * once they have all loaded.  Used by the Kitchen Recipes list "Print"
 * bulk action.
 */
export const RecipesPrintPage: React.FC = () => {
  const { t } = useLang();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const ids = (params.get('ids') || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter(Number.isInteger);

  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['bom', id],
      queryFn: () => api.getBom(id),
      staleTime: 60_000,
    })),
  });

  const allDone = results.length > 0 && results.every((r) => r.isSuccess || r.isError);
  const recipes = results.map((r) => r.data).filter(Boolean) as BomDetail[];

  // Auto-trigger the print dialog once, after every recipe has loaded.
  const printedRef = useRef(false);
  useEffect(() => {
    if (allDone && !printedRef.current && recipes.length > 0) {
      printedRef.current = true;
      // Give the DOM a tick to paint images/tables before printing.
      const id = window.setTimeout(() => window.print(), 400);
      return () => window.clearTimeout(id);
    }
  }, [allDone, recipes.length]);

  return (
    <div className="kr-print">
      <div className="kr-print__bar kr-print__no-print">
        <button className="btn btn--ghost" onClick={() => navigate(-1)}>← {t.rbBackToList}</button>
        <span className="kr-print__count">
          {allDone
            ? `${recipes.length} ${recipes.length === 1 ? t.recipe : t.recipes}`
            : t.loading}
        </span>
        <button className="btn btn--primary" onClick={() => window.print()} disabled={!allDone || recipes.length === 0}>
          ⎙ {t.rbViewPrint}
        </button>
      </div>

      {!allDone && <div className="view-placeholder"><p>{t.loading}</p></div>}

      {recipes.map((r, idx) => (
        <article
          className="kr-print__recipe"
          key={r.item_id}
          style={idx < recipes.length - 1 ? { pageBreakAfter: 'always', breakAfter: 'page' } : undefined}
        >
          <header className="kr-print__head">
            {getImageSrc(r.image_url) ? (
              <img className="kr-print__img" src={getImageSrc(r.image_url)!} alt="" />
            ) : (
              <div className="kr-print__img kr-print__img--placeholder" aria-hidden="true">◈</div>
            )}
            <div className="kr-print__head-body">
              <h1 className="kr-print__title">{r.full_name || r.recipe_name}</h1>
              {r.reference_code && <p className="kr-print__ref">{r.reference_code}</p>}
              {r.description && <p className="kr-print__desc">{r.description}</p>}
              <div className="kr-print__chips">
                <span className="kr-print__chip"><strong>{t.yieldKg}:</strong> {fmtQty(r.yield_kg)} kg</span>
                {r.servings_count != null && (
                  <span className="kr-print__chip"><strong>{t.rbServings}:</strong> ~{r.servings_count}</span>
                )}
                {r.is_spicy && <span className="kr-print__chip">🌶 {t.rbSpicyTag}</span>}
                {r.allergens && r.allergens.length > 0 && (
                  <span className="kr-print__chip"><strong>{t.rbAllergenLabel}:</strong> {r.allergens.join(' · ')}</span>
                )}
              </div>
            </div>
          </header>

          <section className="kr-print__section">
            <h2 className="kr-print__section-title">{t.rbIngredientsHeader}</h2>
            <table className="kr-print__table">
              <thead>
                <tr>
                  <th>{t.recipeName}</th>
                  <th>{t.refCode}</th>
                  <th className="kr-print__num">{t.rbQuantityHeader}</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.line_id}>
                    <td>{l.ingredient}</td>
                    <td className="kr-print__cell-ref">{l.reference || ''}</td>
                    <td className="kr-print__num">{fmtQty(l.quantity_kg)} {l.line_uom || 'kg'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {r.steps && r.steps.length > 0 && (
            <section className="kr-print__section">
              <h2 className="kr-print__section-title">{t.prepStepsSection}</h2>
              <ol className="kr-print__steps">
                {r.steps.map((s, i) => (
                  <li key={s.step_number ?? i} className="kr-print__step">
                    {s.step_name && <strong className="kr-print__step-name">{s.step_name}</strong>}
                    {s.description && <p className="kr-print__step-desc">{s.description}</p>}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </article>
      ))}
    </div>
  );
};
