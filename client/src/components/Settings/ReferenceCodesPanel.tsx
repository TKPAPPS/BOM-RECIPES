import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import type { ReferenceCodeCategory } from '../../types';

/**
 * Manager-only panel to define reference-code categories (prefixes).
 * A reference code is PREFIX-#### (3–5 uppercase letters + 4 digits);
 * recipes auto-number within a chosen prefix.
 */
export const ReferenceCodesPanel: React.FC = () => {
  const { t } = useLang();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);

  const [prefix, setPrefix] = useState('');
  const [description, setDescription] = useState('');

  const { data: cats = [], isLoading } = useQuery({
    queryKey: ['reference-categories'],
    queryFn: () => api.getReferenceCategories(),
  });

  const create = useMutation({
    mutationFn: () => api.createReferenceCategory({ prefix: prefix.trim().toUpperCase(), description: description.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reference-categories'] });
      toast(t.refCodeSaved, { type: 'success' });
      setPrefix(''); setDescription('');
    },
    onError: (e: Error) => toast(t.refCodeSaveFailed, { type: 'error', message: e.message }),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteReferenceCategory(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reference-categories'] }),
    onError: (e: Error) => toast(t.refCodeSaveFailed, { type: 'error', message: e.message }),
  });

  const submit = () => {
    if (!/^[A-Z]{3,5}$/.test(prefix.trim().toUpperCase())) {
      toast(t.refCodeInvalidPrefix, { type: 'warning' });
      return;
    }
    create.mutate();
  };

  return (
    <div className="user-mgmt">
      <h3 className="user-mgmt__title">{t.refCodesTitle}</h3>
      <p className="user-mgmt__desc">{t.refCodesDesc}</p>

      <div className="user-mgmt__create">
        <h4 className="user-mgmt__create-title">{t.refCodeAdd}</h4>
        <div className="user-mgmt__create-row">
          <input
            className="ingredient-row__input"
            style={{ flex: '0 0 120px', textTransform: 'uppercase' }}
            placeholder={t.refCodePrefix}
            value={prefix}
            maxLength={5}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          />
          <input
            className="ingredient-row__input"
            placeholder={t.refCodeDescription}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="btn btn--primary" disabled={create.isPending} onClick={submit}>
            {t.refCodeAddBtn}
          </button>
        </div>
        <p className="user-mgmt__create-hint">{t.refCodeHint}</p>
      </div>

      {isLoading ? (
        <p className="user-mgmt__loading">{t.loading}</p>
      ) : cats.length === 0 ? (
        <p className="user-mgmt__loading">{t.refCodesEmpty}</p>
      ) : (
        <table className="user-mgmt__table">
          <thead>
            <tr>
              <th>{t.refCodePrefix}</th>
              <th>{t.refCodeDescription}</th>
              <th className="user-mgmt__actions-col" />
            </tr>
          </thead>
          <tbody>
            {(cats as ReferenceCodeCategory[]).map((c) => (
              <tr key={c.id}>
                <td><strong>{c.prefix}</strong></td>
                <td>{c.description || '—'}</td>
                <td>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => { if (window.confirm(`${t.delete} ${c.prefix}?`)) del.mutate(c.id); }}
                  >
                    {t.delete}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
