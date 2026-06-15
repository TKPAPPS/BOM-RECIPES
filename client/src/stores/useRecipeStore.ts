import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type { IngredientLine, RecipeStepDraft, RecipeType } from '../types';

interface RecipeState {
  recipeName: string;
  referenceCode: string;
  yieldKg: number;
  recipeType: RecipeType;
  saleUom: 'kg' | 'unit';
  lines: IngredientLine[];
  /** Preparation steps (Kitchen Recipes). Every line belongs to one step. */
  steps: RecipeStepDraft[];
  wholesaleMultiplier: number;
  retailMultiplier: number;
  /** Active formula expressions for the live preview (exact, incl. rounding). */
  wholesaleFormula: string | null;
  retailFormula: string | null;
  pricingFormulaId: number | null;
  // P2-3: per-batch production costs
  laborCost: number;
  overheadCost: number;
  packagingCost: number;
  // STEP 1 recipe-book / branding fields
  fullName: string;
  description: string;
  imageUrl: string;          // data URI or absolute URL — sent to items.image_url
  allergens: string[];
  isSpicy: boolean;
  servingSuggestion: string;
  servingsCount: number | null;
  totalWeight: number | null;
  // Builder mode: 'real' edits real recipes (→ /boms); 'test' edits
  // sandbox test recipes (→ /test-recipes) and allows ad-hoc ingredients.
  mode: 'real' | 'test';
  // When editing a test recipe, the test_recipes.id; null for a new draft.
  testId: number | null;
  // P3-7: dirty tracking
  isDirty: boolean;
  // Which itemId the current store contents represent.  `null` means
  // the contents are a draft for /recipe/new (so they should be
  // persisted across navigation); a number means we're editing that
  // specific recipe (so loadBom is the source of truth and visiting
  // /recipe/new should start a fresh draft).
  editingItemId: number | null;
  setRecipeName: (name: string) => void;
  setReferenceCode: (code: string) => void;
  setYield: (kg: number) => void;
  setRecipeType: (type: RecipeType) => void;
  setSaleUom: (v: 'kg' | 'unit') => void;
  setMultipliers: (wholesale: number, retail: number, wholesaleFormula?: string | null, retailFormula?: string | null) => void;
  setPricingFormulaId: (id: number | null) => void;
  setLaborCost: (v: number) => void;
  setOverheadCost: (v: number) => void;
  setPackagingCost: (v: number) => void;
  setFullName: (v: string) => void;
  setDescription: (v: string) => void;
  setImageUrl: (v: string) => void;
  setAllergens: (v: string[]) => void;
  setIsSpicy: (v: boolean) => void;
  setServingSuggestion: (v: string) => void;
  setServingsCount: (v: number | null) => void;
  setTotalWeight: (v: number | null) => void;
  addLine: () => void;
  removeLine: (lineId: string) => void;
  updateLine: (lineId: string, patch: Partial<IngredientLine>) => void;
  addStep: () => void;
  removeStep: (stepId: string) => void;
  updateStep: (stepId: string, patch: Partial<Omit<RecipeStepDraft, 'id'>>) => void;
  /** Replace all steps (e.g. final products pull steps from a base recipe). */
  setSteps: (steps: RecipeStepDraft[]) => void;
  loadBom: (
    bom: {
      recipeName: string;
      referenceCode: string;
      yieldKg: number;
      recipeType?: RecipeType;
      saleUom?: 'kg' | 'unit';
      laborCost?: number;
      overheadCost?: number;
      packagingCost?: number;
      fullName?: string | null;
      description?: string | null;
      imageUrl?: string | null;
      allergens?: string[] | null;
      isSpicy?: boolean;
      servingSuggestion?: string | null;
      servingsCount?: number | null;
      totalWeight?: number | null;
      pricingFormulaId?: number | null;
      lines: IngredientLine[];
      steps: RecipeStepDraft[];
    },
    itemId: number | null,
  ) => void;
  /** Load a test-recipe draft into the builder (mode='test'). */
  loadTestDraft: (
    bom: {
      recipeName: string;
      referenceCode: string;
      yieldKg: number;
      recipeType?: RecipeType;
      saleUom?: 'kg' | 'unit';
      laborCost?: number;
      overheadCost?: number;
      packagingCost?: number;
      fullName?: string | null;
      description?: string | null;
      imageUrl?: string | null;
      allergens?: string[] | null;
      isSpicy?: boolean;
      servingSuggestion?: string | null;
      servingsCount?: number | null;
      totalWeight?: number | null;
      pricingFormulaId?: number | null;
      lines: IngredientLine[];
      steps: RecipeStepDraft[];
    },
    testId: number | null,
  ) => void;
  /** Reset to a fresh empty draft for the given mode. */
  startDraft: (mode: 'real' | 'test') => void;
  reset: () => void;
}

const emptyStep = (): RecipeStepDraft => ({ id: nanoid(), name: '', description: '' });

const emptyLine = (): IngredientLine => ({
  lineId: nanoid(),
  item: null,
  quantity_input: 0,
  quantity_kg: 0,
  line_uom: 'kg',
  waste_pct: 0,
});

const emptyExtras = () => ({
  packagingCost:     0,
  fullName:          '',
  description:       '',
  imageUrl:          '',
  allergens:         [] as string[],
  isSpicy:           false,
  servingSuggestion: '',
  servingsCount:     null as number | null,
  totalWeight:       null as number | null,
});

const initialState = (mode: 'real' | 'test' = 'real') => {
  return {
    recipeName: '',
    referenceCode: '',
    yieldKg: 1,
    recipeType: 'base' as RecipeType,
    saleUom: 'kg' as 'kg' | 'unit',
    // Preparation steps are OPTIONAL instructions — start with none.
    steps: [] as RecipeStepDraft[],
    lines: [emptyLine()],
    wholesaleMultiplier: 2.5,
    wholesaleFormula: null as string | null,
    retailFormula: null as string | null,
    retailMultiplier: 5.0,
    pricingFormulaId: null as number | null,
    laborCost: 0,
    overheadCost: 0,
    ...emptyExtras(),
    mode,
    testId: null as number | null,
    isDirty: false,
    editingItemId: null as number | null,
  };
};

export const useRecipeStore = create<RecipeState>()(
  persist(
    (set) => ({
      ...initialState(),

      setRecipeName:       (name) => set({ recipeName: name, isDirty: true }),
      setReferenceCode:    (code) => set({ referenceCode: code, isDirty: true }),
      setYield:            (kg)   => set({ yieldKg: kg, isDirty: true }),
      setRecipeType:       (type) => set({ recipeType: type, isDirty: true }),
      setSaleUom:          (v)    => set({ saleUom: v, isDirty: true }),
      setMultipliers:      (wholesale, retail, wf = null, rf = null) => set({ wholesaleMultiplier: wholesale, retailMultiplier: retail, wholesaleFormula: wf, retailFormula: rf }),
      setPricingFormulaId: (id)   => set({ pricingFormulaId: id, isDirty: true }),
      setLaborCost:        (v)    => set({ laborCost: v, isDirty: true }),
      setOverheadCost:     (v)    => set({ overheadCost: v, isDirty: true }),
      setPackagingCost:    (v)    => set({ packagingCost: v, isDirty: true }),
      setFullName:         (v)    => set({ fullName: v, isDirty: true }),
      setDescription:      (v)    => set({ description: v, isDirty: true }),
      setImageUrl:         (v)    => set({ imageUrl: v, isDirty: true }),
      setAllergens:        (v)    => set({ allergens: v, isDirty: true }),
      setIsSpicy:          (v)    => set({ isSpicy: v, isDirty: true }),
      setServingSuggestion:(v)    => set({ servingSuggestion: v, isDirty: true }),
      setServingsCount:    (v)    => set({ servingsCount: v, isDirty: true }),
      setTotalWeight:      (v)    => set({ totalWeight: v, isDirty: true }),

      addLine: () =>
        set((s) => ({ lines: [...s.lines, emptyLine()], isDirty: true })),

      removeLine: (lineId) =>
        set((s) => ({ lines: s.lines.filter((l) => l.lineId !== lineId), isDirty: true })),

      updateLine: (lineId, patch) =>
        set((s) => ({
          lines: s.lines.map((l) =>
            l.lineId === lineId ? { ...l, ...patch } : l
          ),
          isDirty: true,
        })),

      // Steps are optional instructions (name + description); they no
      // longer carry their own ingredients.
      addStep: () =>
        set((s) => ({ steps: [...s.steps, emptyStep()], isDirty: true })),

      removeStep: (stepId) =>
        set((s) => ({
          steps: s.steps.filter((st) => st.id !== stepId),
          isDirty: true,
        })),

      setSteps: (steps) => set({ steps, isDirty: true }),

      updateStep: (stepId, patch) =>
        set((s) => ({
          steps: s.steps.map((st) => (st.id === stepId ? { ...st, ...patch } : st)),
          isDirty: true,
        })),

      loadBom: (bom, itemId) =>
        set({
          recipeName:        bom.recipeName,
          referenceCode:     bom.referenceCode,
          yieldKg:           bom.yieldKg,
          recipeType:        bom.recipeType ?? 'base',
          saleUom:           bom.saleUom ?? 'kg',
          laborCost:         bom.laborCost     ?? 0,
          overheadCost:      bom.overheadCost  ?? 0,
          packagingCost:     bom.packagingCost ?? 0,
          fullName:          bom.fullName     ?? '',
          description:       bom.description  ?? '',
          imageUrl:          bom.imageUrl     ?? '',
          allergens:         bom.allergens    ?? [],
          isSpicy:           bom.isSpicy      ?? false,
          servingSuggestion: bom.servingSuggestion ?? '',
          servingsCount:     bom.servingsCount ?? null,
          totalWeight:       bom.totalWeight   ?? null,
          pricingFormulaId:  bom.pricingFormulaId ?? null,
          steps:             bom.steps,
          lines:             bom.lines,
          mode:              'real',
          testId:            null,
          isDirty:           false,
          editingItemId:     itemId,
        }),

      loadTestDraft: (bom, testId) =>
        set({
          recipeName:        bom.recipeName,
          referenceCode:     bom.referenceCode,
          yieldKg:           bom.yieldKg,
          recipeType:        bom.recipeType ?? 'base',
          saleUom:           bom.saleUom ?? 'kg',
          laborCost:         bom.laborCost     ?? 0,
          overheadCost:      bom.overheadCost  ?? 0,
          packagingCost:     bom.packagingCost ?? 0,
          fullName:          bom.fullName     ?? '',
          description:       bom.description  ?? '',
          imageUrl:          bom.imageUrl     ?? '',
          allergens:         bom.allergens    ?? [],
          isSpicy:           bom.isSpicy      ?? false,
          servingSuggestion: bom.servingSuggestion ?? '',
          servingsCount:     bom.servingsCount ?? null,
          totalWeight:       bom.totalWeight   ?? null,
          pricingFormulaId:  bom.pricingFormulaId ?? null,
          steps:             bom.steps,
          lines:             bom.lines,
          mode:              'test',
          testId,
          isDirty:           false,
          editingItemId:     null,
        }),

      startDraft: (mode) => set(initialState(mode)),

      reset: () => set(initialState()),
    }),
    {
      name: 'recipe-builder-draft',
      storage: createJSONStorage(() => localStorage),
      // Only persist draft state — i.e. when no specific recipe is
      // being edited.  This makes /recipe/new survive tab switches
      // and refreshes without leaking edits to existing recipes
      // (those are reloaded from the server via loadBom anyway).
      partialize: (state) => {
        // Persist only NEW drafts (not edits of a saved record), so the
        // /recipe/new and /test-recipe/new forms survive navigation.
        const isNewDraft =
          state.mode === 'test' ? state.testId === null : state.editingItemId === null;
        return isNewDraft
          ? {
              recipeName:        state.recipeName,
              referenceCode:     state.referenceCode,
              yieldKg:           state.yieldKg,
              recipeType:        state.recipeType,
              saleUom:           state.saleUom,
              steps:             state.steps,
              lines:             state.lines,
              pricingFormulaId:  state.pricingFormulaId,
              laborCost:         state.laborCost,
              overheadCost:      state.overheadCost,
              packagingCost:     state.packagingCost,
              fullName:          state.fullName,
              description:       state.description,
              imageUrl:          state.imageUrl,
              allergens:         state.allergens,
              isSpicy:           state.isSpicy,
              servingSuggestion: state.servingSuggestion,
              servingsCount:     state.servingsCount,
              totalWeight:       state.totalWeight,
              mode:              state.mode,
              testId:            null,
              isDirty:           state.isDirty,
              editingItemId:     null,
            }
          : {};
      },
    },
  ),
);
