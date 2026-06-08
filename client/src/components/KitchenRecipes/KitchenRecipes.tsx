import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useLang } from '../../context/LanguageContext';
import { api } from '../../api';
import { BomHistory } from '../../App';
import type { RecipeType } from '../../types';

/**
 * Kitchen Recipes — unified entry point.  Keeps the "Build new recipe"
 * button, then a two-segment tab header (Base Recipes / Final Products).
 * Each tab shows the full existing recipe list (BomHistory) embedded, so
 * all existing functionality (search, export/import, edit, delete,
 * versions) is preserved in one place.
 */
export const KitchenRecipes: React.FC = () => {
  const { t } = useLang();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab: RecipeType = searchParams.get('tab') === 'final' ? 'final' : 'base';
  const [tab, setTab] = useState<RecipeType>(initialTab);

  // Active (non-archived) recipe counts per type, shown next to each tab.
  // Shares the React Query cache key with the embedded list, so no extra
  // network round-trips once a tab's list has loaded.
  const { data: baseList } = useQuery({
    queryKey: ['boms', 'base', false],
    queryFn: () => api.getBoms('base', { archived: false }),
  });
  const { data: finalList } = useQuery({
    queryKey: ['boms', 'final', false],
    queryFn: () => api.getBoms('final', { archived: false }),
  });
  const baseCount  = baseList?.length;
  const finalCount = finalList?.length;

  // Tab bar rendered INSIDE the list card, between the search toolbar and
  // the table, so: search row → Base/Final tabs (flush) → list.
  const tabs = (
    <div className="kr-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'base'}
        className={`kr-tab${tab === 'base' ? ' kr-tab--active' : ''}`}
        onClick={() => setTab('base')}
      >
        {t.baseRecipes}
        {baseCount != null && <span className="kr-tab__count">{baseCount}</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'final'}
        className={`kr-tab${tab === 'final' ? ' kr-tab--active' : ''}`}
        onClick={() => setTab('final')}
      >
        {t.finalProducts}
        {finalCount != null && <span className="kr-tab__count">{finalCount}</span>}
      </button>
    </div>
  );

  // "Build new recipe" lives in the toolbar, to the right of Import.
  const buildBtn = (
    <button
      className="btn btn--primary rio-toolbar__btn"
      onClick={() => navigate('/recipe/new')}
    >
      + {t.buildNewRecipe}
    </button>
  );

  return (
    <div className="kitchen-recipes">
      <div className="bom-history__header">
        <h2 className="bom-history__title">{t.kitchenRecipes}</h2>
      </div>

      {/* Embedded list — full existing functionality.  The Build button is
          injected into the toolbar (right of Import); the Base/Final tabs
          are injected between the toolbar and the table. */}
      <BomHistory type={tab} embedded tabsSlot={tabs} extraToolbarAction={buildBtn} />
    </div>
  );
};
