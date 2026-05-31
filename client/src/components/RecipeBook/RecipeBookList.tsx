import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { getImageSrc } from './imageHelpers';
import type { BomSummary, RecipeType } from '../../types';

/**
 * Customer-facing Recipe Book list.
 *
 * Renders one card per recipe with image / name / spicy tag /
 * allergens.  Provides text search + category filter + allergen
 * filter + spicy-only toggle.  Cost / price fields are NEVER read
 * directly here — they are only displayed on the detail view, and
 * even there only when the server returned them (which it won't
 * for customers without view-price permission).
 */
export const RecipeBookList: React.FC = () => {
  const { t } = useLang();
  const [type, setType]               = useState<RecipeType>('final');
  const [search, setSearch]           = useState('');
  const [allergenFilter, setAllergen] = useState<string>('');
  const [spicyOnly, setSpicyOnly]     = useState(false);
  // NOTE: a category filter requires the BOM list to surface
  // category_name (it currently doesn't expose it).  Once the
  // backend GET /api/boms includes category metadata, wire it
  // through here as a select element.

  const { data: recipes = [], isLoading } = useQuery({
    queryKey: ['boms', type],
    queryFn: () => api.getBoms(type),
    staleTime: 30_000,
  });

  // Build filter option sets from the data we actually have.
  // (Category list could also come from /api/categories — but we
  // only want categories that actually have a recipe attached.)
  const allergenOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of recipes) (r.allergens ?? []).forEach((a) => a && set.add(a));
    return [...set].sort();
  }, [recipes]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (recipes as BomSummary[]).filter((r) => {
      if (spicyOnly && !r.is_spicy) return false;
      if (allergenFilter && !(r.allergens ?? []).includes(allergenFilter)) return false;
      if (q) {
        const hay = `${r.recipe_name} ${r.full_name ?? ''} ${r.reference_code ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [recipes, search, allergenFilter, spicyOnly]);

  return (
    <div className="recipe-book">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="recipe-book__header">
        <div>
          <h2 className="recipe-book__title">{t.recipeBook}</h2>
          <p className="recipe-book__subtitle">{t.recipeBookSubtitle}</p>
        </div>

        <div className="recipe-book__type-toggle" role="tablist">
          <button
            role="tab"
            aria-selected={type === 'final'}
            className={`recipe-book__type-btn ${type === 'final' ? 'recipe-book__type-btn--active' : ''}`}
            onClick={() => setType('final')}
          >
            {t.finalProducts}
          </button>
          <button
            role="tab"
            aria-selected={type === 'base'}
            className={`recipe-book__type-btn ${type === 'base' ? 'recipe-book__type-btn--active' : ''}`}
            onClick={() => setType('base')}
          >
            {t.baseRecipes}
          </button>
        </div>
      </header>

      {/* ── Filters bar ──────────────────────────────────────── */}
      <div className="recipe-book__filters">
        <input
          type="search"
          className="recipe-book__search"
          placeholder={t.rbSearchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <label className="recipe-book__filter">
          <span className="recipe-book__filter-label">{t.rbFilterAllergen}</span>
          <select
            value={allergenFilter}
            onChange={(e) => setAllergen(e.target.value)}
          >
            <option value="">{t.rbFilterAll}</option>
            {allergenOptions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>

        <label className="recipe-book__filter recipe-book__filter--toggle">
          <input
            type="checkbox"
            checked={spicyOnly}
            onChange={(e) => setSpicyOnly(e.target.checked)}
          />
          <span>{t.rbFilterSpicy}</span>
        </label>
      </div>

      {/* ── Grid ─────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="recipe-book__grid">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="recipe-card recipe-card--skeleton" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="recipe-book__empty">{t.rbNoRecipes}</p>
      ) : (
        <ul className="recipe-book__grid">
          {filtered.map((r) => (
            <li key={r.id}>
              <Link to={`/book/${r.item_id}`} className="recipe-card">
                <div className="recipe-card__media">
                  {getImageSrc(r.image_url) ? (
                    <img
                      src={getImageSrc(r.image_url)!}
                      alt={r.recipe_name}
                      loading="lazy"
                    />
                  ) : (
                    <div className="recipe-card__media-fallback" aria-hidden="true">
                      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                        <line x1="12" y1="22.08" x2="12" y2="12"/>
                      </svg>
                    </div>
                  )}
                  {r.is_spicy && (
                    <span className="recipe-card__spicy" title={t.rbSpicyTag}>🌶 {t.rbSpicyTag}</span>
                  )}
                </div>
                <div className="recipe-card__body">
                  <h3 className="recipe-card__title">{r.full_name || r.recipe_name}</h3>
                  <p className="recipe-card__ref">{r.reference_code || ' '}</p>
                  <div className="recipe-card__allergens">
                    {r.allergens && r.allergens.length > 0 ? (
                      <>
                        <span className="recipe-card__allergens-label">{t.rbAllergenLabel}:</span>
                        <span className="recipe-card__allergens-list">
                          {r.allergens.join(' · ')}
                        </span>
                      </>
                    ) : (
                      ' '
                    )}
                  </div>
                  <div className="recipe-card__meta">
                    {r.total_weight != null && (
                      <span className="recipe-card__chip">
                        {r.total_weight} kg
                      </span>
                    )}
                    {r.servings_count != null && (
                      <span className="recipe-card__chip">
                        ~{r.servings_count} {t.rbServings.toLowerCase()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="recipe-card__cta">{t.rbViewRecipe} →</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
