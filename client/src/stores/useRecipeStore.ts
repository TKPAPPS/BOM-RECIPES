import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type { IngredientLine, RecipeType } from '../types';

interface RecipeState {
  recipeName: string;
  referenceCode: string;
  yieldKg: number;
  recipeType: RecipeType;
  lines: IngredientLine[];
  wholesaleMultiplier: number;
  retailMultiplier: number;
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
  setMultipliers: (wholesale: number, retail: number) => void;
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
  loadBom: (
    bom: {
      recipeName: string;
      referenceCode: string;
      yieldKg: number;
      recipeType?: RecipeType;
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
    },
    itemId: number | null,
  ) => void;
  reset: () => void;
}

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

const initialState = () => ({
  recipeName: '',
  referenceCode: '',
  yieldKg: 1,
  recipeType: 'base' as RecipeType,
  lines: [emptyLine()],
  wholesaleMultiplier: 2.5,
  retailMultiplier: 5.0,
  pricingFormulaId: null as number | null,
  laborCost: 0,
  overheadCost: 0,
  ...emptyExtras(),
  isDirty: false,
  editingItemId: null as number | null,
});

export const useRecipeStore = create<RecipeState>()(
  persist(
    (set) => ({
      ...initialState(),

      setRecipeName:       (name) => set({ recipeName: name, isDirty: true }),
      setReferenceCode:    (code) => set({ referenceCode: code, isDirty: true }),
      setYield:            (kg)   => set({ yieldKg: kg, isDirty: true }),
      setRecipeType:       (type) => set({ recipeType: type, isDirty: true }),
      setMultipliers:      (wholesale, retail) => set({ wholesaleMultiplier: wholesale, retailMultiplier: retail }),
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

      loadBom: (bom, itemId) =>
        set({
          recipeName:        bom.recipeName,
          referenceCode:     bom.referenceCode,
          yieldKg:           bom.yieldKg,
          recipeType:        bom.recipeType ?? 'base',
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
          lines:             bom.lines,
          isDirty:           false,
          editingItemId:     itemId,
        }),

      reset: () => set(initialState()),
    }),
    {
      name: 'recipe-builder-draft',
      storage: createJSONStorage(() => localStorage),
      // Only persist draft state — i.e. when no specific recipe is
      // being edited.  This makes /recipe/new survive tab switches
      // and refreshes without leaking edits to existing recipes
      // (those are reloaded from the server via loadBom anyway).
      partialize: (state) =>
        state.editingItemId === null
          ? {
              recipeName:        state.recipeName,
              referenceCode:     state.referenceCode,
              yieldKg:           state.yieldKg,
              recipeType:        state.recipeType,
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
              isDirty:           state.isDirty,
              editingItemId:     null,
            }
          : {},
    },
  ),
);
