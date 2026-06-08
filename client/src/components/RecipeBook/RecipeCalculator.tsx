import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import { fmtQty } from './imageHelpers';
import { PrepSheetPrint } from './PrepSheetPrint';
import type { BomDetail, CalcResult, CalcIngredient } from '../../types';

/**
 * Embedded calculator module — sits inside RecipeBookDetail.
 *
 * Workflow:
 *   1. User types a target output weight + clicks Calculate.
 *   2. POST /api/boms/:itemId/calculate runs server-side (audited)
 *      and returns the full scaled tree + aggregated shopping list.
 *   3. We render the tree (top recipe + nested sub-recipes) and the
 *      shopping list.  Price columns appear ONLY when the server
 *      actually included those fields (server enforces visibility;
 *      we don't second-guess).
 *   4. "Print prep sheet" hands the calc result to PrepSheetPrint
 *      and triggers window.print().
 */

interface Props {
  recipe: BomDetail;
}

export const RecipeCalculator: React.FC<Props> = ({ recipe }) => {
  const { t } = useLang();
  const toast = useToastStore((s) => s.push);

  // Default to the recipe's own yield (1× batch) so first click works
  const [weight, setWeight] = useState<string>(String(recipe.yield_kg ?? 1));
  const [result, setResult] = useState<CalcResult | null>(null);

  const { mutate: runCalc, isPending } = useMutation({
    mutationFn: (kg: number) => api.calculateRecipe(recipe.item_id, kg),
    onSuccess: (data) => setResult(data),
    onError: (err: Error) => toast('Calculation failed', { type: 'error', message: err.message }),
  });

  const handleCalc = () => {
    const kg = parseFloat(weight);
    if (!Number.isFinite(kg) || kg <= 0) {
      toast('Invalid weight', { type: 'warning', message: 'Enter a positive number.' });
      return;
    }
    runCalc(kg);
  };

  const handlePrint = () => {
    if (!result) return;
    window.print();
  };

  // Project servings count from the recipe metadata (per-yield) onto
  // the scaled batch so the customer sees "enough for ~N servings"
  // at their requested weight.
  const scaledServings =
    result && recipe.servings_count != null
      ? Math.round(recipe.servings_count * result.scale_factor)
      : null;

  return (
    <section className="rb-calculator">
      <h3 className="rb-calculator__title">{t.calcTitle}</h3>

      <div className="rb-calculator__form">
        <label className="rb-calculator__field">
          <span>{t.calcDesiredWeight}</span>
          <input
            type="number"
            min={0.001}
            step={0.001}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCalc()}
          />
        </label>
        <button
          className="btn btn--primary rb-calculator__run"
          onClick={handleCalc}
          disabled={isPending}
        >
          {isPending ? t.calcRunning : t.calcRun}
        </button>
        {result && (
          <button
            className="btn btn--ghost rb-calculator__print"
            onClick={handlePrint}
            title={t.calcPrintPrepSheet}
          >
            ⎙ {t.calcPrintPrepSheet}
          </button>
        )}
      </div>

      {!result && (
        <p className="rb-calculator__placeholder">{t.calcEnterAmount}</p>
      )}

      {result && (
        <>
          {/* ── Summary header ─────────────────────────────── */}
          <div className="rb-calculator__summary">
            <div className="rb-calculator__summary-cell">
              <span>{t.calcDesiredWeight}</span>
              <strong>{fmtQty(result.desired_weight_kg)} kg</strong>
            </div>
            <div className="rb-calculator__summary-cell">
              <span>{t.calcScaleFactor}</span>
              <strong>×{fmtQty(result.scale_factor, 4)}</strong>
            </div>
            {scaledServings != null && (
              <div className="rb-calculator__summary-cell">
                <span>{t.rbServings}</span>
                <strong>~{scaledServings}</strong>
              </div>
            )}
            <div className="rb-calculator__summary-cell">
              <span>{t.rbSpicyTag}</span>
              <strong>{recipe.is_spicy ? '🌶 ✓' : '✗'}</strong>
            </div>
          </div>

          {recipe.allergens && recipe.allergens.length > 0 && (
            <p className="rb-calculator__allergens">
              <strong>{t.rbAllergenLabel}:</strong> {recipe.allergens.join(' · ')}
            </p>
          )}

          {/* ── Ingredient tree (kitchen view — no prices) ──── */}
          <CalcTree node={result} level={0} />

          {/* ── Print-only DOM (always rendered, screen-hidden) */}
          <PrepSheetPrint
            calc={result}
            recipeMeta={{
              full_name:          recipe.full_name,
              description:        recipe.description,
              allergens:          recipe.allergens,
              is_spicy:           recipe.is_spicy,
              serving_suggestion: recipe.serving_suggestion,
              servings:           scaledServings,
            }}
          />
        </>
      )}
    </section>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────

/** Recursive ingredient table — nested sub-recipes are rendered
 *  inline with an indent level so the kitchen sees the full tree.
 *  Kitchen view: quantities only, no prices.
 */
const CalcTree: React.FC<{
  node: CalcResult;
  level: number;
}> = ({ node, level }) => {
  const { t } = useLang();

  const renderIngredientRow = (ing: CalcIngredient) => (
    <React.Fragment key={ing.line_id}>
      <tr>
        <td>
          {ing.ingredient_name}
          {ing.reference && <small className="rb-calculator__ref"> · {ing.reference}</small>}
          {ing.ingredient_type === 'recipe' && (
            <small className="rb-pill rb-pill--sub" style={{ marginInlineStart: 8 }}>↓</small>
          )}
        </td>
        <td className="rb-calculator__num">{fmtQty(ing.scaled_quantity_kg)} kg</td>
      </tr>
      {ing.ingredient_type === 'recipe' && ing.sub_recipe && (
        <tr className="rb-calc-tree__sub-row">
          <td colSpan={2}>
            <CalcTree node={ing.sub_recipe} level={level + 1} />
          </td>
        </tr>
      )}
    </React.Fragment>
  );

  const steps = node.steps ?? [];

  return (
    <div className={`rb-calc-tree rb-calc-tree--level-${level}`}>
      {level > 0 && (
        <h5 className="rb-calc-tree__sub-header">
          <span className="rb-pill rb-pill--sub">{t.calcSubRecipeOf}</span>
          {node.recipe_name}
          <small> — {fmtQty(node.desired_weight_kg)} kg</small>
        </h5>
      )}
      <table className="rb-calculator__table">
        <thead>
          <tr>
            <th>{t.rbIngredientsHeader}</th>
            <th className="rb-calculator__num">{t.rbQuantityHeader}</th>
          </tr>
        </thead>
        <tbody>
          {node.ingredients.map(renderIngredientRow)}
        </tbody>
      </table>

      {/* Optional preparation-step instructions (no ingredients). */}
      {steps.length > 0 && (
        <div className="rb-calc-steps">
          {steps.map((step, idx) => (
            <div className="rb-calc-step" key={step.step_number}>
              <span className="rb-calc-step-head__num">{t.stepLabel} {idx + 1}</span>
              {step.step_name && <span className="rb-calc-step-head__name"> {step.step_name}</span>}
              {step.description && <p className="rb-calc-step__desc">{step.description}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
