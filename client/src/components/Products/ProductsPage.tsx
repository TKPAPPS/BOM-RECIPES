import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import type { ProductRow, WeightSource } from '../../types';

// Distinct accent for values that came from the regex fallback.
// Kept inline (not a CSS var) so it stays clearly distinguishable
// from the existing "stored vs computed" muted-grey tag.
const ESTIMATED_COLOR = '#1d4ed8'; // blue-700

type SortKey =
  | 'name'
  | 'reference'
  | 'volume_weight'
  | 'raw_cost'
  | 'cost_per_kg';
type SortDir = 'asc' | 'desc';

function getImageSrc(url: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:image')) return url;
  if (url.length < 100) return null;
  const isJpeg = url.startsWith('/9j/');
  return `data:image/${isJpeg ? 'jpeg' : 'png'};base64,${url}`;
}

const fmtNum = (n: number | string | null | undefined, digits = 2) => {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return num != null && Number.isFinite(num)
    ? new Intl.NumberFormat('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(num)
    : '—';
};

function getDisplayName(p: ProductRow, lang: 'en' | 'he'): string {
  if (lang === 'he') return p.name_he || p.name_en || p.name;
  return p.name_en || p.name;
}

/**
 * Per the spec: prefer the stored cost_per_kg when present, otherwise
 * fall back to the live row-level recompute (raw_cost / weight_in_grams * 1000).
 * Returns the chosen value plus a flag of which source was used so we can
 * be explicit in the UI.
 *
 * `weightSource` is the SEPARATE axis (origin of the weight: Odoo vs name-regex).
 * It is carried through here so the cell can be color-coded blue when the
 * cost-per-kg was derived from a regex-extracted weight, regardless of
 * whether the numeric value itself came from items.cost_per_kg or a live
 * recompute.
 */
function resolveCostPerKg(p: ProductRow): {
  value: number | null;
  source: 'stored' | 'computed' | 'missing';
  weightSource: WeightSource;
} {
  const weightSource = p.cost_per_kg_source ?? 'none';
  if (p.cost_per_kg_stored != null && Number.isFinite(p.cost_per_kg_stored)) {
    return { value: p.cost_per_kg_stored, source: 'stored', weightSource };
  }
  if (p.cost_per_kg_computed != null && Number.isFinite(p.cost_per_kg_computed)) {
    return { value: p.cost_per_kg_computed, source: 'computed', weightSource };
  }
  return { value: null, source: 'missing', weightSource };
}

/**
 * Render the weight cell.  When the weight came from Odoo we show
 * kg in the normal color; when it came from the name-regex fallback
 * we show grams (or kg, whichever is more natural) in blue with a
 * tooltip flagging it as estimated.
 */
function renderWeight(p: ProductRow, t: ReturnType<typeof useLang>['t']) {
  if (p.weight_source === 'odoo' && p.volume_weight != null && p.volume_weight > 0) {
    return (
      <>
        {fmtNum(p.volume_weight, 3)} <small>{p.uom || 'kg'}</small>
      </>
    );
  }
  if (p.weight_source === 'name_regex' && p.weight_extracted_grams != null) {
    const grams = p.weight_extracted_grams;
    // Display in kg when ≥1000 g for readability; otherwise grams.
    const display = grams >= 1000
      ? <>{fmtNum(grams / 1000, 3)} <small>kg</small></>
      : <>{fmtNum(grams, 0)} <small>g</small></>;
    return (
      <span
        style={{ color: ESTIMATED_COLOR, fontWeight: 500 }}
        title={t.productsWeightFromRegex}
      >
        {display}
        <small style={{ marginLeft: 4, color: ESTIMATED_COLOR }}>
          {t.productsEstimatedTag}
        </small>
      </span>
    );
  }
  return (
    <span title={t.productsWeightMissing} style={{ color: 'var(--text-muted)' }}>
      —
    </span>
  );
}

export const ProductsPage: React.FC = () => {
  const { t, lang } = useLang();
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const { data: products, isLoading, isError, error } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.getProducts(),
  });

  const filtered = useMemo(() => {
    if (!products) return [];
    const q = search.trim().toLowerCase();
    const matches = q.length === 0
      ? products
      : products.filter((p) => {
          const display = getDisplayName(p, lang).toLowerCase();
          const ref = (p.reference ?? '').toLowerCase();
          return display.includes(q) || ref.includes(q);
        });

    const dir = sortDir === 'asc' ? 1 : -1;
    const sorted = [...matches].sort((a, b) => {
      const aRes = resolveCostPerKg(a);
      const bRes = resolveCostPerKg(b);
      switch (sortKey) {
        case 'name': {
          return dir * getDisplayName(a, lang).localeCompare(getDisplayName(b, lang));
        }
        case 'reference': {
          return dir * (a.reference ?? '').localeCompare(b.reference ?? '');
        }
        case 'volume_weight': {
          // Sort by effective weight (Odoo > regex fallback) so estimated
          // rows still slot into a sensible numeric position rather than
          // collapsing to the "missing" bucket.
          const aw = a.effective_weight_grams ?? -1;
          const bw = b.effective_weight_grams ?? -1;
          return dir * (aw - bw);
        }
        case 'raw_cost':
          return dir * ((a.raw_cost ?? -1) - (b.raw_cost ?? -1));
        case 'cost_per_kg':
          return dir * ((aRes.value ?? -1) - (bRes.value ?? -1));
        default:
          return 0;
      }
    });
    return sorted;
  }, [products, search, sortKey, sortDir, lang]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  if (isLoading) {
    return <div className="view-placeholder"><p>{t.loading}</p></div>;
  }
  if (isError) {
    return <div className="view-placeholder"><p>{(error as Error).message || t.failedToLoad}</p></div>;
  }

  return (
    <div className="bom-history">
      <div className="bom-history__header">
        <h2 className="bom-history__title">{t.productsTitle}</h2>
        <span className="bom-history__count">
          {filtered.length} / {products?.length ?? 0}
        </span>
      </div>

      <div className="bom-history__header" style={{ marginTop: 4, marginBottom: 12 }}>
        <input
          type="search"
          className="where-used__search-input ingredient-row__input"
          placeholder={t.productsSearchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 460 }}
          aria-label={t.productsSearchPlaceholder}
        />
      </div>

      <table className="bom-history__table">
        <thead>
          <tr>
            <th style={{ width: 56 }}>{t.productsColImage}</th>
            <th
              onClick={() => onSort('name')}
              style={{ cursor: 'pointer' }}
              title={t.productsSortHint}
            >
              {t.productsColName}{sortIndicator('name')}
            </th>
            <th
              onClick={() => onSort('reference')}
              style={{ cursor: 'pointer' }}
              title={t.productsSortHint}
            >
              {t.refCode}{sortIndicator('reference')}
            </th>
            <th
              className="bom-history__num"
              onClick={() => onSort('volume_weight')}
              style={{ cursor: 'pointer' }}
              title={t.productsSortHint}
            >
              {t.productsColWeight}{sortIndicator('volume_weight')}
            </th>
            <th
              className="bom-history__num"
              onClick={() => onSort('raw_cost')}
              style={{ cursor: 'pointer' }}
              title={t.productsSortHint}
            >
              {t.productsColCost}{sortIndicator('raw_cost')}
            </th>
            <th
              className="bom-history__num"
              onClick={() => onSort('cost_per_kg')}
              style={{ cursor: 'pointer' }}
              title={t.productsSortHint}
            >
              {t.productsColCostPerKg}{sortIndicator('cost_per_kg')}
            </th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                {products?.length ? t.productsNoMatches : t.productsEmpty}
              </td>
            </tr>
          )}
          {filtered.map((p) => {
            const img = getImageSrc(p.image_url);
            const cpk = resolveCostPerKg(p);
            return (
              <tr key={p.id}>
                <td>
                  {img ? (
                    <img
                      src={img}
                      alt=""
                      style={{
                        width: 40, height: 40, objectFit: 'cover',
                        borderRadius: 4, border: '1px solid var(--border)',
                        background: '#fff',
                      }}
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      style={{
                        width: 40, height: 40, borderRadius: 4,
                        border: '1px dashed var(--border)', background: '#fafafa',
                      }}
                    />
                  )}
                </td>
                <td className="bom-history__name">{getDisplayName(p, lang)}</td>
                <td className="bom-history__ref">{p.reference ?? ''}</td>
                <td className="bom-history__num">{renderWeight(p, t)}</td>
                <td className="bom-history__num">{fmtNum(p.raw_cost)}</td>
                <td className="bom-history__num">
                  {cpk.value == null ? (
                    <span title={t.productsWeightMissing} style={{ color: 'var(--text-muted)' }}>—</span>
                  ) : (() => {
                    const isEstimated = cpk.weightSource === 'name_regex';
                    const baseTooltip = cpk.source === 'stored'
                      ? t.productsCpkStored
                      : t.productsCpkComputed;
                    const tooltip = isEstimated ? t.productsCpkFromRegex : baseTooltip;
                    return (
                      <span
                        title={tooltip}
                        style={isEstimated ? { color: ESTIMATED_COLOR, fontWeight: 500 } : undefined}
                      >
                        {fmtNum(cpk.value)}
                        <small
                          style={{
                            marginLeft: 4,
                            color: isEstimated ? ESTIMATED_COLOR : 'var(--text-muted)',
                          }}
                        >
                          {isEstimated
                            ? t.productsEstimatedTag
                            : (cpk.source === 'stored' ? t.productsCpkStoredTag : t.productsCpkComputedTag)}
                        </small>
                      </span>
                    );
                  })()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
