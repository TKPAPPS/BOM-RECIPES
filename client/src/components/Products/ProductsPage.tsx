import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import { CURRENCY_SYMBOL } from '../RecipeBook/imageHelpers';
import type { ProductRow, CostPerKgSource, ProductOverride } from '../../types';

// Distinct accents for the cost-per-kg / weight source tags.
const ESTIMATED_COLOR = '#1d4ed8'; // blue-700  — parsed from name (regex)
const MANUAL_COLOR    = '#7c3aed'; // violet-600 — manually overridden

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

const money = (n: number | null | undefined) =>
  n != null && Number.isFinite(n) ? `${CURRENCY_SYMBOL}${fmtNum(n)}` : '—';

function getDisplayName(p: ProductRow, lang: 'en' | 'he'): string {
  if (lang === 'he') return p.name_he || p.name_en || p.name;
  return p.name_en || p.name;
}

/**
 * Render the weight / measure cell.  Odoo weight shows plain; a manual
 * weight is violet; a name-regex weight is blue.  Volume ("l") and count
 * ("unit") measures are shown in their own units (litre / unit) rather
 * than as a bogus kg figure.
 */
function renderWeight(p: ProductRow, t: ReturnType<typeof useLang>['t']) {
  // Odoo real weight
  if (p.weight_source === 'odoo' && p.volume_weight != null && p.volume_weight > 0) {
    return <>{fmtNum(p.volume_weight, 3)} <small>{p.uom || 'kg'}</small></>;
  }

  // Manual weight override (always a real weight, in grams)
  if (p.weight_source === 'manual' && p.effective_weight_grams != null) {
    return (
      <span style={{ color: MANUAL_COLOR, fontWeight: 500 }} title={t.productsCpkManual}>
        {fmtNum(p.effective_weight_grams / 1000, 3)} <small>kg</small>
        <small style={{ marginInlineStart: 4, color: MANUAL_COLOR }}>{t.productsManualTag}</small>
      </span>
    );
  }

  // Name-regex fallback — weight, volume or count
  if (p.weight_source === 'name_regex' && p.effective_weight_grams != null) {
    const base = p.effective_weight_grams / 1000; // kg / litres / units (proxy)
    let display: React.ReactNode;
    let title = t.productsWeightFromRegex;
    if (p.measure === 'volume') {
      display = <>{fmtNum(base, 3)} <small>{t.productsMeasureVolume}</small></>;
      title = t.productsCpkPerLitre;
    } else if (p.measure === 'count') {
      display = <>{fmtNum(base, 0)} <small>{t.productsMeasureCount}</small></>;
      title = t.productsCpkPerUnit;
    } else {
      const grams = p.effective_weight_grams;
      display = grams >= 1000
        ? <>{fmtNum(grams / 1000, 3)} <small>kg</small></>
        : <>{fmtNum(grams, 0)} <small>g</small></>;
    }
    return (
      <span style={{ color: ESTIMATED_COLOR, fontWeight: 500 }} title={title}>
        {display}
        <small style={{ marginInlineStart: 4, color: ESTIMATED_COLOR }}>{t.productsEstimatedTag}</small>
      </span>
    );
  }

  return (
    <span title={t.productsWeightMissing} style={{ color: 'var(--text-muted)' }}>—</span>
  );
}

/** Pick the tag label + color for a cost-per-kg source. */
function cpkTag(source: CostPerKgSource, t: ReturnType<typeof useLang>['t']):
  { label: string; color: string; title: string } | null {
  switch (source) {
    case 'manual':     return { label: t.productsManualTag,    color: MANUAL_COLOR,         title: t.productsCpkManual };
    case 'name_regex': return { label: t.productsEstimatedTag, color: ESTIMATED_COLOR,      title: t.productsCpkFromRegex };
    case 'raw_cost':   return { label: t.productsCpkRawCostTag, color: 'var(--text-muted)', title: t.productsCpkRawCost };
    default:           return null; // 'odoo' / 'none' → no tag
  }
}

/** Inline editor for the three overridable fields. */
const EditRow: React.FC<{ p: ProductRow; onClose: () => void }> = ({ p, onClose }) => {
  const { t } = useLang();
  const qc = useQueryClient();
  const pushToast = useToastStore((s) => s.push);

  const [cost, setCost]     = useState(p.manual_raw_cost != null ? String(p.manual_raw_cost) : '');
  const [weight, setWeight] = useState(p.manual_weight_grams != null ? String(p.manual_weight_grams / 1000) : '');
  const [cpk, setCpk]       = useState(p.manual_cost_per_kg != null ? String(p.manual_cost_per_kg) : '');

  const mutation = useMutation({
    mutationFn: (body: ProductOverride) => api.updateProduct(p.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] });
      pushToast(t.productsSaved, { type: 'success' });
      onClose();
    },
    onError: (err) => {
      pushToast(t.productsSaveFailed, { type: 'error', message: (err as Error).message });
    },
  });

  // Empty field → null (clear override); otherwise a parsed number.
  const parseField = (s: string): number | null => {
    const trimmed = s.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN as unknown as number;
  };

  const submit = () => {
    const body: ProductOverride = {
      manual_raw_cost:    parseField(cost),
      manual_weight_kg:   parseField(weight),
      manual_cost_per_kg: parseField(cpk),
    };
    if (Object.values(body).some((v) => typeof v === 'number' && Number.isNaN(v))) return;
    mutation.mutate(body);
  };

  const field = (
    label: string, value: string, setValue: (v: string) => void, placeholder: number | null,
  ) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input
        type="number" min={0} step="any" inputMode="decimal"
        className="ingredient-row__input"
        value={value}
        placeholder={placeholder != null ? fmtNum(placeholder) : '—'}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 120 }}
      />
    </label>
  );

  return (
    <tr>
      <td colSpan={7} style={{ background: '#faf9fd', borderBottom: '2px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', padding: '10px 8px' }}>
          <strong style={{ fontSize: 13 }}>{t.productsEditTitle}:</strong>
          {field(t.productsEditCost,   cost,   setCost,   p.odoo_raw_cost)}
          {field(t.productsEditWeight, weight, setWeight, p.effective_weight_grams != null ? p.effective_weight_grams / 1000 : null)}
          {field(t.productsEditCpk,    cpk,    setCpk,    p.cost_per_kg)}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--primary btn--sm" onClick={submit} disabled={mutation.isPending}>
              {t.productsSave}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={mutation.isPending}>
              {t.productsCancel}
            </button>
          </div>
          <small style={{ color: 'var(--text-muted)', flexBasis: '100%' }}>{t.productsEditHint}</small>
        </div>
      </td>
    </tr>
  );
};

export const ProductsPage: React.FC = () => {
  const { t, lang } = useLang();
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  // ── Resizable columns (drag the divider between headers) ──────────
  const DEFAULT_W: Record<string, number> = { name: 300, reference: 120, weight: 150, cost: 110, costkg: 140 };
  const [colW, setColW] = useState<Record<string, number>>(() => {
    try { const s = localStorage.getItem('products-col-w'); if (s) return { ...DEFAULT_W, ...JSON.parse(s) }; } catch { /* ignore */ }
    return DEFAULT_W;
  });
  const drag = useRef<{ key: string; startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const rtl = document.documentElement.dir === 'rtl';
      const delta = rtl ? drag.current.startX - e.clientX : e.clientX - drag.current.startX;
      const w = Math.max(70, drag.current.startW + delta);
      const key = drag.current.key;
      setColW((prev) => ({ ...prev, [key]: w }));
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.userSelect = '';
      setColW((prev) => { try { localStorage.setItem('products-col-w', JSON.stringify(prev)); } catch { /* ignore */ } return prev; });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);
  const startResize = (key: string) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    drag.current = { key, startX: e.clientX, startW: colW[key] ?? DEFAULT_W[key] };
    document.body.style.userSelect = 'none';
  };
  const Resizer: React.FC<{ col: string }> = ({ col }) => (
    <span className="col-resizer" onMouseDown={startResize(col)} onClick={(e) => e.stopPropagation()} title={t.productsResizeHint} />
  );

  const { data: products, isLoading, isError, error } = useQuery({
    queryKey: ['products', { includeArchived }],
    queryFn: () => api.getProducts(includeArchived),
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
      switch (sortKey) {
        case 'name':
          return dir * getDisplayName(a, lang).localeCompare(getDisplayName(b, lang));
        case 'reference':
          return dir * (a.reference ?? '').localeCompare(b.reference ?? '');
        case 'volume_weight': {
          const aw = a.effective_weight_grams ?? -1;
          const bw = b.effective_weight_grams ?? -1;
          return dir * (aw - bw);
        }
        case 'raw_cost':
          return dir * ((a.raw_cost ?? -1) - (b.raw_cost ?? -1));
        case 'cost_per_kg':
          return dir * ((a.cost_per_kg ?? -1) - (b.cost_per_kg ?? -1));
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

      <div className="bom-history__header" style={{ marginTop: 4, marginBottom: 12, gap: 16, alignItems: 'center' }}>
        <input
          type="search"
          className="where-used__search-input ingredient-row__input"
          placeholder={t.productsSearchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 460 }}
          aria-label={t.productsSearchPlaceholder}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          {t.productsIncludeArchived}
        </label>
      </div>

      <div className="products-table-wrap">
      <table className="bom-history__table products-table--resizable">
        <colgroup>
          <col style={{ width: 56 }} />
          <col style={{ width: colW.name }} />
          <col style={{ width: colW.reference }} />
          <col style={{ width: colW.weight }} />
          <col style={{ width: colW.cost }} />
          <col style={{ width: colW.costkg }} />
          <col style={{ width: 72 }} />
        </colgroup>
        <thead>
          <tr>
            <th>{t.productsColImage}</th>
            <th className="th--resizable" onClick={() => onSort('name')} style={{ cursor: 'pointer' }} title={t.productsSortHint}>
              {t.productsColName}{sortIndicator('name')}<Resizer col="name" />
            </th>
            <th className="th--resizable" onClick={() => onSort('reference')} style={{ cursor: 'pointer' }} title={t.productsSortHint}>
              {t.refCode}{sortIndicator('reference')}<Resizer col="reference" />
            </th>
            <th className="bom-history__num th--resizable" onClick={() => onSort('volume_weight')} style={{ cursor: 'pointer' }} title={t.productsSortHint}>
              {t.productsColWeight}{sortIndicator('volume_weight')}<Resizer col="weight" />
            </th>
            <th className="bom-history__num th--resizable" onClick={() => onSort('raw_cost')} style={{ cursor: 'pointer' }} title={t.productsSortHint}>
              {t.productsColCost}{sortIndicator('raw_cost')}<Resizer col="cost" />
            </th>
            <th className="bom-history__num th--resizable" onClick={() => onSort('cost_per_kg')} style={{ cursor: 'pointer' }} title={t.productsSortHint}>
              {t.productsColCostPerKg}{sortIndicator('cost_per_kg')}<Resizer col="costkg" />
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td colSpan={7} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                {products?.length ? t.productsNoMatches : t.productsEmpty}
              </td>
            </tr>
          )}
          {filtered.map((p) => {
            const img = getImageSrc(p.image_url);
            const tag = cpkTag(p.cost_per_kg_source, t);
            return (
              <React.Fragment key={p.id}>
                <tr style={p.odoo_archived ? { opacity: 0.6 } : undefined}>
                  <td>
                    {img ? (
                      <img
                        src={img}
                        alt=""
                        style={{
                          width: 40, height: 40, objectFit: 'cover',
                          borderRadius: 4, border: '1px solid var(--border)', background: '#fff',
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
                  <td className="bom-history__name">
                    {getDisplayName(p, lang)}
                    {p.odoo_archived && (
                      <small
                        title={t.productsArchivedTitle}
                        style={{ marginInlineStart: 6, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px' }}
                      >
                        {t.productsArchivedTag}
                      </small>
                    )}
                  </td>
                  <td className="bom-history__ref">{p.reference ?? ''}</td>
                  <td className="bom-history__num">{renderWeight(p, t)}</td>
                  <td className="bom-history__num">{money(p.raw_cost)}</td>
                  <td className="bom-history__num">
                    {p.cost_per_kg == null ? (
                      <span title={t.productsWeightMissing} style={{ color: 'var(--text-muted)' }}>—</span>
                    ) : (
                      <span
                        title={tag?.title}
                        style={tag && tag.color !== 'var(--text-muted)' ? { color: tag.color, fontWeight: 500 } : undefined}
                      >
                        {money(p.cost_per_kg)}
                        {tag && (
                          <small style={{ marginInlineStart: 4, color: tag.color }}>{tag.label}</small>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="bom-history__num">
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => setEditingId(editingId === p.id ? null : p.id)}
                      title={t.productsEdit}
                    >
                      {t.productsEdit}
                    </button>
                  </td>
                </tr>
                {editingId === p.id && (
                  <EditRow p={p} onClose={() => setEditingId(null)} />
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
};
