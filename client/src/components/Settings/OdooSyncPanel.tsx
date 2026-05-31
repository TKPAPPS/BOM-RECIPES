import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';

/**
 * Odoo sync control panel for the SettingsPage.
 *
 *   • Shows the cron schedule, active raw-material count, last
 *     trigger, and last outcome (success / failure) — all from
 *     audit_logs via GET /api/sync/status.
 *   • "Run sync now" button → POST /api/sync/odoo  (admin-only,
 *     audited by routes/sync.js).
 *   • "Recalculate all costs" button → POST /api/sync/costs.
 */
export const OdooSyncPanel: React.FC = () => {
  const { t } = useLang();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);

  const { data: status, isLoading } = useQuery({
    queryKey: ['sync-status'],
    queryFn:  api.getSyncStatus,
    staleTime: 15_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sync-status'] });
    qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    qc.invalidateQueries({ queryKey: ['boms'] });
  };

  const { mutate: runSync, isPending: syncing } = useMutation({
    mutationFn: api.triggerOdooSync,
    onSuccess: (data) => {
      toast(t.odooSyncDoneToast, {
        type: 'success',
        message: `${data.synced} products, ${data.catsSynced} categories synced.`,
      });
      refresh();
    },
    onError: (err: Error) => toast(t.odooSyncFailToast, { type: 'error', message: err.message }),
  });

  const { mutate: runRecalc, isPending: recalculating } = useMutation({
    mutationFn: api.triggerCostRecalc,
    onSuccess: (data) => {
      toast(t.odooSyncRecalcDoneToast, {
        type: 'success',
        message: `${data.recalculated} recipes recalculated.`,
      });
      refresh();
    },
    onError: (err: Error) => toast('Recalculation failed', { type: 'error', message: err.message }),
  });

  const fmt = (iso: string | null | undefined) =>
    iso
      ? new Date(iso).toLocaleString('en-ZA', {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '—';

  return (
    <div className="sync-panel">
      <h3 className="sync-panel__title">{t.odooSync}</h3>
      <p className="sync-panel__desc">
        {t.odooSyncDesc.replace('{schedule}', status?.cron_schedule ?? '—')}
      </p>

      {isLoading ? (
        <p className="sync-panel__loading">{t.loading}</p>
      ) : (
        <dl className="sync-panel__stats">
          <div>
            <dt>{t.odooSyncCronSchedule}</dt>
            <dd><code>{status?.cron_schedule}</code></dd>
          </div>
          <div>
            <dt>{t.odooSyncActiveProducts}</dt>
            <dd>{status?.active_products ?? '—'}</dd>
          </div>
          <div>
            <dt>{t.odooSyncLastTrigger}</dt>
            <dd>{fmt(status?.last_trigger?.created_at)}</dd>
          </div>
          <div>
            <dt>{t.odooSyncLastOutcome}</dt>
            <dd>
              {status?.last_outcome ? (
                <>
                  <span
                    className={
                      status.last_outcome.action_type === 'odoo_sync_complete'
                        ? 'sync-panel__outcome sync-panel__outcome--ok'
                        : 'sync-panel__outcome sync-panel__outcome--bad'
                    }
                  >
                    {status.last_outcome.action_type === 'odoo_sync_complete'
                      ? t.dashSyncOk
                      : t.dashSyncFailed}
                  </span>
                  <small className="sync-panel__outcome-when">
                    {' '}{fmt(status.last_outcome.created_at)}
                  </small>
                  {status.last_outcome.description && (
                    <div className="sync-panel__outcome-desc">
                      {status.last_outcome.description}
                    </div>
                  )}
                </>
              ) : (
                <span className="sync-panel__outcome">{t.dashSyncNever}</span>
              )}
            </dd>
          </div>
        </dl>
      )}

      <div className="sync-panel__actions">
        <button
          className="btn btn--primary"
          onClick={() => runSync()}
          disabled={syncing}
        >
          {syncing ? t.odooSyncRunning : t.odooSyncManual}
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => runRecalc()}
          disabled={recalculating}
        >
          {recalculating ? t.odooSyncRunning : t.odooSyncRecalc}
        </button>
      </div>
    </div>
  );
};
