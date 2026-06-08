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
  // The dashboard is manager-gated at the route level; managers (and the
  // dev-admin, also a manager) are the audience here.
  const canView = user?.role === 'manager' || user?.role === 'admin';

  const { data: summary } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn:  api.getDashboardSummary,
    enabled:  canView,
    staleTime: 60_000,
  });

  const { data: sync } = useQuery({
    queryKey: ['sync-status'],
    queryFn:  api.getSyncStatus,
    enabled:  canView,
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

      {!canView ? (
        <p className="dashboard__not-admin">
          {t.recipeBookSubtitle}{' '}
          <Link to="/book">{t.recipeBook} →</Link>
        </p>
      ) : (
        <>
          {/* ── Summary cards ─────────────────────────────── */}
          <section className="dashboard__cards">
            <DashCard
              label={t.dashSummaryPending}
              value={summary?.test_recipes?.pending_count ?? '—'}
              accent={(summary?.test_recipes?.pending_count ?? 0) > 0 ? 'bad' : 'ok'}
              to="/pending-recipes"
            />
            <DashCard
              label={t.dashSummaryTest}
              value={summary?.test_recipes?.draft_count ?? '—'}
              accent="gold"
              to="/test-kitchen"
            />
            <DashCard
              label={t.dashSummaryBase}
              value={summary?.recipes?.base_count ?? '—'}
              accent="burgundy"
              to="/kitchen?tab=base"
            />
            <DashCard
              label={t.dashSummaryFinal}
              value={summary?.recipes?.final_count ?? '—'}
              accent="burgundy"
              to="/kitchen?tab=final"
            />
            <DashCard
              label={t.dashSummaryProducts}
              value={summary?.products?.active_products ?? '—'}
              accent="ink"
              to="/products"
              subValue={
                (summary?.products?.archived_products ?? 0) > 0
                  ? `${summary!.products.archived_products} ${t.dashArchived}`
                  : undefined
              }
            />
            <DashCard
              label={t.dashSummaryUsers}
              value={
                summary
                  ? (summary.users?.manager_count ?? 0) + (summary.users?.admin_count ?? 0)
                  : '—'
              }
              accent="ink"
              to="/settings"
              subValue={`${summary?.users?.customer_count ?? 0} ${t.dashSummaryCustomers.toLowerCase()}`}
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
              <Link to="/pending-recipes" className="dashboard__action">{t.pendingApproval}</Link>
              <Link to="/test-kitchen"    className="dashboard__action">{t.testRecipes}</Link>
              <Link to="/kitchen"         className="dashboard__action">{t.kitchenRecipes}</Link>
              <Link to="/products"        className="dashboard__action">{t.products}</Link>
              <Link to="/where-used"      className="dashboard__action">{t.whereUsed}</Link>
              <Link to="/settings"        className="dashboard__action">{t.settings}</Link>
              <Link to="/logs"            className="dashboard__action">{t.logs}</Link>
              <Link to="/book"            className="dashboard__action">{t.recipeBook}</Link>
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
