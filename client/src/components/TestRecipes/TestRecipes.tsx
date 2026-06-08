import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import type { TestRecipeSummary } from '../../types';

/**
 * Test Recipes landing — a sandbox list mirroring Kitchen Recipes.
 * "Build new recipe" opens the builder in test mode.  Each row shows a
 * red-ingredient badge; a MANAGER can promote a recipe with zero red
 * ingredients into the real Base/Final lists.
 */
export const TestRecipes: React.FC = () => {
  const { t } = useLang();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);

  // Only DRAFT recipes live here; submitted ones move to "Pending Approval".
  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['test-recipes', 'draft'],
    queryFn: () => api.getTestRecipes('draft'),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteTestRecipe(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['test-recipes'] });
      toast(t.testDeleted, { type: 'success' });
    },
    onError: (e: Error) => toast(t.failedToLoad, { type: 'error', message: e.message }),
  });

  const confirmDelete = (r: TestRecipeSummary) => {
    if (window.confirm(`${t.delete} "${r.name}"?`)) del.mutate(r.id);
  };

  return (
    <div className="bom-history">
      <div className="bom-history__header">
        <h2 className="bom-history__title">{t.testRecipes}</h2>
        <button className="btn btn--primary" onClick={() => navigate('/test-recipe/new')}>
          + {t.buildNewRecipe}
        </button>
      </div>
      <p className="bom-history__subtitle">{t.testRecipesHint}</p>

      {isLoading ? (
        <div className="view-placeholder"><p>{t.loading}</p></div>
      ) : recipes.length === 0 ? (
        <div className="view-placeholder"><p>{t.testRecipesEmpty}</p></div>
      ) : (
        <table className="bom-history__table">
          <thead>
            <tr>
              <th>{t.recipeName}</th>
              <th>{t.refCode}</th>
              <th>{t.recipeTypeLabel}</th>
              <th className="bom-history__num">{t.testRedColumn}</th>
              <th style={{ width: 220 }} />
            </tr>
          </thead>
          <tbody>
            {recipes.map((r) => {
              const hasRed = r.red_count > 0;
              return (
                <tr key={r.id}>
                  <td className="bom-history__name">
                    <Link to={`/test-recipe/view/${r.id}`} className="bom-history__name-cell">{r.name}</Link>
                    {r.review_note && (
                      <div className="tr-list-note" title={r.review_note}>
                        ✎ {t.sendBackNoteLabel} {r.review_note}
                      </div>
                    )}
                  </td>
                  <td className="bom-history__ref">{r.reference_code ?? ''}</td>
                  <td>{r.recipe_type === 'final' ? t.finalProductOption : t.baseRecipeOption}</td>
                  <td className="bom-history__num">
                    {hasRed ? (
                      <span className="test-red-badge" title={t.testRedTooltip}>{r.red_count}</span>
                    ) : (
                      <span className="test-ok-badge">✓</span>
                    )}
                  </td>
                  <td className="bom-history__num" style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => navigate(`/test-recipe/${r.id}`)}
                    >
                      {t.edit}
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      style={{ marginInlineStart: 6 }}
                      onClick={() => confirmDelete(r)}
                    >
                      {t.delete}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};
