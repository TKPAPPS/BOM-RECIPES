import { nanoid } from 'nanoid';
import type { BomDetail, IngredientLine, RecipeStepDraft, RecipeType, TestRecipeDetail } from '../../types';

/**
 * Turn a server BomDetail into the builder's draft shape: preparation
 * steps + flat ingredient lines tagged with their step.  Legacy recipes
 * with no saved steps collapse into a single default step holding every
 * line.  Shared by RecipeBuilder (edit via URL) and the Edit action in
 * the recipe lists so the two paths never drift.
 */
export function buildRecipeDraftFromDetail(detail: BomDetail): {
  steps: RecipeStepDraft[];
  lines: IngredientLine[];
} {
  // Steps are optional instruction blocks (no ingredients).
  const steps: RecipeStepDraft[] = (detail.steps ?? []).map((s) => ({
    id: nanoid(),
    name: s.step_name ?? '',
    description: s.description ?? '',
  }));

  // Ingredients are a flat list.
  const lines: IngredientLine[] = detail.lines.map((l) => {
    return {
      lineId: nanoid(),
      item: {
        id:            l.ingredient_id,
        name:          l.ingredient,
        name_en:       l.name_en   ?? null,
        name_he:       l.name_he   ?? null,
        reference:     l.reference ?? null,
        type:          l.item_type,
        cost_per_kg:   l.cost_per_kg,
        unit:          l.unit ?? 'kg',
        volume_weight: null,
        image_url:     l.image_url ?? null,
      },
      line_uom:       l.line_uom ?? 'kg',
      waste_pct:      l.waste_pct ?? 0,
      quantity_kg:    l.quantity_kg,
      quantity_input: l.quantity_kg,
    };
  });

  return { steps, lines };
}

/**
 * Map a stored test-recipe (JSONB draft + server resolution) into the
 * builder's loadTestDraft shape.  Lines that resolve to a real item are
 * full ingredients; unresolved/ad-hoc lines keep their free-text name and
 * are flagged red.
 */
export function buildBuilderFromTestRecipe(detail: TestRecipeDetail): {
  recipeName: string;
  referenceCode: string;
  yieldKg: number;
  recipeType: RecipeType;
  laborCost: number;
  overheadCost: number;
  packagingCost: number;
  fullName: string | null;
  description: string | null;
  imageUrl: string | null;
  allergens: string[];
  isSpicy: boolean;
  servingSuggestion: string | null;
  servingsCount: number | null;
  totalWeight: number | null;
  pricingFormulaId: number | null;
  steps: RecipeStepDraft[];
  lines: IngredientLine[];
} {
  const d = detail.draft || ({} as TestRecipeDetail['draft']);
  // Steps are optional instruction blocks (no ingredients).
  const steps: RecipeStepDraft[] = (Array.isArray(d.steps) ? d.steps : []).map((s) => ({
    id: nanoid(),
    name: s.name ?? '',
    description: s.description ?? '',
  }));

  // Ingredients are a flat list.
  const lines: IngredientLine[] = (Array.isArray(d.lines) ? d.lines : []).map((l) => {
    const base = {
      lineId: nanoid(),
      line_uom:       l.line_uom ?? 'kg',
      waste_pct:      l.waste_pct ?? 0,
      quantity_kg:    l.quantity_kg ?? 0,
      quantity_input: l.quantity_input ?? l.quantity_kg ?? 0,
    };
    if (l.resolved_item) {
      const ri = l.resolved_item;
      return {
        ...base,
        item: {
          id:            ri.id,
          name:          ri.name,
          name_en:       null,
          name_he:       null,
          reference:     ri.reference,
          type:          ri.item_type,
          cost_per_kg:   ri.cost_per_kg ?? 0,
          unit:          ri.uom ?? 'kg',
          volume_weight: null,
          image_url:     ri.image_url,
        },
        isRed: false,
      };
    }
    // Unresolved / ad-hoc → red
    return {
      ...base,
      item: null,
      adhocName:      l.name ?? '',
      adhocReference: l.reference ?? '',
      isRed:          true,
    };
  });

  return {
    recipeName:        detail.name,
    referenceCode:     detail.reference_code ?? '',
    yieldKg:           Number(d.yieldKg) > 0 ? Number(d.yieldKg) : 1,
    recipeType:        detail.recipe_type,
    laborCost:         Number(d.labor_cost)     || 0,
    overheadCost:      Number(d.overhead_cost)  || 0,
    packagingCost:     Number(d.packaging_cost) || 0,
    fullName:          d.full_name ?? null,
    description:       d.description ?? null,
    imageUrl:          d.image_url ?? null,
    allergens:         Array.isArray(d.allergens) ? d.allergens : [],
    isSpicy:           !!d.is_spicy,
    servingSuggestion: d.serving_suggestion ?? null,
    servingsCount:     d.servings_count ?? null,
    totalWeight:       d.total_weight ?? null,
    pricingFormulaId:  d.pricing_formula_id ?? null,
    steps,
    lines,
  };
}
