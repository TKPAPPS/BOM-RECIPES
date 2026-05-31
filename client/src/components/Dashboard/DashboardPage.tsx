import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';

/**
 * Admin landing dashboard.  Shows a compact at-a-glance summary
 * (recipe counts, product counts, user counts, last-sync info) and
 * quick-action links into the rest of the admin surface.
 *
 * The dashboard is admin-only at the route level (AdminRoute), but
 * we double-render based on user.role for the welcome string so a
 * customer who somehow lands here still sees a useful page rather
 * than an empty grid before being redirected.
 */
export const DashboardPage: React.FC = () => {
  const { t } = useLang();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data: summary } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn:  api.getDashboardSummary,
    enabled:  isAdmin,
    staleTime: 60_000,
  });

  const { data: sync } = useQuery({
    queryKey: ['sync-status'],
    queryFn:  api.getSyncStatus,
    enabled:  isAdmin,
    staleTime: 30_000,
  });

  const lastSyncRow  = sync?.last_outcome;
  const lastSyncWhen = lastSyncRow ? new Date(lastSyncRow.created_at) : null;
  const syncSucceeded = lastSyncRow?.action_type === 'odoo_sync_complete';

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <h2 className="dashboard__title">{t.dashboard}</h2>
        <p className="dashboard__welcome">
          {user?.name ? `${t.dashboardWelcome} · ${user.name}` : t.dashboardWelcome}
        </p>
      </header>

      {!isAdmin ? (
        <p className="dashboard__not-admin">
          {t.recipeBookSubtitle}{' '}
          <Link to="/book">{t.recipeBook} →</Link>
        </p>
      ) : (
        <>
          {/* ── Recipe / product / user cards ─────────────── */}
          <section className="dashboard__cards">
            <DashCard
              label={t.dashSummaryBase}
              value={summary?.recipes.base_count ?? '—'}
              accent="burgundy"
              to="/recipes/base"
            />
            <DashCard
              label={t.dashSummaryFinal}
              value={summary?.recipes.final_count ?? '—'}
              accent="gold"
              to="/recipes/final"
            />
            <DashCard
              label={t.dashSummaryProducts}
              value={summary?.products.active_products ?? '—'}
              accent="ink"
            />
            <DashCard
              label={t.dashSummaryAdmins}
              value={summary?.users.admin_count ?? '—'}
              accent="burgundy"
              to="/settings"
              subValue={`${summary?.users.customer_count ?? 0} ${t.dashSummaryCustomers.toLowerCase()}`}
            />
            <DashCard
              label={t.dashLastSync}
              value={
                lastSyncWhen
                  ? lastSyncWhen.toLocaleString('en-ZA', {
                      year: 'numeric', month: 'short', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })
                  : t.dashSyncNever
              }
              accent={syncSucceeded ? 'ok' : (lastSyncRow ? 'bad' : 'ink')}
              subValue={
                lastSyncRow
                  ? (syncSucceeded ? t.dashSyncOk : t.dashSyncFailed)
                  : undefined
              }
              to="/settings"
            />
          </section>

          {/* ── Quick actions ─────────────────────────────── */}
          <section className="dashboard__actions">
            <h3 className="dashboard__section-title">{t.dashQuickActions}</h3>
            <div className="dashboard__action-grid">
              <Link to="/recipe/new"     className="dashboard__action">+ {t.recipeBuilder}</Link>
              <Link to="/recipes/base"   className="dashboard__action">{t.baseRecipes}</Link>
              <Link to="/recipes/final"  className="dashboard__action">{t.finalProducts}</Link>
              <Link to="/where-used"     className="dashboard__action">{t.whereUsed}</Link>
              <Link to="/settings"       className="dashboard__action">{t.settings}</Link>
              <Link to="/logs"           className="dashboard__action">{t.logs}</Link>
              <Link to="/book"           className="dashboard__action">{t.recipeBook}</Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
};

const DashCard: React.FC<{
  label: string;
  value: number | string;
  subValue?: string;
  accent: 'burgundy' | 'gold' | 'ink' | 'ok' | 'bad';
  to?: string;
}> = ({ label, value, subValue, accent, to }) => {
  const inner = (
    <>
      <span className="dash-card__label">{label}</span>
      <strong className="dash-card__value">{value}</strong>
      {subValue && <span className="dash-card__sub">{subValue}</span>}
    </>
  );
  const className = `dash-card dash-card--${accent}${to ? ' dash-card--link' : ''}`;
  return to ? (
    <Link to={to} className={className}>{inner}</Link>
  ) : (
    <div className={className}>{inner}</div>
  );
};
