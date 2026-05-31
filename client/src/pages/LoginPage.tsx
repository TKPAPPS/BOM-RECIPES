import React, { useState, FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../context/LanguageContext';

/* ── Inline SVG logo (identical to App.tsx, always LTR) ─────── */
const LoginLogo: React.FC = () => (
  <svg
    viewBox="0 0 260 90"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="The Kosher Place"
    direction="ltr"
    style={{ height: 56, width: 'auto', direction: 'ltr' }}
  >
    <text
      x="8" y="22"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight="700" fontSize="18" fill="#CBAA6A" letterSpacing="3"
    >
      THE
    </text>
    <text
      x="4" y="72"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight="700" fontSize="52" fill="#FFFFFF" letterSpacing="-1"
    >
      KOSHER
    </text>
    <text
      x="175" y="88"
      fontFamily="Georgia, 'Times New Roman', serif"
      fontWeight="700" fontSize="18" fill="#CBAA6A" letterSpacing="3"
    >
      PLACE
    </text>
  </svg>
);

export const LoginPage: React.FC = () => {
  const { login }    = useAuth();
  const { t }        = useLang();
  const navigate     = useNavigate();
  const location     = useLocation();

  const [username, setUsername] = useState('');
  const [code,     setCode]     = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  // After login, go to the page the user originally tried to visit (or home).
  // The 401 handler in api/index.ts redirects to /login?next=<path> so a session
  // that expires mid-task lands the user back where they were.
  const nextParam = new URLSearchParams(location.search).get('next');
  const from =
    (location.state as { from?: string })?.from ??
    nextParam ??
    '/';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(username.trim(), code);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.loginError);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* ── Card ───────────────────────────────────────────── */}
      <div className="login-card">
        {/* ── Brand header ─────────────────────────────────── */}
        <div className="login-card__brand">
          <LoginLogo />
          <p className="login-card__subtitle">{t.loginSubtitle}</p>
        </div>

        {/* ── Divider ──────────────────────────────────────── */}
        <div className="login-card__divider" />

        {/* ── Form ─────────────────────────────────────────── */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <h2 className="login-form__title">{t.loginTitle}</h2>

          {error && (
            <div className="login-form__error" role="alert">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              {error}
            </div>
          )}

          <div className="login-form__field">
            <label className="login-form__label" htmlFor="login-username">
              {t.loginUsername}
            </label>
            <input
              id="login-username"
              className="login-form__input"
              type="text"
              autoComplete="username"
              placeholder={t.loginUsernamePh}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="login-form__field">
            <label className="login-form__label" htmlFor="login-code">
              {t.loginCode}
            </label>
            <input
              id="login-code"
              className="login-form__input"
              type="password"
              autoComplete="current-password"
              placeholder={t.loginCodePh}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="login-form__submit"
            disabled={loading || !username || !code}
          >
            {loading ? t.loginLoading : t.loginButton}
          </button>
        </form>
      </div>
    </div>
  );
};
