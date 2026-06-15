import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { useLang } from '../../context/LanguageContext';
import { useToastStore } from '../../stores/useToastStore';
import { getImageSrc, readImageFileSmart } from '../RecipeBook/imageHelpers';

/** Personal area — every user can edit their own name, username, profile
 *  picture, change their password, and log out. */
export const ProfilePage: React.FC = () => {
  const qc = useQueryClient();
  const { t } = useLang();
  const { logout } = useAuth();
  const toast = useToastStore((s) => s.push);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: me, isLoading } = useQuery({ queryKey: ['me'], queryFn: api.getMe, staleTime: 30_000 });

  // Local edits override the server value (undefined = unchanged).
  const [name, setName] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');

  const nameVal = name ?? me?.name ?? '';
  const userVal = username ?? me?.username ?? '';
  const avatarVal = avatar !== undefined ? avatar : (me?.avatar_url ?? null);
  const roleLabel = (t as Record<string, string>)[`role_${me?.role}`] || me?.role || '';

  const saveProfile = useMutation({
    mutationFn: () => api.updateMe({
      name: nameVal,
      username: userVal.trim(),
      ...(avatar !== undefined ? { avatar_url: avatarVal } : {}),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      setName(null); setUsername(null); setAvatar(undefined);
      toast(t.profileSaved, { type: 'success' });
    },
    onError: (e: Error) => toast(t.profileSaveFailed, { type: 'error', message: e.message }),
  });

  const savePw = useMutation({
    mutationFn: () => api.updateMe({ password: pw }),
    onSuccess: () => { setPw(''); setPw2(''); toast(t.profilePwChanged, { type: 'success' }); },
    onError: (e: Error) => toast(t.profileSaveFailed, { type: 'error', message: e.message }),
  });

  const onPickFile = async (f: File | undefined) => {
    if (!f) return;
    try { setAvatar(await readImageFileSmart(f)); }
    catch { toast(t.profileSaveFailed, { type: 'error', message: 'image' }); }
  };

  if (isLoading) return <div className="profile-page">{t.loading}</div>;

  const src = getImageSrc(avatarVal);
  const pwMismatch = !!pw && !!pw2 && pw !== pw2;

  return (
    <div className="profile-page">
      <h1 className="profile-page__title">{t.profileTitle}</h1>

      {/* Identity */}
      <div className="profile-card">
        <div className="profile-card__avatar-col">
          <button type="button" className="profile-avatar" onClick={() => fileRef.current?.click()} title={t.profileChangePhoto}>
            {src ? <img src={src} alt="" /> : <span className="profile-avatar__ph">{(userVal || '?').charAt(0).toUpperCase()}</span>}
            <span className="profile-avatar__edit">✎</span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onPickFile(e.target.files?.[0] || undefined)} />
          {avatarVal && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAvatar(null)}>{t.profileRemovePhoto}</button>
          )}
        </div>

        <div className="profile-card__fields">
          <label className="profile-field">
            <span>{t.profileName}</span>
            <input type="text" value={nameVal} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="profile-field">
            <span>{t.profileUsername}</span>
            <input type="text" value={userVal} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <div className="profile-meta">{t.profileRole}: <strong>{roleLabel}</strong></div>
          <button
            className="btn btn--primary"
            disabled={saveProfile.isPending || !userVal.trim()}
            onClick={() => saveProfile.mutate()}
          >
            {saveProfile.isPending ? t.saving : t.profileSave}
          </button>
        </div>
      </div>

      {/* Password */}
      <div className="profile-card profile-card--stack">
        <h2 className="profile-card__h">{t.profileChangePw}</h2>
        <label className="profile-field">
          <span>{t.profileNewPw}</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </label>
        <label className="profile-field">
          <span>{t.profileConfirmPw}</span>
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </label>
        {pwMismatch && <span className="profile-err">{t.profilePwMismatch}</span>}
        <button
          className="btn btn--primary"
          disabled={savePw.isPending || pw.length < 6 || pw !== pw2}
          onClick={() => savePw.mutate()}
        >
          {savePw.isPending ? t.saving : t.profileChangePw}
        </button>
      </div>

      <button className="btn btn--ghost profile-logout" onClick={logout}>{t.logout}</button>
    </div>
  );
};
