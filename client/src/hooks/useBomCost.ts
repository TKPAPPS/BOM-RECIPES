import { useMemo } from 'react';
import type { IngredientLine, CostTier } from '../types';
import { evalFormula } from '../utils/formulaEval';

/** Price for a cost: evaluate the formula (exact, incl. rounding) if set, else cost × multiplier. */
function priceFor(formula: string | null | undefined, multiplier: number, cost: number): number {
  if (formula) {
    try {
      const v = evalFormula(formula, { cost });
      if (Number.isFinite(v)) return v;
    } catch { /* fall back to multiplier */ }
  }
  return cost * multiplier;
}

/**
 * Derives all pricing tiers from client-side data including waste and production costs.
 *
 * material_cost    = Σ( effective_qty × cost_per_kg )
 *                    where effective_qty = quantity_kg / (1 - waste_pct / 100)
 * total_cost       = material_cost + labor + overhead + packaging
 * cost_per_kg      = total_cost / yield_kg
 *
 * All numeric inputs are coerced via Number — PG NUMERIC columns deserialize as
 * strings, so unguarded `+` would concatenate ("0.00" + "0.00" → "0.000.00") and
 * propagate NaN through the rest of the chain.
 */
export function useBomCost(
  lines: IngredientLine[],
  yieldKg: number,
  wholesaleMultiplier: number,
  retailMultiplier: number,
  laborCost: number,
  overheadCost: number,
  packagingCost: number = 0,
  wholesaleFormula: string | null = null,
  retailFormula: string | null = null,
): CostTier | null {
  return useMemo(() => {
    const n = (v: unknown): number => {
      if (v === null || v === undefined || v === '') return 0;
      const x = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(x) ? x : 0;
    };

    const yKg = n(yieldKg);
    if (yKg <= 0) return null;

    const materialCost = lines.reduce((acc, line) => {
      if (!line.item) return acc;
      const qty = n(line.quantity_kg);
      if (qty <= 0) return acc;
      const wastePct    = n(line.waste_pct);
      const wasteFactor = 1 - wastePct / 100;
      const effectiveQty = qty / (wasteFactor > 0 ? wasteFactor : 1);
      return acc + n(line.item.cost_per_kg) * effectiveQty;
    }, 0);

    const productionCost = n(laborCost) + n(overheadCost) + n(packagingCost);
    const totalCost = materialCost + productionCost;

    if (totalCost === 0) return null;

    const wsMult = n(wholesaleMultiplier);
    const rtMult = n(retailMultiplier);

    return {
      cost_per_kg:         totalCost / yKg,
      cost_for_yield:      materialCost,
      production_cost:     productionCost,
      total_cost:          totalCost,
      wholesale_for_yield: priceFor(wholesaleFormula, wsMult, totalCost),
      retail_for_yield:    priceFor(retailFormula,    rtMult, totalCost),
    };
  }, [lines, yieldKg, wholesaleMultiplier, retailMultiplier, laborCost, overheadCost, packagingCost, wholesaleFormula, retailFormula]);
}
