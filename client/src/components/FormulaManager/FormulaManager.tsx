import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useToastStore } from '../../stores/useToastStore';
import { useLang } from '../../context/LanguageContext';
import type { PricingFormula } from '../../types';

interface Draft {
  name: string;
  wholesale_multiplier: number;
  retail_multiplier: number;
}

const defaultDraft = (): Draft => ({
  name: '',
  wholesale_multiplier: 1.47,
  retail_multiplier: 1.75,
});

const margin = (multiplier: number) =>
  Math.round(((multiplier - 1) / multiplier) * 100);

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
      toast(editingId ? 'Formula updated' : 'Formula created', {
        type: 'success',
        message: `"${draft.name}" saved.`,
      });
      resetForm();
    },
    onError: (err: Error) => {
      toast('Save failed', { type: 'error', message: err.message });
    },
  });

  const { mutate: deleteFormula, isPending: isDeleting } = useMutation({
    mutationFn: (id: number) => api.deleteFormula(id),
    onSuccess: () => {
      invalidate();
      toast('Formula deleted', { type: 'success', message: 'Pricing formula removed.' });
    },
    onError: (err: Error) => {
      toast('Delete failed', { type: 'error', message: err.message });
    },
  });

  const { mutate: setAsDefault, isPending: isSettingDefault, variables: pendingDefaultId } = useMutation({
    mutationFn: (id: number) => api.setDefaultFormula(id),
    onSuccess: () => {
      invalidate();
      toast('Default updated', { type: 'success', message: 'Default pricing formula changed.' });
    },
    onError: (err: Error) => {
      toast('Update failed', { type: 'error', message: err.message });
    },
  });

  const patch = (key: keyof Draft, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const resetForm = () => {
    setDraft(defaultDraft());
    setEditingId(null);
    setFormOpen(false);
  };

  const handleEdit = useCallback((f: PricingFormula) => {
    setDraft({
      name: f.name,
      wholesale_multiplier: f.wholesale_multiplier,
      retail_multiplier: f.retail_multiplier,
    });
    setEditingId(f.id);
    setFormOpen(true);
    setTimeout(() => {
      document.querySelector('.formula-manager__form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }, []);

  const handleDelete = (f: PricingFormula) => {
    if (f.is_default) {
      toast('Cannot delete', {
        type: 'warning',
        message: t.formulaCannotDeleteDefault,
      });
      return;
    }
    if (window.confirm(`Delete formula "${f.name}"?`)) deleteFormula(f.id);
  };

  return (
    <div className="formula-manager">
      <h2>{t.pricingFormulas}</h2>

      {isLoading ? (
        <div className="skeleton-table">
          {[1, 2, 3].map((n) => <div key={n} className="skeleton-row" />)}
        </div>
      ) : (
        <table className="formula-manager__table">
          <thead>
            <tr>
              <th>{t.formulaNameLabel}</th>
              <th>{t.wholesaleMult} ×</th>
              <th>{t.retailMult} ×</th>
              <th>{t.wholesaleMargin}</th>
              <th>{t.retailMargin}</th>
              <th>{t.formulaDefault}</th>
              <th className="formula-manager__th--actions">{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {formulas.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{ textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic', padding: '24px' }}
                >
                  {t.noFormulas}
                </td>
              </tr>
            )}
            {formulas.map((f) => (
              <tr key={f.id} className={editingId === f.id ? 'formula-manager__row--editing' : undefined}>
                <td>
                  <strong>{f.name || <em style={{ color: 'var(--text-muted)' }}>—</em>}</strong>
                </td>
                <td>{f.wholesale_multiplier}×</td>
                <td>{f.retail_multiplier}×</td>
                <td><span className="formula-manager__margin">{margin(f.wholesale_multiplier)}%</span></td>
                <td><span className="formula-manager__margin formula-manager__margin--retail">{margin(f.retail_multiplier)}%</span></td>
                <td>
                  {f.is_default ? (
                    <span className="badge badge--default" title="This formula is used whenever a recipe doesn't pin one explicitly.">
                      {t.formulaDefaultBadge}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setAsDefault(f.id)}
                      disabled={isSettingDefault && pendingDefaultId === f.id}
                      title={t.formulaSetDefault}
                    >
                      {isSettingDefault && pendingDefaultId === f.id ? '…' : t.formulaSetDefault}
                    </button>
                  )}
                </td>
                <td className="formula-manager__td--actions">
                  <button
                    className="formula-manager__action-btn formula-manager__action-btn--edit"
                    onClick={() => handleEdit(f)}
                    title="Edit this formula"
                    disabled={isDeleting}
                  >
                    ✏
                  </button>
                  <button
                    className="formula-manager__action-btn formula-manager__action-btn--delete"
                    onClick={() => handleDelete(f)}
                    title={f.is_default ? t.formulaCannotDeleteDefault : 'Delete this formula'}
                    disabled={isDeleting || f.is_default}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!formOpen && (
        <button
          className="btn btn--primary formula-manager__add-btn"
          onClick={() => { resetForm(); setFormOpen(true); }}
          style={{ marginTop: '16px' }}
        >
          + Add New Formula
        </button>
      )}

      {formOpen && (
        <div className="formula-manager__form">
          <h3>
            {editingId ? `Editing Formula (ID ${editingId})` : t.addUpdateFormula}
          </h3>

          <label>
            {t.formulaNameLabel}
            <input
              type="text"
              value={draft.name}
              onChange={(e) => patch('name', e.target.value)}
              placeholder="e.g. Kitchen, Premium tier"
            />
          </label>

          <label>
            {t.wholesaleMult}
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={draft.wholesale_multiplier}
              onChange={(e) => patch('wholesale_multiplier', parseFloat(e.target.value))}
            />
          </label>

          <label>
            {t.retailMult}
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={draft.retail_multiplier}
              onChange={(e) => patch('retail_multiplier', parseFloat(e.target.value))}
            />
          </label>

          <div className="formula-manager__preview">
            <span>
              {t.wholesaleMargin}:{' '}
              <strong className="formula-manager__preview-pct">
                {margin(draft.wholesale_multiplier)}%
              </strong>
            </span>
            <span>
              {t.retailMargin}:{' '}
              <strong className="formula-manager__preview-pct formula-manager__preview-pct--retail">
                {margin(draft.retail_multiplier)}%
              </strong>
            </span>
          </div>

          <div className="formula-manager__form-actions">
            <button className="btn btn--ghost" onClick={resetForm}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              onClick={() => save()}
              disabled={
                isPending ||
                !draft.name.trim() ||
                !(draft.wholesale_multiplier > 0) ||
                !(draft.retail_multiplier > 0)
              }
            >
              {isPending
                ? <><span className="btn-spinner" aria-hidden="true" /> {t.saving}</>
                : t.saveFormula}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
