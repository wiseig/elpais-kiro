/**
 * Previsualización de fuentes: completa `imageUrl`/`deck` de un `SourceItem` con
 * `GET /v1/preview` cuando faltan. Los resultados se cachean en memoria por URL durante
 * la vida de la pestaña, para no repetir la llamada si la misma nota aparece varias veces
 * (por ejemplo, como sugerencia y como fuente de una respuesta).
 */
import { useEffect, useState } from 'react';
import type { SourceItem } from '@pelp/domain';
import type { PreviewResponse } from '@pelp/domain/api';
import type { ApiClient } from './api';

const cache = new Map<string, Promise<PreviewResponse | null>>();

function fetchPreview(api: ApiClient, url: string): Promise<PreviewResponse | null> {
  const cached = cache.get(url);
  if (cached) return cached;
  const promise = api.getPreview(url).catch(() => null);
  cache.set(url, promise);
  return promise;
}

/** Solo para tests o para "olvidar" una preview puntual; no se usa en producción. */
export function forgetPreview(url: string): void {
  cache.delete(url);
}

export interface ResolvedPreview {
  imageUrl?: string;
  deck?: string;
  title: string;
  /** true mientras se resuelve una preview que hacía falta pedir al servidor. */
  loading: boolean;
}

/**
 * Devuelve la imagen y la bajada de una fuente, pidiendo `GET /v1/preview` solo si el
 * `SourceItem` no las trae ya (el corpus suele incluirlas; el endpoint es el respaldo).
 */
export function useSourcePreview(api: ApiClient, item: SourceItem): ResolvedPreview {
  const needsFetch = !item.imageUrl || !item.deck;
  const [extra, setExtra] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(needsFetch);

  useEffect(() => {
    if (!needsFetch) {
      setExtra(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchPreview(api, item.url).then((result) => {
      if (cancelled) return;
      setExtra(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [api, item.url, needsFetch]);

  return {
    imageUrl: item.imageUrl ?? extra?.imageUrl,
    deck: item.deck ?? extra?.description,
    title: item.title || extra?.title || '',
    loading,
  };
}
