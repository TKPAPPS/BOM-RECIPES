import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useToastStore } from '../../stores/useToastStore';
import { useLang } from '../../context/LanguageContext';
import { evalFormula, validateFormula } from '../../utils/formulaEval';
import type { PricingFormula } from '../../types';

interface Draft {
  name: string;
  wholesale_formula: string;
  retail_formula: string;
}

const defaultDraft = (): Draft => ({
  name: '',
  wholesale_formula: 'cost * 1.47',
  retail_formula: 'cost * 1.75',
});

/** A formula's current expression, falling back to its stored multiplier. */
const formulaOf = (f: PricingFormula, tier: 'wholesale' | 'retail'): string =>
  (tier === 'wholesale' ? f.wholesale_formula : f.retail_formula)
  || `cost * ${tier === 'wholesale' ? f.wholesale_multiplier : f.retail_multiplier}`;

const margin = (multiplier: number) =>
  multiplier > 0 ? Math.round(((multiplier - 1) / multiplier) * 100) : 0;

// Sample cost used to preview a formula's output (₪).
const SAMPLE_COST = 100;

export const FormulaManager: React.FC = () => {
  const qc    = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const { t } = useLang();

  const [draft,     setDraft]     = useState<Draft>(defaultDraft());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen,  setFormOpen]  = useState(false);

  const { data: formulas = [], isLoading } = useQuery({
    queryKey: ['formulas'],
    queryFn:  api.getFormulas,
    staleTime: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['formulas'] });
    qc.invalidateQueries({ queryKey: ['pricing'] });
    qc.invalidateQueries({ queryKey: ['boms'] });
    qc.invalidateQueries({ queryKey: ['resolve-pricing'] });
  };

  const { mutate: save, isPending } = useMutation({
    mutationFn: () => editingId
      ? api.updateFormula(editingId, draft)
      : api.createFormula(draft),
    onSuccess: () => {
      invalidate();
      toast(editingId ? 'Formula updated' : 'Formula created', { type: 'success', message: `"${draft.name}" saved.` });
      resetForm();
    },
    onError: (err: Error) => toast('Save failed', { type: 'error', message: err.message }),
  });

  const { mutate: deleteFormula, isPending: isDeleting } = useMutation({
    mutationFn: (id: number) => api.deleteFormula(id),
    onSuccess: () => { invalidate(); toast('Formula deleted', { type: 'success', message: 'Pricing formula removed.' }); },
    onError: (err: Error) => toast('Delete failed', { type: 'error', message: err.message }),
  });

  const { mutate: setAsDefault, isPending: isSettingDefault, variables: pendingDefaultId } = useMutation({
    mutationFn: (id: number) => api.setDefaultFormula(id),
    onSuccess: () => { invalidate(); toast('Default updated', { type: 'success', message: 'Default pricing formula changed.' }); },
    onError: (err: Error) => toast('Update failed', { type: 'error', message: err.message }),
  });

  const resetForm = () => { setDraft(defaultDraft()); setEditingId(null); setFormOpen(false); };

  const handleEdit = useCallback((f: PricingFormula) => {
    setDraft({ name: f.name, wholesale_formula: formulaOf(f, 'wholesale'), retail_formula: formulaOf(f, 'retail') });
    setEditingId(f.id);
    setFormOpen(true);
    setTimeout(() => {
      document.querySelector('.formula-manager__form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }, []);

  const handleDelete = (f: PricingFormula) => {
    if (f.is_default) { toast('Cannot delete', { type: 'warning', message: t.formulaCannotDeleteDefault }); return; }
    if (window.confirm(`Delete formula "${f.name}"?`)) deleteFormula(f.id);
  };

  // Append a token to one of the formula fields (insert-button helpers).
  const insert = (tier: 'wholesale_formula' | 'retail_formula', token: string) =>
    setDraft((d) => ({ ...d, [tier]: ((d[tier] || '') + token) }));

  // Wrap the whole current expression in a function, e.g. roundup(<expr>).
  const wrap = (tier: 'wholesale_formula' | 'retail_formula', fn: string) =>
    setDraft((d) => ({ ...d, [tier]: `${fn}(${(d[tier] || '').trim()})` }));

  // Wrap with a step argument, e.g. roundupto(<expr>, 5) → multiples of 5.
  const wrapStep = (tier: 'wholesale_formula' | 'retail_formula', fn: string, step: number) =>
    setDraft((d) => ({ ...d, [tier]: `${fn}(${(d[tier] || '').trim()}, ${step})` }));

  // Live preview for one formula field: returns { ok, text }.
  const preview = (expr: string) => {
    const err = validateFormula(expr);
    if (err) return { ok: false, text: err };
    const price = evalFormula(expr, { cost: SAMPLE_COST });
    const mult  = price / SAMPLE_COST;   // effective ratio at the sample cost
    return { ok: true, text: `₪${SAMPLE_COST} → ₪${price.toFixed(2)}  ·  ×${mult.toFixed(4)}  ·  ${margin(mult)}% ${t.formulaMargin}` };
  };

  const wErr = validateFormula(draft.wholesale_formula);
  const rErr = validateFormula(draft.retail_formula);

  // Reusable insert-token toolbar for a formula field.
  const Toolbar: React.FC<{ tier: 'wholesale_formula' | 'retail_formula' }> = ({ tier }) => (
    <div className="formula-builder__keys">
      <button type="button" className="formula-builder__key formula-builder__key--var" onClick={() => insert(tier, 'cost')}>{t.formulaVarCost}</button>
      {['+', '-', '*', '/', '(', ')'].map((op) => (
        <button key={op} type="button" className="formula-builder__key" onClick={() => insert(tier, ` ${op} `)}>
          {op === '*' ? '×' : op === '/' ? '÷' : op}
        </button>
      ))}
      <button type="button" className="formula-builder__key formula-builder__key--vat" onClick={() => insert(tier, ' * 1.07')} title={t.formulaVatHint}>× 1.07 ({t.formulaVat})</button>
      <button type="button" className="formula-builder__key formula-builder__key--fn" onClick={() => wrap(tier, 'roundup')} title={t.formulaRoundUpHint}>↑ {t.formulaRoundUp}</button>
      <button type="button" className="formula-builder__key formula-builder__key--fn" onClick={() => wrap(tier, 'rounddown')} title={t.formulaRoundDownHint}>↓ {t.formulaRoundDown}</button>
      <button type="button" className="formula-builder__key formula-builder__key--fn" onClick={() => wrapStep(tier, 'roundupto', 5)} title={t.formulaRoundUp5Hint}>↑ {t.formulaRoundUp5}</button>
      <button type="button" className="formula-builder__key" onClick={() => setDraft((d) => ({ ...d, [tier]: '' }))} title={t.clear}>⌫</button>
    </div>
  );

  return (
    <div className="formula-manager">
      <h2>{t.pricingFormulas}</h2>
      <p className="formula-manager__hint">{t.formulaBuilderHint}</p>

      {isLoading ? (
        <div className="skeleton-table">{[1, 2, 3].map((n) => <div key={n} className="skeleton-row" />)}</div>
      ) : (
        <table className="formula-manager__table">
          <thead>
            <tr>
              <th>{t.formulaNameLabel}</th>
              <th>{t.wholesaleMult}</th>
              <th>{t.retailMult}</th>
              <th>{t.wholesaleMargin}</th>
              <th>{t.retailMargin}</th>
              <th>{t.formulaDefault}</th>
              <th className="formula-manager__th--actions">{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {formulas.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic', padding: '24px' }}>{t.noFormulas}</td></tr>
            )}
            {formulas.map((f) => (
              <tr key={f.id} className={editingId === f.id ? 'formula-manager__row--editing' : undefined}>
                <td><strong>{f.name || <em style={{ color: 'var(--text-muted)' }}>—</em>}</strong></td>
                <td><code className="formula-manager__expr">{formulaOf(f, 'wholesale')}</code></td>
                <td><code className="formula-manager__expr">{formulaOf(f, 'retail')}</code></td>
                <td><span className="formula-manager__margin">{margin(f.wholesale_multiplier)}%</span></td>
                <td><span className="formula-manager__margin formula-manager__margin--retail">{margin(f.retail_multiplier)}%</span></td>
                <td>
                  {f.is_default ? (
                    <span className="badge badge--default" title="Used whenever a recipe doesn't pin a formula.">{t.formulaDefaultBadge}</span>
                  ) : (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsDefault(f.id)} disabled={isSettingDefault && pendingDefaultId === f.id} title={t.formulaSetDefault}>
                      {isSettingDefault && pendingDefaultId === f.id ? '…' : t.formulaSetDefault}
                    </button>
                  )}
                </td>
                <td className="formula-manager__td--actions">
                  <button className="formula-manager__action-btn formula-manager__action-btn--edit" onClick={() => handleEdit(f)} title="Edit this formula" disabled={isDeleting}>✏</button>
                  <button className="formula-manager__action-btn formula-manager__action-btn--delete" onClick={() => handleDelete(f)} title={f.is_default ? t.formulaCannotDeleteDefault : 'Delete this formula'} disabled={isDeleting || f.is_default}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!formOpen && (
        <button className="btn btn--primary formula-manager__add-btn" onClick={() => { resetForm(); setFormOpen(true); }} style={{ marginTop: '16px' }}>
          + Add New Formula
        </button>
      )}

      {formOpen && (
        <div className="formula-manager__form">
          <h3>{editingId ? `Editing Formula (ID ${editingId})` : t.addUpdateFormula}</h3>

          <label>
            {t.formulaNameLabel}
            <input type="text" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. Kitchen, Premium tier" />
          </label>

          {/* ── Wholesale formula ── */}
          <div className="formula-builder">
            <label className="formula-builder__label">{t.wholesaleMult} — {t.formulaLabel}</label>
            <input
              type="text"
              className={`formula-builder__input${wErr ? ' formula-builder__input--error' : ''}`}
              value={draft.wholesale_formula}
              onChange={(e) => setDraft((d) => ({ ...d, wholesale_formula: e.target.value }))}
              placeholder="cost * 1.5 * 1.07"
              dir="ltr"
            />
            <Toolbar tier="wholesale_formula" />
            <p className={`formula-builder__preview${wErr ? ' formula-builder__preview--error' : ''}`}>{preview(draft.wholesale_formula).text}</p>
          </div>

          {/* ── Retail formula ── */}
          <div className="formula-builder">
            <label className="formula-builder__label">{t.retailMult} — {t.formulaLabel}</label>
            <input
              type="text"
              className={`formula-builder__input${rErr ? ' formula-builder__input--error' : ''}`}
              value={draft.retail_formula}
              onChange={(e) => setDraft((d) => ({ ...d, retail_formula: e.target.value }))}
              placeholder="cost * 1.75 * 1.07"
              dir="ltr"
            />
            <Toolbar tier="retail_formula" />
            <p className={`formula-builder__preview${rErr ? ' formula-builder__preview--error' : ''}`}>{preview(draft.retail_formula).text}</p>
          </div>

          <div className="formula-manager__form-actions">
            <button className="btn btn--ghost" onClick={resetForm}>Cancel</button>
            <button
              className="btn btn--primary"
              onClick={() => save()}
              disabled={isPending || !draft.name.trim() || !!wErr || !!rErr}
            >
              {isPending ? <><span className="btn-spinner" aria-hidden="true" /> {t.saving}</> : t.saveFormula}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
