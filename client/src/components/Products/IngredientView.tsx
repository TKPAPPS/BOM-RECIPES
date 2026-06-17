import React, { useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { getImageSrc, fmtMoney, CURRENCY_SYMBOL } from '../RecipeBook/imageHelpers';

/** Read-only ingredient (raw material / product) page, opened by clicking
 *  an ingredient name inside a recipe. */
export const IngredientView: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, lang } = useLang();
  const itemId = Number(id);

  const { data: item, isLoading, isError } = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => api.getItem(itemId),
    enabled: Number.isInteger(itemId),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (item) document.title = item.name || 'ingredient';
  }, [item]);

  if (isLoading) return <div className="recipe-view">{t.loading}</div>;
  if (isError || !item) return <div className="recipe-view">{t.failedToLoad}</div>;

  // A recipe-type item has its own (richer) view.
  if (item.item_type === 'recipe') {
    return (
      <div className="recipe-view">
        <p>{t.openBaseRecipe}: <Link to={`/recipes/view/${item.id}`}>{item.name}</Link></p>
      </div>
    );
  }

  const displayName = (lang === 'he' ? item.name_he : item.name_en) || item.name;
  const src = getImageSrc(item.image_url);
  const money = (n: number | string | null | undefined) => `${CURRENCY_SYMBOL}${fmtMoney(n)}`;
  const hasCost = item.cost_per_kg != null;

  return (
    <div className="recipe-view ingredient-view">
      <div className="recipe-view__head">
        <button className="btn btn--ghost" onClick={() => navigate(-1)}>← {t.back}</button>
      </div>

      <div className="recipe-view__hero">
        <div className="recipe-view__hero-media">
          {src
            ? <img src={src} alt={displayName} />
            : <div className="recipe-view__hero-placeholder" aria-hidden="true">{displayName.charAt(0).toUpperCase()}</div>}
        </div>
        <div className="recipe-view__hero-body">
          <h1 className="recipe-view__title">{displayName}</h1>
          {item.reference_code && <p className="recipe-view__ref">{item.reference_code}</p>}
          {item.odoo_archived && <span className="rb-chip">{t.productsArchivedTag}</span>}
        </div>
      </div>

      <section className="recipe-view__section">
        <div className="ingredient-view__grid">
          <div className="ingredient-view__field"><span>{t.ingredient}</span><strong>{displayName}</strong></div>
          <div className="ingredient-view__field"><span>{t.refCode}</span><strong>{item.reference_code || '—'}</strong></div>
          <div className="ingredient-view__field"><span>{t.productsColWeight}</span><strong>{item.uom || 'kg'}</strong></div>
          {hasCost && <div className="ingredient-view__field"><span>{t.costPerKg}</span><strong>{money(item.cost_per_kg)}</strong></div>}
          {item.category_name && <div className="ingredient-view__field"><span>{t.refCodeCategorySelect}</span><strong>{item.category_name}</strong></div>}
        </div>
      </section>
    </div>
  );
};
