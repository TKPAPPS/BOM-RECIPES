import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import type { TestRecipeSummary } from '../../types';
import { useToastStore } from '../../stores/useToastStore';

/**
 * Pending Approval — manager-only review queue.  Test recipes submitted
 * by authors land here.  The manager reviews; once no ingredient is red
 * (all products exist in the catalogue), Approve promotes the recipe into
 * the real Base/Final list and removes it from the test sandbox.
 */
export const PendingApproval: React.FC = () => {
  const { t } = useLang();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);

  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['test-recipes', 'pending'],
    queryFn: () => api.getTestRecipes('pending'),
  });

  const approve = useMutation({
    mutationFn: (id: number) => api.promoteTestRecipe(id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['test-recipes'] });
      qc.invalidateQueries({ queryKey: ['boms'] });
      toast(t.promoteDone, {
        type: 'success',
        message: data.recipe_type === 'final' ? t.finalProductOption : t.baseRecipeOption,
      });
    },
    onError: (e: Error) => toast(t.promoteFailed, { type: 'error', message: e.message }),
  });

  return (
    <div className="bom-history">
      <div className="bom-history__header">
        <h2 className="bom-history__title">{t.pendingApproval}</h2>
      </div>
      <p className="bom-history__subtitle">{t.pendingApprovalHint}</p>

      {isLoading ? (
        <div className="view-placeholder"><p>{t.loading}</p></div>
      ) : recipes.length === 0 ? (
        <div className="view-placeholder"><p>{t.pendingApprovalEmpty}</p></div>
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
            {recipes.map((r: TestRecipeSummary) => {
              const hasRed = r.red_count > 0;
              return (
                <tr key={r.id}>
                  <td className="bom-history__name">
                    <Link to={`/test-recipe/view/${r.id}`} className="bom-history__name-cell">{r.name}</Link>
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
                      className="btn btn--primary btn--sm"
                      style={{ marginInlineStart: 6 }}
                      disabled={hasRed || approve.isPending}
                      title={hasRed ? t.promoteBlockedRed : t.approveRecipe}
                      onClick={() => {
                        if (window.confirm(t.approveConfirm.replace('{name}', r.name))) {
                          approve.mutate(r.id);
                        }
                      }}
                    >
                      {t.approveRecipe}
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
