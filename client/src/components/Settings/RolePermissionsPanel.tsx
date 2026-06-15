import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useToastStore } from '../../stores/useToastStore';
import { useLang } from '../../context/LanguageContext';
import { TABS, type Role } from '../../config/tabs';

const ROLES: Role[] = ['customer', 'admin', 'manager'];

/**
 * Manager-only matrix: for each role, which sidebar tabs are visible.
 * Toggling a cell saves that role immediately.  The manager↔Settings
 * cell is locked on (anti-lockout, enforced server-side too).
 */
export const RolePermissionsPanel: React.FC = () => {
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const { t } = useLang();

  const { data, isLoading } = useQuery({
    queryKey: ['role-permissions'],
    queryFn: api.getRolePermissions,
    staleTime: 30_000,
  });

  const { mutate, isPending } = useMutation({
    mutationFn: ({ role, tabs }: { role: Role; tabs: string[] }) => api.updateRolePermissions(role, tabs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['role-permissions'] });
      toast(t.permSaved, { type: 'success' });
    },
    onError: (e: Error) => toast(t.deleteFailed, { type: 'error', message: e.message }),
  });

  const map = data || {};
  const roleLabel = (r: Role) => (t as Record<string, string>)[`role_${r}`] || r;

  const toggle = (role: Role, key: string, on: boolean) => {
    const next = new Set(map[role] || []);
    if (on) next.add(key); else next.delete(key);
    mutate({ role, tabs: [...next] });
  };

  return (
    <div className="role-perms">
      <h2>{t.permTitle}</h2>
      <p className="role-perms__hint">{t.permHint}</p>

      {isLoading ? (
        <div className="skeleton-table">{[1, 2, 3].map((n) => <div key={n} className="skeleton-row" />)}</div>
      ) : (
        <table className="role-perms__table">
          <thead>
            <tr>
              <th>{t.permTab}</th>
              {ROLES.map((r) => <th key={r}>{roleLabel(r)}</th>)}
            </tr>
          </thead>
          <tbody>
            {TABS.map((tab) => (
              <tr key={tab.key}>
                <td>{(t as Record<string, string>)[tab.labelKey] || tab.key}</td>
                {ROLES.map((role) => {
                  const checked = (map[role] || []).includes(tab.key);
                  const locked = role === 'manager' && tab.key === 'settings';
                  return (
                    <td key={role} className="role-perms__cell">
                      <input
                        type="checkbox"
                        checked={checked || locked}
                        disabled={locked || isPending}
                        onChange={(e) => toggle(role, tab.key, e.target.checked)}
                        aria-label={`${roleLabel(role)} – ${tab.key}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
