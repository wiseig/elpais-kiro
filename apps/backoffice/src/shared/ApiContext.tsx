import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Api } from './api';
import { useAuth } from './AuthContext';

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ children }: { children: ReactNode }) {
  const { runtime, getIdToken, logout } = useAuth();
  const api = useMemo(
    () => new Api({ baseUrl: runtime.apiBaseUrl, getIdToken, onUnauthorized: logout }),
    [runtime.apiBaseUrl, getIdToken, logout],
  );
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi debe usarse dentro de <ApiProvider>');
  return api;
}
