import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAllowedTabs } from '../hooks/useAllowedTabs';
import { firstAllowedPath, type TabKey } from '../config/tabs';
import { useLang } from '../context/LanguageContext';

/**
 * Route guard driven by the manager-configurable role→tabs map.
 * If the current role may not see this tab, redirect to the first tab
 * it CAN see; if it has none, show a friendly "no access" notice.
 * (Data operations remain protected server-side regardless.)
 */
export const TabRoute: React.FC<{ tab: TabKey; children: React.ReactNode }> = ({ tab, children }) => {
  const { allowed } = useAllowedTabs();
  const { t } = useLang();

  if (allowed.has(tab)) return <>{children}</>;

  const fallback = firstAllowedPath(allowed);
  if (fallback) return <Navigate to={fallback} replace />;

  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--text-secondary)' }}>
      {t.noTabAccess}
    </div>
  );
};
