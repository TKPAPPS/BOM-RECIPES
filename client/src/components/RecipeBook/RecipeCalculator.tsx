import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import { fmtMoney, fmtQty } from './imageHelpers';
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

  // Show prices ONLY when the server returned them.  This is the
  // contract: server enforces visibility, client trusts what arrives.
  const hasPrices = result?.total_cost != null;

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
            {result.pricing?.formula?.name && (
              <div className="rb-calculator__summary-cell rb-calculator__summary-cell--formula">
                <span>{t.calcFormulaApplied}</span>
                <strong>
                  {result.pricing.formula.name}
                  <small className={`rb-pill rb-pill--${result.pricing.selection}`}>
                    {result.pricing.selection === 'manual' ? t.calcManualOverride : t.calcAutoSelection}
                  </small>
                </strong>
              </div>
            )}
          </div>

          {/* ── Ingredient tree ────────────────────────────── */}
          <CalcTree node={result} level={0} hasPrices={hasPrices} />

          {/* ── Aggregated shopping list ──────────────────── */}
          {result.aggregated_raw_materials && result.aggregated_raw_materials.length > 0 && (
            <div className="rb-calculator__shopping">
              <h4 className="rb-calculator__section-title">{t.calcShoppingList}</h4>
              <p className="rb-calculator__section-note">{t.calcShoppingListNote}</p>
              <table className="rb-calculator__table">
                <thead>
                  <tr>
                    <th>{t.rbIngredientsHeader}</th>
                    <th className="rb-calculator__num">{t.rbQuantityHeader}</th>
                    {hasPrices && <th className="rb-calculator__num">{t.rbLineCostHeader}</th>}
                  </tr>
                </thead>
                <tbody>
                  {result.aggregated_raw_materials.map((m) => (
                    <tr key={m.ingredient_id}>
                      <td>
                        {m.ingredient_name}
                        {m.reference && <small className="rb-calculator__ref"> · {m.reference}</small>}
                      </td>
                      <td className="rb-calculator__num">{fmtQty(m.total_quantity_kg)} kg</td>
                      {hasPrices && (
                        <td className="rb-calculator__num">
                          {m.total_cost != null ? fmtMoney(m.total_cost) : '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Totals ─────────────────────────────────────── */}
          {hasPrices ? (
            <div className="rb-calculator__totals">
              {result.material_cost_total != null && (
                <Total label={t.calcMaterialCost} value={result.material_cost_total} />
              )}
              {(result.labor_cost_total ?? 0) > 0 && (
                <Total label={t.calcLabor} value={result.labor_cost_total} />
              )}
              {(result.overhead_cost_total ?? 0) > 0 && (
                <Total label={t.calcOverhead} value={result.overhead_cost_total} />
              )}
              {(result.packaging_cost_total ?? 0) > 0 && (
                <Total label={t.calcPackaging} value={result.packaging_cost_total} />
              )}
              {result.total_cost != null && (
                <Total label={t.calcTotalCost} value={result.total_cost} grand />
              )}
              {result.wholesale_total != null && (
                <Total label={t.calcWholesaleTotal} value={result.wholesale_total} />
              )}
              {result.retail_total != null && (
                <Total label={t.calcRetailTotal} value={result.retail_total} />
              )}
            </div>
          ) : (
            <p className="rb-calculator__no-prices">{t.calcNoPriceData}</p>
          )}

          {/* ── Print-only DOM (always rendered, screen-hidden) */}
          <PrepSheetPrint
            calc={result}
            recipeMeta={{
              full_name:          recipe.full_name,
              description:        recipe.description,
              allergens:          recipe.allergens,
              is_spicy:           recipe.is_spicy,
              serving_suggestion: recipe.serving_suggestion,
            }}
          />
        </>
      )}
    </section>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────

const Total: React.FC<{ label: string; value: number | null | undefined; grand?: boolean }> = ({
  label, value, grand,
}) => (
  <div className={`rb-calculator__total ${grand ? 'rb-calculator__total--grand' : ''}`}>
    <span>{label}</span>
    <strong>{fmtMoney(value)}</strong>
  </div>
);

/** Recursive ingredient table — nested sub-recipes are rendered
 *  inline with an indent level so the customer sees the full tree.
 */
const CalcTree: React.FC<{
  node: CalcResult;
  level: number;
  hasPrices: boolean;
}> = ({ node, level, hasPrices }) => {
  const { t } = useLang();
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
            {hasPrices && <th className="rb-calculator__num">{t.rbCostPerKgHeader}</th>}
            {hasPrices && <th className="rb-calculator__num">{t.rbLineCostHeader}</th>}
          </tr>
        </thead>
        <tbody>
          {node.ingredients.map((ing: CalcIngredient) => (
            <React.Fragment key={ing.line_id}>
              <tr>
                <td>
                  {ing.ingredient_name}
                  {ing.reference && <small className="rb-calculator__ref"> · {ing.reference}</small>}
                  {ing.ingredient_type === 'recipe' && (
                    <small className="rb-pill rb-pill--sub" style={{ marginInlineStart: 8 }}>
                      ↓
                    </small>
                  )}
                </td>
                <td className="rb-calculator__num">{fmtQty(ing.scaled_quantity_kg)} kg</td>
                {hasPrices && (
                  <td className="rb-calculator__num">
                    {ing.cost_per_kg != null ? fmtMoney(ing.cost_per_kg) : '—'}
                  </td>
                )}
                {hasPrices && (
                  <td className="rb-calculator__num">
                    {ing.line_cost != null ? fmtMoney(ing.line_cost) : '—'}
                  </td>
                )}
              </tr>
              {ing.ingredient_type === 'recipe' && ing.sub_recipe && (
                <tr className="rb-calc-tree__sub-row">
                  <td colSpan={hasPrices ? 5 : 3}>
                    <CalcTree node={ing.sub_recipe} level={level + 1} hasPrices={hasPrices} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
};
