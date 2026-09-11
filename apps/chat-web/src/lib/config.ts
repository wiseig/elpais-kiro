/**
 * Configuración en tiempo de ejecución.
 * Orden de resolución: /config.json (mismo origen) → VITE_API_URL → "" (mismo origen,
 * porque en producción CloudFront enruta /v1/* hacia la API).
 */
export interface RuntimeConfig {
  apiBaseUrl: string;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { apiBaseUrl?: unknown }).apiBaseUrl === 'string'
  );
}

async function resolveConfig(): Promise<RuntimeConfig> {
  const fallback = trimTrailingSlashes(import.meta.env.VITE_API_URL ?? '');
  try {
    const res = await fetch('/config.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !contentType.includes('json')) return { apiBaseUrl: fallback };
    const data: unknown = await res.json();
    if (isRuntimeConfig(data)) return { apiBaseUrl: trimTrailingSlashes(data.apiBaseUrl) };
  } catch {
    // Sin config.json (por ejemplo en desarrollo): usamos el fallback.
  }
  return { apiBaseUrl: fallback };
}

let pending: Promise<RuntimeConfig> | null = null;

export function loadConfig(): Promise<RuntimeConfig> {
  if (!pending) pending = resolveConfig();
  return pending;
}
