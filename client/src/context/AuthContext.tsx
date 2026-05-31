import React, { createContext, useContext, useState, useCallback } from 'react';

const BASE = import.meta.env.VITE_API_URL ?? '/api';
const TOKEN_KEY = 'bom_token';
const USER_KEY  = 'bom_user';

export interface AuthUser {
  id:       string | number;
  username: string;
  name:     string;
  role:     string;
}

interface AuthContextValue {
  user:            AuthUser | null;
  token:           string | null;
  isAuthenticated: boolean;
  login:           (username: string, code: string) => Promise<void>;
  logout:          () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user:            null,
  token:           null,
  isAuthenticated: false,
  login:           async () => {},
  logout:          () => {},
});

function readStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user,  setUser]  = useState<AuthUser | null>(readStoredUser);

  const login = useCallback(async (username: string, code: string) => {
    const res = await fetch(`${BASE}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, code }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? 'Login failed');
    }

    const data: { token: string; user: AuthUser } = await res.json();

    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY,  JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isAuthenticated: !!token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
