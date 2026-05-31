import React from 'react';
import { useModalStore } from '../../stores/useModalStore';
import type { BomDetail } from '../../types';

const fmt = (n: number | null | undefined) =>
  n != null && Number.isFinite(n)
    ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n)
    : '—';

export const BomTree: React.FC<{ bom: BomDetail }> = React.memo(({ bom }) => {
  const push = useModalStore((s) => s.push);

  const totalLineCost = bom.lines.reduce((a, l) => a + (l.line_cost ?? 0), 0);

  return (
    <div className="bom-tree">
      <div className="bom-tree__summary">
        <span>Yield: <strong>{bom.yield_kg}kg</strong></span>
        <span>Cost/kg: <strong>{fmt(bom.cost_per_kg)}</strong></span>
        <span>Total cost: <strong>{fmt(totalLineCost)}</strong></span>
      </div>

      <table className="bom-tree__table">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th>Type</th>
            <th>Qty (kg)</th>
            <th>Line Cost</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {bom.lines.map((line) => (
            <tr key={line.ingredient_id} className="bom-tree__row">
              <td>{line.ingredient}</td>
              <td>
                <span className={`badge badge--${line.item_type}`}>
                  {line.item_type === 'recipe' ? 'Sub-Recipe' : 'Raw Material'}
                </span>
              </td>
              <td>{line.quantity_kg.toFixed(3)}</td>
              <td>{fmt(line.line_cost)}</td>
              <td>
                {line.item_type === 'recipe' && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => push(line.ingredient_id)}
                  >
                    ↗ Drill In
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
