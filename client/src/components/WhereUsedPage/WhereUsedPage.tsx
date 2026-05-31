import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import type { SearchResult } from '../../types';

// ─── Helpers (mirrors IngredientRow) ────────────────────────────────────────

function getImageSrc(url: string | null | boolean): string | null {
  if (!url || url === 'false' || typeof url !== 'string') return null;
  if (url.startsWith('data:image')) return url;
  if (url.length < 100) return null;
  const isJpeg = url.startsWith('/9j/');
  return `data:image/${isJpeg ? 'jpeg' : 'png'};base64,${url}`;
}

function getDisplayName(result: SearchResult, lang: 'en' | 'he'): string {
  if (lang === 'he') return result.name_he || result.name_en || result.name;
  return result.name_en || result.name;
}

const fmtCost = (n: number | string | null | undefined) => {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return num != null && Number.isFinite(num) && num > 0
    ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num)
    : '—';
};

interface DropdownPos { top: number; left: number; width: number }

// ─── ItemSearchCombobox ───────────────────────────────────────────────────────

interface ComboboxProps {
  onSelect: (item: SearchResult) => void;
  placeholder: string;
}

const ItemSearchCombobox: React.FC<ComboboxProps> = ({ onSelect, placeholder }) => {
  const { lang, t } = useLang();
  const [inputValue, setInputValue]     = useState('');
  const [query, setQuery]               = useState('');
  const [open, setOpen]                 = useState(false);
  const [dropdownPos, setDropdownPos]   = useState<DropdownPos>({ top: 0, left: 0, width: 0 });

  const inputRef    = useRef<HTMLInputElement>(null);
  const wrapperRef  = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['items-search', query],
    queryFn: () => api.searchItems(query),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!wrapperRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close on scroll
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', close, true);
  }, [open]);

  const openDropdown = useCallback(() => {
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      setDropdownPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 460) });
    }
    setOpen(true);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      setQuery(val);
      if (val.length >= 2) openDropdown();
      else setOpen(false);
    },
    [openDropdown]
  );

  const handleSelect = useCallback(
    (result: SearchResult) => {
      setInputValue(getDisplayName(result, lang));
      setOpen(false);
      onSelect(result);
    },
    [lang, onSelect]
  );

  const dropdown = open ? createPortal(
    <ul
      ref={dropdownRef}
      className="ingredient-row__dropdown"
      role="listbox"
      style={{
        position: 'fixed',
        top:   dropdownPos.top,
        left:  dropdownPos.left,
        width: dropdownPos.width,
        right: 'auto',
        zIndex: 9999,
      }}
    >
      {isFetching && (
        <li className="ingredient-row__dropdown-item ingredient-row__dropdown-item--loading">
          <span className="btn-spinner btn-spinner--sm" aria-hidden="true" />
          {t.searching}
        </li>
      )}
      {!isFetching && query.trim().length >= 2 && results.length === 0 && (
        <li className="ingredient-row__dropdown-item ingredient-row__dropdown-item--empty">
          {t.noResults}
        </li>
      )}
      {results.map((r) => (
        <li
          key={r.id}
          role="option"
          className="ingredient-row__dropdown-item"
          onMouseDown={() => handleSelect(r)}
        >
          {getImageSrc(r.image_url as string | null) ? (
            <img
              src={getImageSrc(r.image_url as string | null)!}
              alt=""
              className="ingredient-row__dropdown-thumb"
            />
          ) : (
            <span
              className="ingredient-row__dropdown-thumb ingredient-row__dropdown-thumb--placeholder"
              aria-hidden="true"
            />
          )}
          <span className={`ingredient-row__badge ingredient-row__badge--${r.type}`}>
            {r.type === 'recipe' ? t.subRecipe : t.raw}
          </span>
          <span className="ingredient-row__item-name">
            {getDisplayName(r, lang)}
            {r.reference && <span className="ingredient-row__sku">{r.reference}</span>}
          </span>
          <span className="ingredient-row__cost">
            {fmtCost(Number(r.cost_per_kg || 0))}<small>/kg</small>
          </span>
        </li>
      ))}
    </ul>,
    document.body
  ) : null;

  return (
    <div className="where-used__combobox-wrap" ref={wrapperRef}>
      <input
        ref={inputRef}
        className="where-used__search-input ingredient-row__input"
        value={inputValue}
        onChange={handleInputChange}
        onFocus={() => inputValue.length >= 2 && openDropdown()}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        placeholder={placeholder}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-haspopup="listbox"
        autoComplete="off"
      />
      {dropdown}
    </div>
  );
};

// ─── WhereUsedPage ───────────────────────────────────────────────────────────

export const WhereUsedPage: React.FC = () => {
  const { t, lang } = useLang();
  const [selectedItem, setSelectedItem] = useState<SearchResult | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['affected-recipes', selectedItem?.id],
    queryFn: () => api.getAffectedRecipes(selectedItem!.id),
    enabled: selectedItem !== null,
    retry: false,
  });

  const handleSelect = useCallback((item: SearchResult) => {
    setSelectedItem(item);
  }, []);

  return (
    <div className="affected-recipes where-used">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="where-used__header">
        <h2 className="affected-recipes__title">{t.whereUsedTitle}</h2>
        <p className="affected-recipes__desc">{t.whereUsedDesc}</p>
      </div>

      {/* ── Search ─────────────────────────────────────────────── */}
      <div className="affected-recipes__search where-used__search-row">
        <ItemSearchCombobox
          onSelect={handleSelect}
          placeholder={t.whereUsedSearchPlaceholder}
        />
        {isLoading && (
          <span className="btn-spinner btn-spinner--sm where-used__spinner" aria-label={t.searching} />
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────────── */}
      {isError && (
        <p className="affected-recipes__error">
          {(error as Error).message.toLowerCase().includes('not found')
            ? t.whereUsedNotFound
            : (error as Error).message}
        </p>
      )}

      {/* ── Empty prompt ───────────────────────────────────────── */}
      {!selectedItem && !isLoading && (
        <p className="affected-recipes__empty" style={{ marginTop: 24 }}>
          {t.whereUsedNoSelection}
        </p>
      )}

      {/* ── Results ────────────────────────────────────────────── */}
      {data && (
        <div className="affected-recipes__results">
          <p className="affected-recipes__summary">
            <strong>{getDisplayName(selectedItem!, lang)}</strong>
            {' '}
            ({data.item.item_type.replace('_', ' ')})
            {' '}{t.whereUsedUsedInPre}{' '}
            <strong>{data.affected_count}</strong>
            {' '}
            {data.affected_count === 1 ? t.whereUsedUsedInPost : t.whereUsedUsedInPlural}.
          </p>

          {data.affected_count === 0 ? (
            <p className="affected-recipes__empty">{t.whereUsedNotUsed}</p>
          ) : (
            <table className="bom-history__table affected-recipes__table">
              <thead>
                <tr>
                  <th>{t.whereUsedRecipeCol}</th>
                  <th>{t.refCode}</th>
                  <th className="bom-history__num">{t.yieldKg}</th>
                  <th className="bom-history__num">{t.costPerKg}</th>
                  <th className="bom-history__num">{t.ver}</th>
                  <th className="bom-history__num">{t.whereUsedDepthCol}</th>
                </tr>
              </thead>
              <tbody>
                {data.recipes.map((r) => (
                  <tr key={r.item_id}>
                    <td className="bom-history__name">
                      <Link
                        to={`/recipe/${r.item_id}`}
                        className="where-used__recipe-link"
                        title={r.recipe_name}
                      >
                        {r.recipe_name}
                      </Link>
                    </td>
                    <td className="bom-history__ref">{r.reference_code ?? ''}</td>
                    <td className="bom-history__num">{r.yield_kg}</td>
                    <td className="bom-history__num">{fmtCost(r.cost_per_kg)}</td>
                    <td className="bom-history__num">v{r.version}</td>
                    <td className="bom-history__num">
                      {r.depth === 1
                        ? t.whereUsedDirect
                        : `${r.depth} ${t.whereUsedLevels}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};
