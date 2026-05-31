import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import type { CostTier } from '../../types';
import { useLang } from '../../context/LanguageContext';

interface Props {
  tier: CostTier | null;
  yieldKg: number;
  laborCost?: number;
  overheadCost?: number;
  /** Show wholesale/retail pricing tiles — only for Final Packaged Products */
  showPricing?: boolean;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const pct = (n: number) => `${Math.round(n * 100)}%`;

interface TileProps {
  label: string;
  value: string;
  sub: string;
  formula: string;
  highlight: boolean;
  accent: boolean;
}

const Tile: React.FC<TileProps> = ({ label, value, sub, formula, highlight, accent }) => {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const iconRef = useRef<HTMLSpanElement>(null);

  const updatePosition = useCallback(() => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    setTooltipStyle({
      position: 'fixed',
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left + rect.width / 2,
      transform: 'translateX(-50%)',
      whiteSpace: 'nowrap',
      background: '#1e1e2e',
      color: '#f5f5f5',
      fontSize: '11px',
      fontWeight: 500,
      fontStyle: 'normal',
      padding: '5px 9px',
      borderRadius: '5px',
      pointerEvents: 'none',
      zIndex: 99999,
      boxShadow: '0 4px 14px rgba(0,0,0,.3)',
    });
  }, []);

  const show   = useCallback(() => { updatePosition(); setTooltipVisible(true);  }, [updatePosition]);
  const hide   = useCallback(() => setTooltipVisible(false), []);
  const toggle = useCallback(() => {
    setTooltipVisible((v) => { if (!v) updatePosition(); return !v; });
  }, [updatePosition]);

  useEffect(() => {
    if (!tooltipVisible) return;
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [tooltipVisible, updatePosition]);

  const tooltip = tooltipVisible
    ? ReactDOM.createPortal(
        <span style={tooltipStyle} role="tooltip">
          {formula}
          <span
            style={{
              content: '',
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              border: '5px solid transparent',
              borderTopColor: '#1e1e2e',
            }}
          />
        </span>,
        document.body,
      )
    : null;

  return (
    <div
      className={[
        'cost-display__tile',
        highlight ? 'cost-display__tile--highlight' : '',
        accent    ? 'cost-display__tile--accent'    : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="cost-display__label">
        {label}
        <span
          ref={iconRef}
          className="cost-display__info-icon"
          onMouseEnter={show}
          onMouseLeave={hide}
          onClick={toggle}
          aria-label={`Formula for ${label}`}
        >
          ℹ
        </span>
      </span>
      <span className="cost-display__value">{value}</span>
      <span className="cost-display__sub">{sub}</span>
      {tooltip}
    </div>
  );
};

export const CostDisplay: React.FC<Props> = React.memo(({ tier, yieldKg, laborCost = 0, overheadCost = 0, showPricing = false }) => {
  const { t } = useLang();

  if (!tier) {
    return (
      <div className="cost-display cost-display--empty">
        Add ingredients and a yield to see live pricing.
      </div>
    );
  }

  const { cost_for_yield, production_cost, total_cost } = tier;

  const wsValid  = total_cost > 0 && tier.wholesale_for_yield > 0;
  const rtValid  = total_cost > 0 && tier.retail_for_yield    > 0;

  const wsMargin = wsValid ? (tier.wholesale_for_yield - total_cost) / tier.wholesale_for_yield : 0;
  const rtMargin = rtValid ? (tier.retail_for_yield   - total_cost) / tier.retail_for_yield    : 0;

  const wsMult = wsValid ? tier.wholesale_for_yield / total_cost : 0;
  const rtMult = rtValid ? tier.retail_for_yield    / total_cost : 0;

  const hasProdCost = production_cost > 0;

  const costPerKgFormula = hasProdCost
    ? `Formula: (${fmt(cost_for_yield)} mat + ${fmt(production_cost)} prod) ÷ ${yieldKg} = ${fmt(tier.cost_per_kg)}`
    : `Formula: ${fmt(cost_for_yield)} ÷ ${yieldKg} = ${fmt(tier.cost_per_kg)}`;

  const totalCostFormula = hasProdCost
    ? `Formula: ${fmt(cost_for_yield)} mat + ${fmt(production_cost)} prod = ${fmt(total_cost)}`
    : `Formula: Σ(qty × cost/kg) = ${fmt(total_cost)}`;

  const tiles: TileProps[] = [
    {
      label:   t.costPerKg,
      value:   fmt(tier.cost_per_kg),
      sub:     `Fully-burdened ÷ ${yieldKg} kg yield`,
      formula: costPerKgFormula,
      highlight: false,
      accent:    false,
    },
    {
      label:   t.totalRecipeCost,
      value:   fmt(total_cost),
      sub:     hasProdCost
        ? `Mat: ${fmt(cost_for_yield)} + Prod: ${fmt(production_cost)}`
        : 'Sum of all ingredient costs',
      formula: totalCostFormula,
      highlight: false,
      accent:    false,
    },
    ...(showPricing ? [
      {
        label:   'TKP - Wholesale Price',
        value:   wsValid ? fmt(tier.wholesale_for_yield) : '—',
        sub:     wsValid ? `${pct(wsMargin)} margin` : 'Awaiting pricing formula',
        formula: wsValid
          ? `Formula: ${fmt(total_cost)} × ${wsMult.toFixed(2)} = ${fmt(tier.wholesale_for_yield)}`
          : 'No pricing formula resolved yet',
        highlight: true,
        accent:    false,
      },
      {
        label:   'Retail Price',
        value:   rtValid ? fmt(tier.retail_for_yield) : '—',
        sub:     rtValid ? `${pct(rtMargin)} margin` : 'Awaiting pricing formula',
        formula: rtValid
          ? `Formula: ${fmt(total_cost)} × ${rtMult.toFixed(2)} = ${fmt(tier.retail_for_yield)}`
          : 'No pricing formula resolved yet',
        highlight: true,
        accent:    true,
      },
    ] : []),
  ];

  return (
    <div className="cost-display">
      {tiles.map((tile) => (
        <Tile key={tile.label} {...tile} />
      ))}
      {hasProdCost && (
        <div className="cost-display__prod-breakdown">
          <span className="cost-display__prod-breakdown__label">{t.productionCostsBreakdown}</span>
          {laborCost    > 0 && <span>{t.labor} <strong>{fmt(laborCost)}</strong></span>}
          {overheadCost > 0 && <span>{t.overhead} <strong>{fmt(overheadCost)}</strong></span>}
        </div>
      )}
    </div>
  );
});
