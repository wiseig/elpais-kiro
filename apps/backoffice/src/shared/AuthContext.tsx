import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RuntimeConfig } from './config';
import {
  changePassword as changePasswordRequest,
  clearStoredAuth,
  completeNewPassword as completeNewPasswordRequest,
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
  /** Cierra el desafío NEW_PASSWORD_REQUIRED y deja la sesión iniciada. */
  completeNewPassword: (email: string, session: string, newPassword: string) => Promise<void>;
  /** Cambia la contraseña del usuario que tiene la sesión abierta. */
  changePassword: (previous: string, proposed: string) => Promise<void>;
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

  const completeNewPassword = useCallback(
    async (email: string, session: string, newPassword: string): Promise<void> => {
      const auth = await completeNewPasswordRequest(runtime.cognito, email, session, newPassword);
      apply(auth);
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

  const changePassword = useCallback(
    async (previous: string, proposed: string): Promise<void> => {
      // Renueva antes de pedir el cambio: con el access token vencido Cognito contesta
      // "no autorizado" y el formulario culparía a la contraseña actual.
      await getIdToken();
      const current = sessionRef.current.auth;
      if (!current) throw new Error('No hay sesión abierta.');
      await changePasswordRequest(runtime.cognito, current.accessToken, previous, proposed);
    },
    [runtime.cognito, getIdToken],
  );

  const status: AuthStatus = !session.auth || !session.user ? 'anonymous' : session.user.isAdmin ? 'authenticated' : 'not-admin';

  const value = useMemo<AuthContextValue>(
    () => ({ runtime, status, user: session.user, login, completeNewPassword, changePassword, logout, getIdToken }),
    [runtime, status, session.user, login, completeNewPassword, changePassword, logout, getIdToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return value;
}
