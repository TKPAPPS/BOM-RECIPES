import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { IngredientLine, SearchResult } from '../../types';
import { useIngredientSearch } from './useIngredientSearch';
import { useModalStore } from '../../stores/useModalStore';
import { useLang } from '../../context/LanguageContext';

interface Props {
  line: IngredientLine;
  onUpdate: (patch: Partial<IngredientLine>) => void;
  onRemove: () => void;
  /** P3-2: percentage of total recipe cost for this line (0–100) */
  costPct?: number;
  /** Highlight this row's inputs when validation fails */
  hasError?: boolean;
  /** Test recipes only: allow committing a free-text product that is not
   *  in the catalogue (shown red until it exists + a sync resolves it). */
  allowAdhoc?: boolean;
}

// ─── UOM helpers ────────────────────────────────────────────────────────────

/** Supported UOMs the user can choose for a BOM line */
export const SUPPORTED_UOMS = ['kg', 'g', 'L', 'ml', 'each'] as const;
export type SupportedUom = typeof SUPPORTED_UOMS[number];

/**
 * Conversion factor: 1 <uom> = ? kg
 * For 'each', 1 unit = volume_weight kg (Odoo package weight).
 * Falls back to 1 if volume_weight is unknown.
 */
export function toKgFactor(uom: string, volumeWeight?: number | null): number {
  switch (uom.toLowerCase().trim()) {
    case 'g':
    case 'gram':
    case 'grams':
      return 0.001;
    case 'ml':
    case 'milliliter':
    case 'millilitre':
    case 'milliliters':
    case 'millilitres':
      return 0.001;
    case 'l':
    case 'liter':
    case 'litre':
    case 'liters':
    case 'litres':
      return 1;            // 1 L water ≈ 1 kg (reasonable approximation)
    case 'each':
    case 'unit':
    case 'units':
    case 'pcs':
    case 'pce':
      return volumeWeight != null && volumeWeight > 0 ? volumeWeight : 1;
    case 'kg':
    default:
      return 1;
  }
}

/**
 * Map an item's native Odoo UOM to one of the supported UOMs for the selector,
 * defaulting to 'kg' if no match.
 */
function normaliseUom(unit: string): SupportedUom {
  const u = unit.toLowerCase().trim();
  if (u === 'g' || u === 'gram' || u === 'grams') return 'g';
  if (u === 'ml' || u.startsWith('millili')) return 'ml';
  if (u === 'l' || u === 'liter' || u === 'litre' || u === 'liters' || u === 'litres') return 'L';
  if (u === 'each' || u === 'unit' || u === 'units' || u === 'pcs' || u === 'pce') return 'each';
  return 'kg';
}

// ─── Misc helpers ────────────────────────────────────────────────────────────

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

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(n);

interface DropdownPos { top: number; left: number; width: number }

// ─── Component ───────────────────────────────────────────────────────────────

export const IngredientRow: React.FC<Props> = React.memo(({ line, onUpdate, onRemove, costPct = 0, hasError = false, allowAdhoc = false }) => {
  const { results, isFetching, onSearch } = useIngredientSearch();
  const { lang, t } = useLang();
  const [inputValue, setInputValue] = useState(
    line.item ? getDisplayName(line.item, lang) : (line.adhocName ?? '')
  );
  const [open, setOpen] = useState(false);
  const push = useModalStore((s) => s.push);

  // An ad-hoc line is a free-text product not in the catalogue → red.
  const isAdhoc = !line.item && !!line.adhocName;
  const isFilled = !!line.item || !!line.adhocName;

  const wrapperRef  = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);
  const [dropdownPos, setDropdownPos] = useState<DropdownPos>({ top: 0, left: 0, width: 0 });

  useEffect(() => {
    if (line.item) setInputValue(getDisplayName(line.item, lang));
    else if (line.adhocName != null) setInputValue(line.adhocName);
  }, [lang, line.item, line.adhocName]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inWrapper  = wrapperRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inWrapper && !inDropdown) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close when the PAGE scrolls (the dropdown is fixed-positioned from a
  // snapshot of the input's rect, so it would otherwise detach).  BUT do
  // NOT close when the scroll happens INSIDE the dropdown's own list —
  // that's the user browsing results.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const tgt = e.target as Node | null;
      if (tgt && dropdownRef.current && dropdownRef.current.contains(tgt)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', close, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', close, true);
  }, [open]);

  const openDropdown = useCallback(() => {
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      setDropdownPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 420) });
    }
    setOpen(true);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      onSearch(val);
      openDropdown();
      if (!val) {
        onUpdate({ item: null, adhocName: undefined, adhocReference: undefined, isRed: undefined });
      } else if (!line.item && line.adhocName != null) {
        // Live-edit the name of an existing ad-hoc line as the user types.
        onUpdate({ adhocName: val });
      }
    },
    [onSearch, onUpdate, openDropdown, line.item, line.adhocName]
  );

  const handleSelect = useCallback(
    (result: SearchResult) => {
      setInputValue(getDisplayName(result, lang));
      const defaultUom = normaliseUom(result.unit);
      const factor = toKgFactor(defaultUom, result.volume_weight);
      onUpdate({
        item: result,
        adhocName: undefined,
        adhocReference: undefined,
        isRed: false,
        line_uom: defaultUom,
        // recalculate quantity_kg with the new item's conversion factor
        quantity_kg: line.quantity_input * factor,
      });
      setOpen(false);
    },
    [onUpdate, lang, line.quantity_input]
  );

  // Commit the typed text as an ad-hoc (not-in-catalogue) ingredient.
  const handleCommitAdhoc = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setInputValue(trimmed);
      onUpdate({ item: null, adhocName: trimmed, isRed: true });
      setOpen(false);
    },
    [onUpdate]
  );

  // ── Quantity input handler ───────────────────────────────────────────────
  const handleQuantityChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = parseFloat(e.target.value);
      const qty = isNaN(raw) || raw < 0 ? 0 : raw;
      const factor = toKgFactor(line.line_uom, line.item?.volume_weight);
      onUpdate({ quantity_input: qty, quantity_kg: qty * factor });
    },
    [onUpdate, line.line_uom, line.item]
  );

  // ── UOM selector handler ─────────────────────────────────────────────────
  const handleUomChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newUom = e.target.value;
      const factor = toKgFactor(newUom, line.item?.volume_weight);
      onUpdate({ line_uom: newUom, quantity_kg: line.quantity_input * factor });
    },
    [onUpdate, line.quantity_input, line.item]
  );

  // ── Derived values ───────────────────────────────────────────────────────
  const costPerKg = line.item ? Number(line.item.cost_per_kg || 0) : null;

  const wastePct    = line.waste_pct || 0;
  const wasteFactor = 1 - wastePct / 100;
  const effectiveQty = line.quantity_kg > 0 && wasteFactor > 0
    ? line.quantity_kg / wasteFactor
    : line.quantity_kg;

  const lineCost =
    costPerKg !== null && effectiveQty > 0
      ? costPerKg * effectiveQty
      : null;

  // ── Portalled dropdown ───────────────────────────────────────────────────
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
      }}
    >
      {isFetching && (
        <li className="ingredient-row__dropdown-item ingredient-row__dropdown-item--loading">
          <span className="btn-spinner btn-spinner--sm" aria-hidden="true" />
          {t.searching}
        </li>
      )}
      {!isFetching && results.length === 0 && !allowAdhoc && (
        <li className="ingredient-row__dropdown-item ingredient-row__dropdown-item--empty">
          {t.noResults}
        </li>
      )}
      {/* Test recipes: offer to add the typed text as a new (red) product */}
      {allowAdhoc && inputValue.trim().length >= 1 && (
        <li
          role="option"
          className="ingredient-row__dropdown-item ingredient-row__dropdown-item--adhoc"
          onMouseDown={() => handleCommitAdhoc(inputValue)}
        >
          <span className="ingredient-row__badge ingredient-row__badge--adhoc">+</span>
          <span className="ingredient-row__item-name">
            {t.addNewProductRed.replace('{name}', inputValue.trim())}
          </span>
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
            <span className="ingredient-row__dropdown-thumb ingredient-row__dropdown-thumb--placeholder" aria-hidden="true" />
          )}
          <span className={`ingredient-row__badge ingredient-row__badge--${r.type}`}>
            {r.type === 'recipe' ? t.subRecipe : t.raw}
          </span>
          <span className="ingredient-row__item-name">
            {getDisplayName(r, lang)}
            {r.reference && (
              <span className="ingredient-row__sku">{r.reference}</span>
            )}
          </span>
          <span className="ingredient-row__cost">
            {fmt(Number(r.cost_per_kg || 0))}<small>/kg</small>
          </span>
        </li>
      ))}
    </ul>,
    document.body
  ) : null;

  const isRedRow = isAdhoc || line.isRed === true;

  return (
    <tr className={`ingredient-table__row${isRedRow ? ' ingredient-table__row--adhoc' : ''}`}>

      {/* ── Thumbnail ──────────────────────────────────────────── */}
      <td className="ingredient-table__td ingredient-table__td--thumb">
        {(() => {
          const src = line.item ? getImageSrc(line.item.image_url as string | null) : null;
          return src ? (
            <img
              src={src}
              alt={getDisplayName(line.item!, lang)}
              className="ingredient-table__thumb"
            />
          ) : (
            <svg
              className="ingredient-table__thumb ingredient-table__thumb--placeholder"
              viewBox="0 0 40 40"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <rect width="40" height="40" rx="4" fill="#e5e7eb" />
              <path d="M14 28l6-8 4 5 3-3 5 6H14z" fill="#9ca3af" />
              <circle cx="27" cy="16" r="3" fill="#9ca3af" />
            </svg>
          );
        })()}
      </td>

      {/* ── Ingredient name + search ─────────────────────────────── */}
      <td className="ingredient-table__td ingredient-table__td--name">
        <div className="ingredient-row__search" ref={wrapperRef}>
          <input
            ref={inputRef}
            className={`ingredient-row__input${hasError && !isFilled ? ' ingredient-row__input--error' : ''}${isRedRow ? ' ingredient-row__input--adhoc' : ''}`}
            value={inputValue}
            onChange={handleInputChange}
            onFocus={() => inputValue.length >= 2 && openDropdown()}
            placeholder={t.searchPlaceholder}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-invalid={hasError && !isFilled}
          />
        </div>
        {dropdown}
      </td>

      {/* ── Reference code ───────────────────────────────────────── */}
      <td className="ingredient-table__td ingredient-table__td--ref">
        {isAdhoc ? (
          <input
            className="ingredient-row__input ingredient-row__ref-input"
            value={line.adhocReference ?? ''}
            onChange={(e) => onUpdate({ adhocReference: e.target.value })}
            placeholder={t.adhocRefPlaceholder}
            title={t.adhocRefPlaceholder}
          />
        ) : (
          <span className="ingredient-table__ref-code">
            {line.item?.reference ?? ''}
          </span>
        )}
      </td>

      {/* ── Quantity + UOM selector ──────────────────────────────── */}
      <td className="ingredient-table__td ingredient-table__td--num">
        <div className="ingredient-row__qty-uom-wrap">
          <input
            type="number"
            className={`ingredient-row__qty${hasError && !(line.quantity_input > 0) ? ' ingredient-row__qty--error' : ''}`}
            value={line.quantity_input || ''}
            min={0}
            step={0.01}
            onChange={handleQuantityChange}
            placeholder="0.00"
            aria-label={`Quantity in ${line.line_uom}`}
            aria-invalid={hasError && !(line.quantity_input > 0)}
          />
          <select
            className="ingredient-row__uom-select"
            value={line.line_uom}
            onChange={handleUomChange}
            aria-label="Unit of measure"
            title="Select unit of measure"
          >
            {SUPPORTED_UOMS.map((u) => (
              <option key={u} value={u}>{u === 'each' ? 'unit' : u}</option>
            ))}
          </select>
        </div>
        {/* Show converted kg value when UOM is not kg */}
        {line.line_uom !== 'kg' && line.quantity_kg > 0 && (
          <div className="ingredient-row__qty-kg-hint">
            = {fmt(line.quantity_kg)} kg
          </div>
        )}
      </td>

      {/* ── Cost per KG ──────────────────────────────────────────── */}
      <td className="ingredient-table__td ingredient-table__td--num">
        <div className="ingredient-table__readonly-cell">
          {costPerKg !== null && costPerKg > 0 ? fmt(costPerKg) : ''}
        </div>
      </td>

      {/* ── Line cost (uses effective qty with waste applied) ─────── */}
      <td className="ingredient-table__td ingredient-table__td--num">
        <div className="ingredient-table__readonly-cell">
          {lineCost !== null && lineCost > 0 ? fmt(lineCost) : ''}
        </div>
      </td>

      {/* ── P3-2: % of Cost with data-bar ────────────────────────── */}
      <td
        className="ingredient-table__td ingredient-table__td--num ingredient-table__td--pct"
        style={
          costPct > 0
            ? {
                background: `linear-gradient(to right, rgba(203,170,106,0.22) ${costPct}%, transparent ${costPct}%)`,
              }
            : undefined
        }
      >
        <span className="ingredient-table__pct-value">
          {costPct > 0 ? `${costPct.toFixed(1)}%` : ''}
        </span>
      </td>

      {/* ── Actions ──────────────────────────────────────────────── */}
      <td className="ingredient-table__td ingredient-table__td--actions">
        {line.item?.type === 'recipe' && (
          <button
            className="ingredient-row__drill-btn"
            onClick={() => push(line.item!.id)}
            title={`View BOM for ${getDisplayName(line.item, lang)}`}
            aria-label={`Drill into ${getDisplayName(line.item, lang)}`}
          >
            ↗ BOM
          </button>
        )}
        <button
          className="ingredient-row__remove"
          onClick={onRemove}
          aria-label="Remove ingredient"
          title="Remove this ingredient"
        >
          ✕
        </button>
      </td>
    </tr>
  );
});
