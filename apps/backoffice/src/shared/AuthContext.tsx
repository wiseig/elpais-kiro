import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RuntimeConfig } from './config';
import {
  clearStoredAuth,
  isExpiringSoon,
  loginWithPassword,
  readStoredAuth,
  refreshSession,
  userFromIdToken,
  writeStoredAuth,
  type AuthUser,
  type LoginResult,
  type StoredAuth,
} from './auth';

export type AuthStatus = 'anonymous' | 'authenticated' | 'not-admin';

export interface AuthContextValue {
  runtime: RuntimeConfig;
  status: AuthStatus;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  /** IdToken vigente; renueva si vence en menos de 2 minutos o si `force` es true. */
  getIdToken: (force?: boolean) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface SessionState {
  auth: StoredAuth | null;
  user: AuthUser | null;
}

function sessionFrom(auth: StoredAuth | null): SessionState {
  if (!auth) return { auth: null, user: null };
  if (auth.expiresAt <= Date.now() && !auth.refreshToken) return { auth: null, user: null };
  return { auth, user: userFromIdToken(auth.idToken) };
}

export function AuthProvider({ runtime, children }: { runtime: RuntimeConfig; children: ReactNode }) {
  const [session, setSession] = useState<SessionState>(() => sessionFrom(readStoredAuth()));
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const refreshingRef = useRef<Promise<string | null> | null>(null);

  const apply = useCallback((auth: StoredAuth | null) => {
    if (auth) writeStoredAuth(auth);
    else clearStoredAuth();
    const next = sessionFrom(auth);
    sessionRef.current = next;
    setSession(next);
  }, []);

  const logout = useCallback(() => apply(null), [apply]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const result = await loginWithPassword(runtime.cognito, email, password);
      if (result.kind === 'ok') apply(result.auth);
      return result;
    },
    [runtime.cognito, apply],
  );

  const getIdToken = useCallback(
    async (force = false): Promise<string | null> => {
      const current = sessionRef.current.auth;
      if (!current) return null;
      const expired = current.expiresAt <= Date.now();
      if (!force && !expired && !isExpiringSoon(current)) return current.idToken;
      if (!current.refreshToken) {
        if (!force && !expired) return current.idToken;
        logout();
        return null;
      }
      if (!refreshingRef.current) {
        const refreshToken = current.refreshToken;
        refreshingRef.current = refreshSession(runtime.cognito, refreshToken)
          .then((next) => {
            apply(next);
            return next.idToken;
          })
          .catch(() => {
            logout();
            return null;
          })
          .finally(() => {
            refreshingRef.current = null;
          });
      }
      return refreshingRef.current;
    },
    [runtime.cognito, apply, logout],
  );

  const status: AuthStatus = !session.auth || !session.user ? 'anonymous' : session.user.isAdmin ? 'authenticated' : 'not-admin';

  const value = useMemo<AuthContextValue>(
    () => ({ runtime, status, user: session.user, login, logout, getIdToken }),
    [runtime, status, session.user, login, logout, getIdToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return value;
}
