import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useLang } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { useToastStore } from '../../stores/useToastStore';
import type { UserRow } from '../../types';

/**
 * Admin-only user management panel for the SettingsPage.
 *
 * Backend enforces:
 *   • last-active-admin lockout (STEP 2)
 *   • role / can_view_prices / is_active patch validation
 * — so this UI just provides the controls and trusts the server's
 * 409/400 responses (surfaced via toast).
 *
 * can_view_prices is a true three-state:
 *   null  → "Default (role-based)"  — admin sees prices, customer does not
 *   true  → explicit YES override
 *   false → explicit NO override
 */
export const UserManagementPanel: React.FC = () => {
  const { t } = useLang();
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const toast = useToastStore((s) => s.push);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users-list'],
    queryFn:  () => api.getUsers(),
    staleTime: 30_000,
  });

  const { mutate: saveUser, variables: pendingVars, isPending } = useMutation({
    mutationFn: (args: { id: number; patch: Parameters<typeof api.updateUser>[1] }) =>
      api.updateUser(args.id, args.patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users-list'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    },
    onError: (err: Error) => {
      toast('Update failed', { type: 'error', message: err.message });
    },
  });

  // ── Create-user form ───────────────────────────────────────────
  const [form, setForm] = useState<{ username: string; password: string; name: string; role: 'admin' | 'customer' | 'manager' }>(
    { username: '', password: '', name: '', role: 'customer' }
  );

  const { mutate: createUser, isPending: creating } = useMutation({
    mutationFn: () => api.createUser({
      username: form.username.trim(),
      password: form.password,
      name: form.name.trim() || undefined,
      role: form.role,
    }),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: ['users-list'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      toast(t.userCreated, { type: 'success', message: u.username });
      setForm({ username: '', password: '', name: '', role: 'customer' });
    },
    onError: (err: Error) => toast(t.userCreateFailed, { type: 'error', message: err.message }),
  });

  const submitCreate = () => {
    if (!form.username.trim()) { toast(t.userCreateFailed, { type: 'warning', message: t.userColUser }); return; }
    if (form.password.length < 6) { toast(t.userCreateFailed, { type: 'warning', message: t.userPwHint }); return; }
    createUser();
  };

  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('en-ZA', {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '—';

  const cvpValue = (u: UserRow) =>
    u.can_view_prices === true  ? 'true'  :
    u.can_view_prices === false ? 'false' : 'default';

  const parseCvp = (raw: string): boolean | null =>
    raw === 'true' ? true : raw === 'false' ? false : null;

  return (
    <div className="user-mgmt">
      <h3 className="user-mgmt__title">{t.usersTitle}</h3>
      <p className="user-mgmt__desc">{t.usersDesc}</p>

      {/* ── Create new local user (username + password) ──────────── */}
      <div className="user-mgmt__create">
        <h4 className="user-mgmt__create-title">{t.userCreateTitle}</h4>
        <div className="user-mgmt__create-row">
          <input
            className="ingredient-row__input"
            placeholder={t.userColUser}
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            autoComplete="off"
          />
          <input
            className="ingredient-row__input"
            type="password"
            placeholder={t.userPwPlaceholder}
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            autoComplete="new-password"
          />
          <input
            className="ingredient-row__input"
            placeholder={t.userNamePlaceholder}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            autoComplete="off"
          />
          <select
            className="ingredient-row__input"
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as 'admin' | 'customer' | 'manager' }))}
          >
            <option value="customer">{t.role_customer}</option>
            <option value="admin">{t.role_admin}</option>
            <option value="manager">{t.role_manager}</option>
          </select>
          <button className="btn btn--primary" disabled={creating} onClick={submitCreate}>
            {creating ? t.userSavePending : t.userCreateBtn}
          </button>
        </div>
        <p className="user-mgmt__create-hint">{t.userPwHint}</p>
      </div>

      {isLoading ? (
        <p className="user-mgmt__loading">{t.loading}</p>
      ) : (
        <table className="user-mgmt__table">
          <thead>
            <tr>
              <th>{t.userColUser}</th>
              <th>{t.userColRole}</th>
              <th>{t.userColCanViewPrices}</th>
              <th>{t.userColActive}</th>
              <th>{t.userColLastLogin}</th>
              <th className="user-mgmt__actions-col">{t.userColActions}</th>
            </tr>
          </thead>
          <tbody>
            {(users as UserRow[]).map((u) => {
              const isMe = me?.id === u.id;
              const rowPending = isPending && pendingVars?.id === u.id;
              return (
                <tr key={u.id} className={u.is_active ? '' : 'user-mgmt__row--inactive'}>
                  <td>
                    <div className="user-mgmt__name">
                      {u.name || u.username}
                      {isMe && <span className="user-mgmt__me-pill">you</span>}
                    </div>
                    <div className="user-mgmt__sub">
                      {u.username}{u.email ? ` · ${u.email}` : ''}
                    </div>
                  </td>
                  <td>
                    <select
                      value={u.role}
                      disabled={rowPending}
                      onChange={(e) =>
                        saveUser({
                          id: u.id,
                          patch: { role: e.target.value as 'admin' | 'customer' | 'manager' },
                        })
                      }
                    >
                      <option value="admin">{t.role_admin}</option>
                      <option value="manager">{t.role_manager}</option>
                      <option value="customer">{t.role_customer}</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={cvpValue(u)}
                      disabled={rowPending}
                      onChange={(e) =>
                        saveUser({
                          id: u.id,
                          patch: { can_view_prices: parseCvp(e.target.value) },
                        })
                      }
                    >
                      <option value="default">{t.userCvpDefault}</option>
                      <option value="true">{t.userCvpYes}</option>
                      <option value="false">{t.userCvpNo}</option>
                    </select>
                  </td>
                  <td>
                    {u.is_active ? '✓' : '—'}
                  </td>
                  <td className="user-mgmt__last-login">
                    {fmtDate(u.last_login)}
                  </td>
                  <td>
                    <button
                      className={`btn btn--sm ${u.is_active ? 'btn--ghost' : 'btn--primary'}`}
                      disabled={rowPending}
                      onClick={() =>
                        saveUser({ id: u.id, patch: { is_active: !u.is_active } })
                      }
                    >
                      {rowPending
                        ? t.userSavePending
                        : (u.is_active ? t.userDeactivate : t.userActivate)}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};
