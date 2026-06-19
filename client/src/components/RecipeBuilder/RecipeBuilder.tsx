import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useBlocker } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRecipeStore } from '../../stores/useRecipeStore';
import { useBomCost } from '../../hooks/useBomCost';
import { useToastStore } from '../../stores/useToastStore';
import { useLang } from '../../context/LanguageContext';
import { api } from '../../api';
import { IngredientRow } from './IngredientRow';
import { CostDisplay } from './CostDisplay';
import { buildRecipeDraftFromDetail, buildBuilderFromTestRecipe } from './recipeDraft';
import { readImageFileSmart } from '../RecipeBook/imageHelpers';
import type { IngredientLine, TestRecipeDraft } from '../../types';
import { nanoid } from 'nanoid';

// Generous raw-file ceiling.  Above this the server's express.json
// limit (25 MB) starts running out of headroom once the file is
// base64-inflated, so we toast a clear "pick something smaller"
// instead of letting the request 413.
const MAX_RAW_IMAGE_BYTES = 20 * 1024 * 1024;

export const RecipeBuilder: React.FC<{ mode?: 'real' | 'test' }> = ({ mode = 'real' }) => {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate   = useNavigate();
  const isTest = mode === 'test';

  const {
    recipeName,
    referenceCode,
    yieldKg,
    recipeType,
    saleUom,
    lines,
    steps,
    mode: storeMode,
    testId,
    wholesaleMultiplier,
    retailMultiplier,
    wholesaleFormula,
    retailFormula,
    pricingFormulaId,
    laborCost,
    overheadCost,
    packagingCost,
    fullName,
    description,
    imageUrl,
    allergens,
    isSpicy,
    servingSuggestion,
    servingsCount,
    totalWeight,
    isDirty,
    editingItemId,
    setRecipeName,
    setReferenceCode,
    setYield,
    setRecipeType,
    setSaleUom,
    setMultipliers,
    setPricingFormulaId,
    setFullName,
    setDescription,
    setImageUrl,
    setAllergens,
    setIsSpicy,
    setServingSuggestion,
    setServingsCount,
    setTotalWeight,
    addLine,
    removeLine,
    updateLine,
    addStep,
    removeStep,
    updateStep,
    loadBom,
    loadTestDraft,
    startDraft,
    reset,
  } = useRecipeStore();

  const qc    = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const { t } = useLang();

  // Local text mirror for the allergens input so the user can type
  // commas/spaces freely. The store holds the parsed array; the input
  // shows the raw text. We sync from store→input only when they diverge
  // (e.g. loadBom switches to a different recipe).
  const [allergenInput, setAllergenInput] = useState(() => allergens.join(', '));

  useEffect(() => {
    const parsedFromInput = allergenInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const matchesStore =
      parsedFromInput.length === allergens.length &&
      parsedFromInput.every((v, i) => v === allergens[i]);
    if (!matchesStore) {
      setAllergenInput(allergens.join(', '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allergens]);
  const costTier = useBomCost(
    lines, yieldKg,
    wholesaleMultiplier, retailMultiplier,
    laborCost, overheadCost, packagingCost,
    wholesaleFormula, retailFormula
  );

  // ── Load existing BOM when visiting /recipe/:itemId ──────────
  // If the store already represents this itemId, skip the refetch.
  // When switching from one recipe to another, the new loadBom call
  // overwrites the store wholesale.
  useEffect(() => {
    if (!itemId) return;
    const id = parseInt(itemId, 10);
    if (isNaN(id)) return;

    if (isTest) {
      if (storeMode === 'test' && testId === id) return;
      api.getTestRecipe(id).then((detail) => {
        loadTestDraft(buildBuilderFromTestRecipe(detail), id);
      }).catch(() => {
        toast('Load failed', { type: 'error', message: 'Could not load test recipe.' });
        navigate('/test-kitchen');
      });
      return;
    }

    if (storeMode === 'real' && editingItemId === id) return;
    api.getBom(id).then((detail) => {
      const { steps: draftSteps, lines: loadedLines } = buildRecipeDraftFromDetail(detail);
      loadBom(
        {
          steps:             draftSteps,
          recipeName:        detail.recipe_name,
          referenceCode:     detail.reference_code ?? '',
          yieldKg:           detail.yield_kg,
          recipeType:        detail.recipe_type    ?? 'base',
          saleUom:           detail.sale_uom       ?? 'kg',
          laborCost:         detail.labor_cost     ?? 0,
          overheadCost:      detail.overhead_cost  ?? 0,
          packagingCost:     detail.packaging_cost ?? 0,
          fullName:          detail.full_name,
          description:       detail.description,
          imageUrl:          detail.image_url,
          allergens:         detail.allergens,
          isSpicy:           detail.is_spicy,
          servingSuggestion: detail.serving_suggestion,
          servingsCount:     detail.servings_count,
          totalWeight:       detail.total_weight,
          pricingFormulaId:  detail.pricing_formula_id,
          lines:             loadedLines,
        },
        id,
      );
    }).catch(() => {
      toast('Load failed', { type: 'error', message: 'Could not load recipe.' });
      navigate('/recipes');
    });
  }, [itemId, isTest, storeMode, editingItemId, testId, loadBom, loadTestDraft, navigate, toast]);

  // /recipe/new (or /test-recipe/new): start a fresh draft of the right
  // mode when arriving from an edit session or after switching tabs/mode.
  // A same-mode in-progress draft is preserved (survives navigation).
  useEffect(() => {
    if (itemId) return;
    const switchingMode = storeMode !== mode;
    const fromEdit = mode === 'test' ? testId !== null : editingItemId !== null;
    if (switchingMode || fromEdit) startDraft(mode);
  }, [itemId, mode, storeMode, editingItemId, testId, startDraft]);

  // ── Final product = base recipe + packaging ──────────────────
  // A final product carries a base recipe as an ingredient.  When one is
  // present we auto-fill the empty branding fields (name/description/
  // image/allergens/serving) from that base recipe and pull its prep
  // steps down (read-only).  Empty-fields-only so manual edits survive.
  const baseRecipeItemId = recipeType === 'final'
    ? (lines.find((l) => l.item?.type === 'recipe')?.item?.id ?? null)
    : null;
  // Only auto-pull while CREATING a new recipe — editing an existing one
  // keeps its saved branding/steps (avoids clobbering + dirty-on-open).
  const isNewDraft = mode === 'test' ? testId === null : editingItemId === null;
  const pulledBaseRef = useRef<number | null>(null);
  useEffect(() => {
    if (recipeType !== 'final' || baseRecipeItemId == null || !isNewDraft) return;
    if (pulledBaseRef.current === baseRecipeItemId) return;
    pulledBaseRef.current = baseRecipeItemId;
    api.getBom(baseRecipeItemId).then((d) => {
      const st = useRecipeStore.getState();
      if (!st.fullName)          st.setFullName(d.full_name || d.recipe_name || '');
      if (!st.description)       st.setDescription(d.description ?? '');
      if (!st.imageUrl)          st.setImageUrl(d.image_url ?? '');
      if (st.allergens.length === 0 && Array.isArray(d.allergens) && d.allergens.length)
        st.setAllergens(d.allergens);
      if (!st.servingSuggestion && d.serving_suggestion)
        st.setServingSuggestion(d.serving_suggestion);
      st.setIsSpicy(!!d.is_spicy);
      st.setSteps((d.steps ?? []).map((s) => ({
        id: nanoid(), name: s.step_name ?? '', description: s.description ?? '',
      })));
    }).catch(() => { pulledBaseRef.current = null; });
  }, [recipeType, baseRecipeItemId, isNewDraft]);

  // Fetch all available formulas for the Pricing Strategy dropdown
  const { data: formulas = [] } = useQuery({
    queryKey: ['formulas'],
    queryFn: api.getFormulas,
    staleTime: 30_000,
  });

  // Manager-defined reference-code categories (prefixes).  Picking one
  // auto-fills the next free number in that prefix into the code field.
  const { data: refCategories = [] } = useQuery({
    queryKey: ['reference-categories'],
    queryFn: () => api.getReferenceCategories(),
    staleTime: 30_000,
  });

  const handlePickCategory = useCallback(async (prefix: string) => {
    if (!prefix) return;
    try {
      const { code } = await api.getNextReferenceCode(prefix);
      setReferenceCode(code);
      setFieldErrors((prev) => ({ ...prev, referenceCode: false }));
    } catch (err) {
      toast(t.refCodeNextFailed, { type: 'error', message: (err as Error).message });
    }
  }, [setReferenceCode, toast, t]);

  // Live resolver lookup for the loaded recipe — tells us which formula
  // the server would actually apply RIGHT NOW (manual or auto).  Used
  // to surface the stale-pin warning when boms.pricing_formula_id is
  // set but the resolver fell back to auto because the formula was
  // deleted/deactivated.
  const urlItemId = itemId ? parseInt(itemId, 10) : null;
  const { data: resolvedPricing } = useQuery({
    queryKey: ['resolve-pricing', urlItemId, pricingFormulaId],
    queryFn:  () => api.getPricing(urlItemId!),
    enabled:  urlItemId != null && !isNaN(urlItemId),
    staleTime: 15_000,
  });

  const isStalePin =
    pricingFormulaId !== null &&
    resolvedPricing != null &&
    resolvedPricing.selection === 'auto';

  // Resolve pricing for the multipliers shown in CostDisplay
  useEffect(() => {
    if (pricingFormulaId !== null) {
      const selected = formulas.find((f) => f.id === pricingFormulaId);
      if (selected) {
        setMultipliers(selected.wholesale_multiplier, selected.retail_multiplier, selected.wholesale_formula, selected.retail_formula);
      }
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const result = await api.resolvePricing(referenceCode);
        setMultipliers(result.wholesale_multiplier, result.retail_multiplier, result.wholesale_formula, result.retail_formula);
      } catch {
        // silently ignore
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [referenceCode, setMultipliers, pricingFormulaId, formulas]);

  // ── Image upload helper ──────────────────────────────────────
  // Large phone photos used to be rejected at 750 KB.  We now accept
  // anything up to 20 MB raw, and silently downscale oversized photos
  // in-browser (canvas → JPEG ~0.88) so the server-bound payload stays
  // small without losing visible quality.
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_RAW_IMAGE_BYTES) {
      toast('Image too large', {
        type: 'warning',
        message: `Pick an image under ${Math.round(MAX_RAW_IMAGE_BYTES / 1024 / 1024)} MB.`,
      });
      return;
    }
    try {
      const dataUri = await readImageFileSmart(file);
      if (dataUri.startsWith('data:image/')) setImageUrl(dataUri);
    } catch (err) {
      toast('Could not read image', { type: 'error', message: (err as Error).message });
    }
  };

  // ── P3-7: beforeunload guard ─────────────────────────────────
  // bypassGuardRef short-circuits BOTH navigation guards while the
  // post-save redirect runs.  React hasn't re-rendered between
  // reset() and navigate() in the mutation's onSuccess tick, so the
  // useBlocker closure would still see the stale isDirty=true and
  // pop the leave-prompt on a deliberate save.
  const bypassGuardRef = useRef(false);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (bypassGuardRef.current || !isDirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // ── P3-7: React Router in-app navigation guard ───────────────
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !bypassGuardRef.current &&
      isDirty &&
      currentLocation.pathname !== nextLocation.pathname
  );

  useEffect(() => {
    if (blocker.state === 'blocked') {
      const ok = window.confirm('You have unsaved changes. Are you sure you want to leave?');
      if (ok) blocker.proceed();
      else    blocker.reset();
    }
  }, [blocker]);

  // Build the JSONB draft for a TEST recipe from the current store state.
  const buildTestDraft = (): TestRecipeDraft => {
    return {
      yieldKg,
      recipeType,
      full_name:          fullName || null,
      description:        description || null,
      image_url:          imageUrl || null,
      allergens,
      is_spicy:           isSpicy,
      serving_suggestion: servingSuggestion || null,
      servings_count:     servingsCount,
      total_weight:       totalWeight,
      pricing_formula_id: pricingFormulaId,
      labor_cost:         laborCost,
      overhead_cost:      overheadCost,
      packaging_cost:     packagingCost,
      steps: steps.map((st, i) => ({ step_number: i + 1, name: st.name, description: st.description })),
      lines: lines
        .filter((l) => l.item || l.adhocName)
        .map((l) => ({
          step_number:    null,
          item_id:        l.item ? l.item.id : null,
          name:           l.item ? l.item.name : (l.adhocName ?? ''),
          reference:      l.item ? l.item.reference : (l.adhocReference || null),
          cost_per_kg:    l.item ? l.item.cost_per_kg : null,
          unit:           l.item ? l.item.unit : null,
          line_uom:       l.line_uom,
          quantity_kg:    l.quantity_kg,
          quantity_input: l.quantity_input,
          waste_pct:      l.waste_pct,
          is_adhoc:       !l.item,
        })),
    };
  };

  const { mutate: saveRecipe, isPending } = useMutation({
    mutationFn: async () => {
      if (isTest) {
        await api.saveTestRecipe({
          id:             testId,
          name:           recipeName,
          reference_code: referenceCode || null,
          recipe_type:    recipeType,
          draft:          buildTestDraft(),
        });
        return;
      }
      const validLines = lines.filter((l) => l.item && l.quantity_kg > 0);
      await api.saveRecipe({
        // When editing, pin the target item so the server updates
        // THIS recipe in place even if the name changed (the
        // legacy name-based find-or-create created a duplicate
        // whenever the recipe was renamed).
        item_id:            editingItemId,
        name:               recipeName,
        reference_code:     referenceCode,
        yield_kg:           yieldKg,
        labor_cost:         laborCost,
        overhead_cost:      overheadCost,
        packaging_cost:     packagingCost,
        recipe_type:        recipeType,
        full_name:          fullName || null,
        description:        description || null,
        image_url:          imageUrl || null,
        allergens,
        is_spicy:           isSpicy,
        serving_suggestion: servingSuggestion || null,
        servings_count:     servingsCount,
        total_weight:       totalWeight,
        pricing_formula_id: pricingFormulaId,
        sale_uom:           recipeType === 'final' ? saleUom : 'kg',
        lines: validLines.map((l) => ({
          ingredient_item_id: l.item!.id,
          quantity_kg:        l.quantity_kg,
          line_uom:           l.line_uom,
          waste_pct:          l.waste_pct,
          step_number:        null,
        })),
        steps: steps.map((st, i) => ({
          step_number: i + 1,
          step_name:   st.name || null,
          description: st.description || null,
        })),
      });
      return;
    },
    onSuccess: () => {
      const name = recipeName;
      const savedType = recipeType;
      // Disable both navigation guards BEFORE the post-save redirect so
      // the leave-prompt never fires on a deliberate save.  reset()
      // clears the dirty flag + the persisted draft.
      bypassGuardRef.current = true;
      reset();
      if (isTest) {
        qc.invalidateQueries({ queryKey: ['test-recipes'] });
        toast('Test recipe saved', { type: 'success', message: `"${name}" has been saved.` });
        navigate('/test-kitchen');
        return;
      }
      qc.invalidateQueries({ queryKey: ['boms'] });
      qc.invalidateQueries({ queryKey: ['items-search'] });
      toast('Recipe saved', { type: 'success', message: `"${name}" has been saved successfully.` });
      navigate(`/kitchen?tab=${savedType === 'final' ? 'final' : 'base'}`);
    },
    onError: (err: Error) => {
      toast('Save failed', { type: 'error', message: err.message });
    },
  });

  // Test mode: submit a saved draft for the main manager's approval.
  const { mutate: submitForApproval, isPending: isSubmitting } = useMutation({
    mutationFn: () => api.submitTestRecipe(testId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['test-recipes'] });
      bypassGuardRef.current = true;
      reset();
      toast(t.submitForApprovalDone, { type: 'success' });
      navigate('/test-kitchen');
    },
    onError: (err: Error) => toast(t.submitForApprovalFailed, { type: 'error', message: err.message }),
  });

  const handleUpdateLine = useCallback(
    (lineId: string, patch: Partial<IngredientLine>) => updateLine(lineId, patch),
    [updateLine]
  );

  const handleRemoveLine = useCallback(
    (lineId: string) => removeLine(lineId),
    [removeLine]
  );

  const handleYieldChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val > 0) setYield(val);
  };

  // Footer totals — effective quantities (post-waste)
  const validLines = lines.filter((l) => l.item && l.quantity_kg > 0);
  const totalMaterialCost = validLines.reduce((sum, l) => {
    const wasteFactor = 1 - (l.waste_pct || 0) / 100;
    const effectiveQty = l.quantity_kg / (wasteFactor > 0 ? wasteFactor : 1);
    return sum + Number(l.item!.cost_per_kg || 0) * effectiveQty;
  }, 0);

  // ── P3-2: Total recipe cost for % of Cost column ─────────────
  const totalRecipeCost = costTier?.total_cost ?? totalMaterialCost;

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

  // ── Validation error state ────────────────────────────────
  const [fieldErrors, setFieldErrors] = useState<{
    recipeName:     boolean;
    referenceCode:  boolean;
    yieldKg:        boolean;
    emptyIngredients: boolean;
  }>({ recipeName: false, referenceCode: false, yieldKg: false, emptyIngredients: false });

  const [invalidRowIds, setInvalidRowIds] = useState<Set<string>>(new Set());

  const validateForm = (): boolean => {
    // Test recipes are work-in-progress: reference code is optional, and an
    // ingredient counts as "filled" even when it's an ad-hoc (not-yet-real)
    // product.  Real recipes require a real catalogue item per line.
    const isFilled = (l: IngredientLine) => isTest ? (!!l.item || !!l.adhocName) : !!l.item;

    const errors = {
      recipeName:       !recipeName.trim(),
      referenceCode:    isTest ? false : !referenceCode.trim(),
      yieldKg:          isNaN(yieldKg) || yieldKg <= 0,
      emptyIngredients: false,
    };

    const badIds = new Set<string>();
    const completeLines = lines.filter((l) => isFilled(l) && l.quantity_input > 0);

    lines.forEach((l) => {
      const hasQty  = l.quantity_input > 0;
      // A row is invalid only when partially filled (one side set, other missing)
      if (isFilled(l) !== hasQty) badIds.add(l.lineId);
    });

    errors.emptyIngredients = completeLines.length === 0;

    setFieldErrors(errors);
    setInvalidRowIds(badIds);

    const hasError = Object.values(errors).some(Boolean) || badIds.size > 0;
    if (hasError) {
      const messages: string[] = [];
      if (errors.recipeName)       messages.push(t.missingRecipeName);
      if (errors.referenceCode)    messages.push(t.missingReferenceCode);
      if (errors.yieldKg)          messages.push(t.invalidYield);
      if (errors.emptyIngredients) messages.push(t.emptyIngredients);
      if (badIds.size > 0)         messages.push(t.invalidIngredientRow);
      toast(t.validationErrorTitle, { type: 'error', message: messages.join(' ') });
    }
    return !hasError;
  };

  const formulaLabel = (f: typeof formulas[number]) => {
    // Show the actual formula expression (falls back to the multiplier for
    // legacy rows that have no expression).
    const ws = f.wholesale_formula || `cost * ${f.wholesale_multiplier}`;
    const rt = f.retail_formula    || `cost * ${f.retail_multiplier}`;
    const defaultTag = f.is_default ? ' [default]' : '';
    return `${f.name}${defaultTag} — ${ws} / ${rt}`;
  };

  return (
    <div className="recipe-builder">
      <div className="recipe-builder__title-row">
        <button
          type="button"
          className="recipe-builder__back"
          onClick={() => navigate(isTest ? '/test-kitchen' : `/kitchen?tab=${recipeType === 'final' ? 'final' : 'base'}`)}
          title={isTest ? t.testRecipes : t.kitchenRecipes}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          <span>{isTest ? t.testRecipes : t.kitchenRecipes}</span>
        </button>
        <h2 className="recipe-builder__title">{isTest ? t.testRecipes : t.recipeBuilder}</h2>
        {isTest && <span className="recipe-builder__test-badge">{t.testBadge}</span>}
        {isDirty && <span className="recipe-builder__dirty-badge">{t.unsavedChanges}</span>}
      </div>

      {/* ── Recipe Type Toggle ────────────────────────────────── */}
      <div className="recipe-type-toggle" role="group" aria-label={t.recipeTypeLabel}>
        <span className="recipe-type-toggle__label">{t.recipeTypeLabel}:</span>
        <button
          type="button"
          className={`recipe-type-toggle__btn${recipeType === 'base' ? ' recipe-type-toggle__btn--active' : ''}`}
          onClick={() => setRecipeType('base')}
          aria-pressed={recipeType === 'base'}
        >
          {t.baseRecipeOption}
        </button>
        <button
          type="button"
          className={`recipe-type-toggle__btn${recipeType === 'final' ? ' recipe-type-toggle__btn--active' : ''}`}
          onClick={() => setRecipeType('final')}
          aria-pressed={recipeType === 'final'}
        >
          {t.finalProductOption}
        </button>
      </div>

      {/* ── Header: 4 equal-width fields ─────────────────────── */}
      <div className="recipe-builder__header">
        <label className={`recipe-builder__field${fieldErrors.recipeName ? ' recipe-builder__field--error' : ''}`}>
          <span>{t.recipeName}</span>
          <input
            type="text"
            value={recipeName}
            onChange={(e) => { setRecipeName(e.target.value); setFieldErrors((prev) => ({ ...prev, recipeName: false })); }}
            placeholder={t.recipeNamePlaceholder}
            aria-invalid={fieldErrors.recipeName}
          />
        </label>

        <label className={`recipe-builder__field${fieldErrors.referenceCode ? ' recipe-builder__field--error' : ''}`}>
          <span>{t.referenceCode}</span>
          <div className="recipe-builder__refcode-row">
            {/* Base recipes are always BAS; final products use any prefix
                EXCEPT BAS. */}
            {(() => {
              const prefixOptions = recipeType === 'base'
                ? refCategories.filter((c) => c.prefix.toUpperCase() === 'BAS')
                : refCategories.filter((c) => c.prefix.toUpperCase() !== 'BAS');
              return prefixOptions.length > 0 && (
                <select
                  className="recipe-builder__refcode-select"
                  value=""
                  onChange={(e) => { handlePickCategory(e.target.value); e.target.value = ''; }}
                >
                  <option value="">{t.refCodeCategorySelect}</option>
                  {prefixOptions.map((c) => (
                    <option key={c.id} value={c.prefix}>
                      {c.prefix}{c.description ? ` — ${c.description}` : ''}
                    </option>
                  ))}
                </select>
              );
            })()}
            <input
              className="recipe-builder__refcode-input"
              type="text"
              value={referenceCode}
              onChange={(e) => { setReferenceCode(e.target.value); setFieldErrors((prev) => ({ ...prev, referenceCode: false })); }}
              placeholder="e.g. BKY-0001"
              aria-invalid={fieldErrors.referenceCode}
            />
          </div>
        </label>

        <label className={`recipe-builder__field${fieldErrors.yieldKg ? ' recipe-builder__field--error' : ''}`}>
          <span>{t.yieldKg}</span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={yieldKg}
            onChange={(e) => { handleYieldChange(e); setFieldErrors((prev) => ({ ...prev, yieldKg: false })); }}
            onBlur={(e) => {
              const val = parseFloat(e.target.value);
              if (isNaN(val) || val <= 0) setYield(1);
            }}
            aria-invalid={fieldErrors.yieldKg}
          />
        </label>

        {recipeType === 'final' && (
          <label className="recipe-builder__field">
            <span>{t.saleUomLabel}</span>
            <select value={saleUom} onChange={(e) => setSaleUom(e.target.value === 'unit' ? 'unit' : 'kg')}>
              <option value="kg">{t.saleUomKg}</option>
              <option value="unit">{t.saleUomUnit}</option>
            </select>
          </label>
        )}

        {recipeType === 'final' && (
          <label className="recipe-builder__field">
            <span>{t.pricingStrategy}</span>
            <select
              value={pricingFormulaId ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                setPricingFormulaId(val === '' ? null : parseInt(val, 10));
              }}
            >
              <option value="">{t.rbFormulaAuto}</option>
              {formulas.map((f) => (
                <option key={f.id} value={f.id}>
                  {formulaLabel(f)}
                </option>
              ))}
            </select>
            {resolvedPricing && (
              <small className="recipe-builder__formula-meta">
                {t.rbFormulaActiveLabel}:{' '}
                <strong>{resolvedPricing.formula.name ?? 'Default'}</strong>{' '}
                <span className={`rb-pill rb-pill--${resolvedPricing.selection}`}>
                  {resolvedPricing.selection === 'manual' ? t.calcManualOverride : t.calcAutoSelection}
                </span>
              </small>
            )}
            {isStalePin && (
              <small className="recipe-builder__formula-warning">
                ⚠ {t.rbStalePinWarning}
              </small>
            )}
          </label>
        )}
      </div>

      {/* ── Recipe-book card fields (admin-curated branding) ───── */}
      {/* Collapsed by default — kitchen authors focus on the steps below. */}
      <details className="rb-branding">
        <summary className="rb-branding__summary">
          <span className="rb-branding__summary-text">{t.rbBrandingSection}</span>
        </summary>

        <div className="rb-branding__body">
          {/* Row 1: image + identity (name + description) */}
          <div className="rb-branding__hero">
            <label className="rb-branding__image-drop">
              {imageUrl ? (
                <img
                  src={imageUrl.startsWith('data:') || imageUrl.startsWith('http')
                    ? imageUrl
                    : `data:image/png;base64,${imageUrl}`}
                  alt=""
                  className="rb-branding__image-preview"
                />
              ) : (
                <div className="rb-branding__image-placeholder" aria-hidden="true">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                  <span className="rb-branding__image-hint">{t.rbFieldImageHint}</span>
                </div>
              )}
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="rb-branding__image-input"
              />
              {imageUrl && (
                <button
                  type="button"
                  className="rb-branding__image-remove"
                  onClick={(e) => { e.preventDefault(); setImageUrl(''); }}
                  title={t.delete}
                  aria-label={t.delete}
                >
                  ✕
                </button>
              )}
            </label>

            <div className="rb-branding__hero-fields">
              <label className="rb-branding__field">
                <span className="rb-branding__label">{t.rbFieldFullName}</span>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={recipeName || t.recipeNamePlaceholder}
                />
              </label>

              <label className="rb-branding__field">
                <span className="rb-branding__label">{t.rbFieldDescription}</span>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="—"
                />
              </label>
            </div>
          </div>

          {/* Row 2: allergens + spicy toggle */}
          <div className="rb-branding__row rb-branding__row--2-1">
            <label className="rb-branding__field">
              <span className="rb-branding__label">{t.rbFieldAllergens}</span>
              <input
                type="text"
                value={allergenInput}
                onChange={(e) => {
                  const raw = e.target.value;
                  setAllergenInput(raw);
                  setAllergens(
                    raw.split(',').map((s) => s.trim()).filter(Boolean)
                  );
                }}
                placeholder="e.g. gluten, dairy, nuts"
              />
            </label>

            <label className={`rb-branding__toggle ${isSpicy ? 'rb-branding__toggle--on' : ''}`}>
              <input
                type="checkbox"
                checked={isSpicy}
                onChange={(e) => setIsSpicy(e.target.checked)}
              />
              <span className="rb-branding__toggle-track">
                <span className="rb-branding__toggle-knob" />
              </span>
              <span className="rb-branding__toggle-text">
                {t.rbFieldIsSpicy} 🌶
              </span>
            </label>
          </div>

          {/* Row 3: total weight + servings */}
          <div className="rb-branding__row rb-branding__row--1-1">
            <label className="rb-branding__field">
              <span className="rb-branding__label">{t.rbFieldTotalWeight}</span>
              <div className="rb-branding__input-suffix">
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={totalWeight ?? ''}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setTotalWeight(Number.isFinite(v) && v > 0 ? v : null);
                  }}
                  placeholder="0.00"
                />
                <span className="rb-branding__suffix">kg</span>
              </div>
            </label>

            <label className="rb-branding__field">
              <span className="rb-branding__label">{t.rbFieldServingsCount}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={servingsCount ?? ''}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setServingsCount(Number.isFinite(v) && v > 0 ? v : null);
                }}
                placeholder="—"
              />
            </label>
          </div>

          {/* Row 4: serving suggestion */}
          <label className="rb-branding__field">
            <span className="rb-branding__label">{t.rbFieldServingSuggestion}</span>
            <input
              type="text"
              value={servingSuggestion}
              onChange={(e) => setServingSuggestion(e.target.value)}
              placeholder="—"
            />
          </label>
        </div>
      </details>

      <CostDisplay
        tier={costTier}
        yieldKg={yieldKg}
        laborCost={laborCost}
        overheadCost={overheadCost}
        showPricing={recipeType === 'final'}
        saleUom={recipeType === 'final' ? saleUom : 'kg'}
      />

      {/* ── P3-3: Live Cost Preview strip ─────────────────────── */}
      {costTier && (
        <div className="live-cost-bar">
          <span className="live-cost-bar__label">{t.livePreview}</span>
          <span className="live-cost-bar__item">
            <span className="live-cost-bar__name">{t.totalRecipeCost}</span>
            <strong className="live-cost-bar__value">R {fmt(costTier.total_cost)}</strong>
          </span>
          <span className="live-cost-bar__sep" />
          <span className="live-cost-bar__item">
            <span className="live-cost-bar__name">{t.costPerKg}</span>
            <strong className="live-cost-bar__value">R {fmt(costTier.cost_per_kg)}</strong>
          </span>
          <span className="live-cost-bar__sep" />
          <span className="live-cost-bar__item">
            <span className="live-cost-bar__name">{t.yieldLabel}</span>
            <strong className="live-cost-bar__value">{yieldKg} kg</strong>
          </span>
        </div>
      )}

      {/* ── Ingredients (flat list — all ingredients with price + qty) ── */}
      <div className="rb-ingredients">
        <h3 className="rb-steps__title">{t.rbIngredientsHeader}</h3>
        <div className="recipe-builder__table-wrap">
          <table className="ingredient-table">
            <thead>
              <tr>
                <th className="ingredient-table__th ingredient-table__th--thumb" />
                <th className="ingredient-table__th">{t.ingredient}</th>
                <th className="ingredient-table__th">{t.referenceCode}</th>
                <th className="ingredient-table__th ingredient-table__th--num">{t.qty} / UOM</th>
                <th className="ingredient-table__th ingredient-table__th--num">{t.costPerKg}</th>
                <th className="ingredient-table__th ingredient-table__th--num">{t.lineCost}</th>
                <th className="ingredient-table__th ingredient-table__th--num ingredient-table__th--pct">{t.ofCostPct}</th>
                <th className="ingredient-table__th ingredient-table__th--actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const wasteFactor  = 1 - (line.waste_pct || 0) / 100;
                const effectiveQty = line.quantity_kg / (wasteFactor > 0 ? wasteFactor : 1);
                const lineCost     = line.item ? line.item.cost_per_kg * effectiveQty : 0;
                const pct          = totalRecipeCost > 0 ? (lineCost / totalRecipeCost) * 100 : 0;
                return (
                  <IngredientRow
                    key={line.lineId}
                    line={line}
                    onUpdate={(patch) => {
                      handleUpdateLine(line.lineId, patch);
                      if (invalidRowIds.has(line.lineId)) {
                        setInvalidRowIds((prev) => { const s = new Set(prev); s.delete(line.lineId); return s; });
                      }
                    }}
                    onRemove={() => handleRemoveLine(line.lineId)}
                    costPct={pct}
                    hasError={invalidRowIds.has(line.lineId)}
                    allowAdhoc={isTest}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
        <button
          className={`recipe-builder__add-line${fieldErrors.emptyIngredients ? ' recipe-builder__add-line--error' : ''}`}
          onClick={() => { addLine(); setFieldErrors((prev) => ({ ...prev, emptyIngredients: false })); }}
        >
          {t.addIngredient}
        </button>
      </div>

      {/* ── Preparation steps ─────────────────────────────────── */}
      {/* Editable for BOTH base recipes and final products.  A new final
          product auto-fills its steps from the base recipe (see effect
          above), but the author can freely edit/add/remove them here. */}
      <div className="rb-steps">
        <h3 className="rb-steps__title">
          {t.prepStepsSection} <small className="rb-steps__optional">({t.optional})</small>
        </h3>

        {steps.map((step, stepIdx) => (
          <div className="rb-step" key={step.id}>
            <div className="rb-step__head">
              <span className="rb-step__number">{t.stepLabel} {stepIdx + 1}</span>
              <button
                type="button"
                className="rb-step__remove"
                onClick={() => removeStep(step.id)}
                title={t.removeStep}
                aria-label={t.removeStep}
              >
                ✕
              </button>
            </div>

            <label className="rb-step__process">
              <span className="rb-step__process-label">{t.processExplanation}</span>
              <textarea
                rows={3}
                value={step.description}
                onChange={(e) => updateStep(step.id, { description: e.target.value })}
                placeholder=""
              />
            </label>
          </div>
        ))}

        <button className="rb-steps__add btn btn--ghost" onClick={addStep}>
          + {t.addStep}
        </button>
      </div>

      <div className="recipe-builder__actions">
        <button
          onClick={() => {
            reset();
            setFieldErrors({ recipeName: false, referenceCode: false, yieldKg: false, emptyIngredients: false });
            setInvalidRowIds(new Set());
          }}
          className="btn btn--ghost"
        >
          {t.clear}
        </button>
        <button
          onClick={() => { if (validateForm()) saveRecipe(); }}
          disabled={isPending}
          className="btn btn--primary"
        >
          {isPending
            ? <><span className="btn-spinner" aria-hidden="true" /> {t.saving}</>
            : t.saveRecipe}
        </button>
      </div>

      {/* Test mode: send a saved draft to the manager's approval queue. */}
      {isTest && testId != null && (
        <div className="recipe-builder__submit-row">
          <button
            type="button"
            className="btn btn--primary recipe-builder__submit-btn"
            disabled={isSubmitting || isDirty}
            title={isDirty ? t.submitSaveFirst : undefined}
            onClick={() => {
              if (window.confirm(t.submitForApprovalConfirm)) submitForApproval();
            }}
          >
            {isSubmitting
              ? <><span className="btn-spinner" aria-hidden="true" /> {t.saving}</>
              : t.submitForApproval}
          </button>
          {isDirty && <p className="recipe-builder__submit-hint">{t.submitSaveFirst}</p>}
        </div>
      )}
    </div>
  );
};
