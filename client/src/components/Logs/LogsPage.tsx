import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import type { AuditLog, UserRow } from '../../types';

/**
 * Admin-only audit log viewer.
 *
 * Filters: action_type, user, from/to date range.  Server caps at
 * 1000 rows per request — UI pages with a fixed limit of 200.
 *
 * CSV export hits the SAME filtered endpoint and serialises the
 * returned rows.  No browser-side filtering, so the export always
 * matches what is on screen.
 */
export const LogsPage: React.FC = () => {
  const { t } = useLang();

  const [actionType, setActionType] = useState('');
  const [userId,     setUserId]     = useState<string>('');
  const [from,       setFrom]       = useState('');
  const [to,         setTo]         = useState('');

  // Applied filter snapshot — only changes when "Apply" clicked
  const [applied, setApplied] = useState({
    action_type: '' as string | undefined,
    user_id:     undefined as number | undefined,
    from:        '' as string | undefined,
    to:          '' as string | undefined,
  });

  const { data: page, isLoading, isFetching } = useQuery({
    queryKey: ['audit-logs', applied],
    queryFn:  () => api.getAuditLogs({
      action_type: applied.action_type || undefined,
      user_id:     applied.user_id,
      from:        applied.from || undefined,
      to:          applied.to   || undefined,
      limit:       200,
    }),
    staleTime: 10_000,
  });

  const { data: actionTypes = [] } = useQuery({
    queryKey: ['audit-action-types'],
    queryFn:  api.getAuditActionTypes,
    staleTime: 60_000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users-list'],
    queryFn:  () => api.getUsers(),
    staleTime: 60_000,
  });

  const applyFilters = () => {
    const fromIso = from ? new Date(from).toISOString() : '';
    const toIso   = to   ? new Date(to).toISOString()   : '';
    setApplied({
      action_type: actionType,
      user_id:     userId ? parseInt(userId, 10) : undefined,
      from:        fromIso,
      to:          toIso,
    });
  };

  const clearFilters = () => {
    setActionType('');
    setUserId('');
    setFrom('');
    setTo('');
    setApplied({ action_type: undefined, user_id: undefined, from: undefined, to: undefined });
  };

  const rows = page?.rows ?? [];

  const exportCsv = () => {
    const headers = ['timestamp', 'user', 'action_type', 'entity', 'entity_id', 'description', 'ip_address'];
    const csvRows = rows.map((r) => [
      r.created_at,
      r.username ?? '',
      r.action_type,
      r.entity ?? '',
      r.entity_id ?? '',
      (r.description ?? '').replace(/[\r\n]+/g, ' '),
      r.ip_address ?? '',
    ]);
    const csv = [headers, ...csvRows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

  // Quick "yesterday → today" preset
  const presetToday = () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    setFrom(yesterday.toISOString().slice(0, 16));
    setTo('');
  };

  const showingText = useMemo(() => {
    if (!page) return '';
    return t.logsShowingCount.replace('{n}', String(rows.length)).replace('{total}', String(page.total));
  }, [page, rows.length, t.logsShowingCount]);

  return (
    <div className="logs-page">
      <header className="logs-page__header">
        <div>
          <h2 className="logs-page__title">{t.logsTitle}</h2>
          <p className="logs-page__desc">{t.logsDesc}</p>
        </div>
        <button className="btn btn--primary" onClick={exportCsv} disabled={rows.length === 0}>
          ⬇ {t.logsExportCsv}
        </button>
      </header>

      <div className="logs-page__filters">
        <label className="logs-page__filter">
          <span>{t.logsActionType}</span>
          <select value={actionType} onChange={(e) => setActionType(e.target.value)}>
            <option value="">{t.rbFilterAll}</option>
            {actionTypes.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>

        <label className="logs-page__filter">
          <span>{t.logsUser}</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t.rbFilterAll}</option>
            {(users as UserRow[]).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.username}
              </option>
            ))}
          </select>
        </label>

        <label className="logs-page__filter">
          <span>{t.logsFrom}</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>

        <label className="logs-page__filter">
          <span>{t.logsTo}</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>

        <div className="logs-page__filter-actions">
          <button className="btn btn--ghost btn--sm" onClick={presetToday}>last 24h</button>
          <button className="btn btn--primary btn--sm" onClick={applyFilters}>
            {isFetching ? '…' : t.logsApplyFilter}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={clearFilters}>{t.logsClearFilter}</button>
        </div>
      </div>

      <div className="logs-page__count">{showingText}</div>

      {isLoading ? (
        <p className="logs-page__loading">{t.loading}</p>
      ) : rows.length === 0 ? (
        <p className="logs-page__empty">{t.logsNoRows}</p>
      ) : (
        <table className="logs-page__table">
          <thead>
            <tr>
              <th>{t.logsColTime}</th>
              <th>{t.logsColUser}</th>
              <th>{t.logsColAction}</th>
              <th>{t.logsColEntity}</th>
              <th>{t.logsColDescription}</th>
              <th>{t.logsColIp}</th>
            </tr>
          </thead>
          <tbody>
            {(rows as AuditLog[]).map((r) => (
              <tr key={r.id}>
                <td className="logs-page__time">{fmtTime(r.created_at)}</td>
                <td>{r.username || (r.user_id == null ? <em>system</em> : `#${r.user_id}`)}</td>
                <td><code className={`logs-page__action logs-page__action--${actionTone(r.action_type)}`}>{r.action_type}</code></td>
                <td>{r.entity ? `${r.entity}${r.entity_id != null ? `#${r.entity_id}` : ''}` : '—'}</td>
                <td className="logs-page__desc-cell">{r.description ?? '—'}</td>
                <td><code>{r.ip_address ?? '—'}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

function actionTone(action: string): 'ok' | 'bad' | 'info' {
  if (action.endsWith('_failure') || action === 'login_failure' || action === 'login_denied') return 'bad';
  if (action.endsWith('_complete') || action === 'login_success') return 'ok';
  return 'info';
}
