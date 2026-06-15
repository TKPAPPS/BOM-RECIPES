import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { defaultTabsFor, type Role, type TabKey } from '../config/tabs';

/**
 * The set of sidebar tabs the current user is allowed to see, driven by
 * the manager-configurable role→tabs map (with the historical defaults
 * as fallback while loading / on error).  A manager always retains
 * Settings (anti-lockout).
 */
export function useAllowedTabs(): { allowed: Set<TabKey>; isLoading: boolean } {
  const { user } = useAuth();
  const role = (user?.role as Role) || 'customer';

  const { data, isLoading } = useQuery({
    queryKey: ['role-permissions'],
    queryFn: api.getRolePermissions,
    staleTime: 60_000,
  });

  const list = (data?.[role] as TabKey[] | undefined) ?? defaultTabsFor(role);
  const allowed = new Set<TabKey>(list);
  if (role === 'manager') allowed.add('settings');

  return { allowed, isLoading };
}
