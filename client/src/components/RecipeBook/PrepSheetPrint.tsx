import React from 'react';
import { useLang } from '../../context/LanguageContext';
import { fmtQty } from './imageHelpers';
import type { CalcResult, CalcIngredient } from '../../types';

/**
 * Print-only DOM region.  Rendered always (so window.print() can
 * find it) but visually hidden on screen via .prep-sheet's CSS.
 * Print stylesheet (@media print) flips the visibility so this
 * region is the only thing the printer sees.
 *
 * Drives the browser's native "Print → Save as PDF" → no extra deps.
 */

interface Props {
  calc: CalcResult;
  recipeMeta?: {
    full_name?: string | null;
    description?: string | null;
    allergens?: string[] | null;
    is_spicy?: boolean;
    serving_suggestion?: string | null;
    servings?: number | null;
  };
}

// Flatten the calc tree into rendered rows (top recipe + every sub-
// recipe section), so the prep sheet reads as one continuous list
// instead of a deeply nested tree (better for kitchen use).
interface Section {
  level: number;
  recipeId: number;
  recipeName: string;
  yieldKg: number;
  desiredKg: number;
  scaleFactor: number;
  ingredients: CalcIngredient[];
}

function flattenSections(calc: CalcResult, level = 0, acc: Section[] = []): Section[] {
  acc.push({
    level,
    recipeId: calc.recipe_id,
    recipeName: calc.recipe_name,
    yieldKg: calc.yield_kg,
    desiredKg: calc.desired_weight_kg,
    scaleFactor: calc.scale_factor,
    ingredients: calc.ingredients,
  });
  for (const ing of calc.ingredients) {
    if (ing.ingredient_type === 'recipe' && ing.sub_recipe) {
      flattenSections(ing.sub_recipe, level + 1, acc);
    }
  }
  return acc;
}

export const PrepSheetPrint: React.FC<Props> = ({ calc, recipeMeta }) => {
  const { t } = useLang();
  const sections = flattenSections(calc);

  return (
    <section className="prep-sheet" aria-hidden="true">
      <header className="prep-sheet__head">
        <h1>{recipeMeta?.full_name || calc.recipe_name}</h1>
        <p className="prep-sheet__subtitle">{t.calcPrintingTitle}</p>
        <dl className="prep-sheet__meta">
          <div><dt>{t.calcDesiredWeight}</dt><dd>{fmtQty(calc.desired_weight_kg)} kg</dd></div>
          <div><dt>{t.calcScaleFactor}</dt><dd>×{fmtQty(calc.scale_factor, 4)}</dd></div>
          {recipeMeta?.servings != null && (
            <div><dt>{t.rbServings}</dt><dd>~{recipeMeta.servings}</dd></div>
          )}
          <div><dt>{t.rbSpicyTag}</dt><dd>{recipeMeta?.is_spicy ? '🌶 ✓' : '✗'}</dd></div>
        </dl>
        {recipeMeta?.allergens && recipeMeta.allergens.length > 0 && (
          <p className="prep-sheet__allergens">
            <strong>{t.rbAllergenLabel}:</strong> {recipeMeta.allergens.join(' · ')}
          </p>
        )}
        {recipeMeta?.serving_suggestion && (
          <p className="prep-sheet__serving"><em>{recipeMeta.serving_suggestion}</em></p>
        )}
      </header>

      {/* ── Per-section ingredient breakdown ───────────────── */}
      {sections.map((s, idx) => (
        <section key={`${s.recipeId}-${idx}`} className={`prep-sheet__section prep-sheet__section--level-${s.level}`}>
          <h2 className="prep-sheet__section-title">
            {s.level > 0 && <span className="prep-sheet__pill">{t.calcSubRecipeOf}</span>}
            {s.recipeName}
            <small> — {fmtQty(s.desiredKg)} kg</small>
          </h2>
          <table className="prep-sheet__table">
            <thead>
              <tr>
                <th>{t.rbIngredientsHeader}</th>
                <th className="prep-sheet__num">{t.rbQuantityHeader}</th>
              </tr>
            </thead>
            <tbody>
              {s.ingredients.map((ing) => (
                <tr key={ing.line_id}>
                  <td>
                    {ing.ingredient_type === 'recipe' && (
                      <span className="prep-sheet__pill prep-sheet__pill--sub">↳</span>
                    )}
                    {ing.ingredient_name}
                    {ing.reference && <small className="prep-sheet__ref"> · {ing.reference}</small>}
                  </td>
                  <td className="prep-sheet__num">
                    {fmtQty(ing.scaled_quantity_kg)} kg
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </section>
  );
};
