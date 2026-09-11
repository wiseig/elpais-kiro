/**
 * Configuración en tiempo de ejecución del backoffice.
 * Se lee de `/config.json` (mismo origen) y, si falta algún campo, de las
 * variables `VITE_*` embebidas en el build.
 */

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}

export interface RuntimeConfig {
  /** Base de la API sin barra final. Vacío = mismo origen (CloudFront enruta /admin/*). */
  apiBaseUrl: string;
  /** Etiqueta de entorno opcional (dev, staging, prod). */
  env?: string;
  cognito: CognitoConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function fetchRemote(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return {};
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // Sin config.json (o el SPA fallback devolvió HTML): usamos las variables del build.
    return {};
  }
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const remote = await fetchRemote();
  const cognito = isRecord(remote.cognito) ? remote.cognito : {};
  const env = import.meta.env;
  return {
    apiBaseUrl: (str(remote.apiBaseUrl) ?? str(env.VITE_API_URL) ?? '').replace(/\/+$/, ''),
    env: str(remote.env) ?? str(env.VITE_ENV),
    cognito: {
      userPoolId: str(cognito.userPoolId) ?? str(env.VITE_COGNITO_USER_POOL_ID) ?? '',
      clientId: str(cognito.clientId) ?? str(env.VITE_COGNITO_CLIENT_ID) ?? '',
      region: str(cognito.region) ?? str(env.VITE_COGNITO_REGION) ?? 'us-east-1',
    },
  };
}
