import React, { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { fmtQty } from '../RecipeBook/imageHelpers';
import type { TestDraftLine } from '../../types';

/** Print / Save-as-PDF view for one or more pending test recipes
 *  (route /test-recipes/print?ids=1,2,3). Auto-opens the print dialog. */
export const TestRecipesPrintPage: React.FC = () => {
  const [params] = useSearchParams();
  const { t } = useLang();
  const ids = (params.get('ids') || '').split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);

  const results = useQueries({
    queries: ids.map((id) => ({ queryKey: ['test-recipe', id], queryFn: () => api.getTestRecipe(id), staleTime: 60_000 })),
  });

  const allDone = results.length > 0 && results.every((r) => r.isSuccess || r.isError);

  useEffect(() => {
    if (allDone) { const tm = setTimeout(() => window.print(), 400); return () => clearTimeout(tm); }
  }, [allDone]);

  if (!ids.length) return <div style={{ padding: 24 }}>{t.failedToLoad}</div>;
  if (!allDone) return <div style={{ padding: 24 }}>{t.loading}</div>;

  const lineName = (l: TestDraftLine) => l.resolved_item?.name || l.name || '—';
  const lineRef  = (l: TestDraftLine) => l.resolved_item?.reference || l.reference || '';

  return (
    <div className="tr-print">
      {results.map((r, i) => {
        const d = r.data;
        if (!d) return null;
        const draft = d.draft || {};
        const lines: TestDraftLine[] = Array.isArray(draft.lines) ? draft.lines : [];
        const steps = Array.isArray(draft.steps) ? draft.steps : [];
        return (
          <section className="tr-print__recipe" key={d.id ?? i}>
            <h1 className="tr-print__title">{d.name}</h1>
            <p className="tr-print__meta">
              {d.reference_code ? `${d.reference_code} · ` : ''}
              {d.recipe_type === 'final' ? t.finalProductOption : t.baseRecipeOption}
              {draft.yieldKg ? ` · ${t.yieldKg}: ${fmtQty(draft.yieldKg)} kg` : ''}
            </p>

            <table className="tr-print__table">
              <thead>
                <tr><th>{t.ingredient}</th><th>{t.refCode}</th><th style={{ textAlign: 'end' }}>{t.rbQuantityHeader}</th></tr>
              </thead>
              <tbody>
                {lines.map((l, j) => (
                  <tr key={j}>
                    <td>{lineName(l)}{l.is_red ? ' ⚠' : ''}</td>
                    <td>{lineRef(l)}</td>
                    <td style={{ textAlign: 'end' }}>{fmtQty(l.quantity_kg)} {l.line_uom || 'kg'}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {steps.length > 0 && (
              <div className="tr-print__steps">
                <h2>{t.prepStepsSection}</h2>
                <ol>
                  {steps.map((s, k) => (
                    <li key={k}>{s.name ? <strong>{s.name}: </strong> : null}{s.description}</li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};
