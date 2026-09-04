export interface Source {
  title: string;
  url: string;
  date: string;
  snippet: string;
}

export interface AskResponse {
  answer: string;
  sources: Source[];
}

const configuredUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '');

function endpoint(): string {
  if (!configuredUrl) {
    throw new Error('Falta configurar VITE_API_URL para conectar el sitio con la API.');
  }
  return configuredUrl.endsWith('/ask') ? configuredUrl : `${configuredUrl}/ask`;
}

function isSource(value: unknown): value is Source {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.title === 'string' &&
    typeof source.url === 'string' &&
    typeof source.date === 'string' &&
    typeof source.snippet === 'string'
  );
}

export async function askElPais(question: string): Promise<AskResponse> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 32_000);

  try {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string'
          ? String((payload as Record<string, unknown>).error)
          : 'No pudimos consultar las noticias en este momento.';
      throw new Error(message);
    }

    if (!payload || typeof payload !== 'object') throw new Error('La API devolvió una respuesta inválida.');
    const result = payload as Record<string, unknown>;
    if (typeof result.answer !== 'string' || !Array.isArray(result.sources)) {
      throw new Error('La API devolvió una respuesta inválida.');
    }

    return {
      answer: result.answer,
      sources: result.sources.filter(isSource),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('La consulta demoró demasiado. Probá de nuevo.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}
