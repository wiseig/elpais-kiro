import type { Config, PreviewRecord, SourceItem } from '@pelp/domain';
import { isAllowedUrl, keys } from '@pelp/domain';
import { sha256Hex } from '@pelp/domain/node';
import type { PreviewResponse } from '@pelp/domain/api';
import type { Store } from './store';

const PREVIEW_TTL_SECONDS = 7 * 86_400;
const FETCH_TIMEOUT_MS = 4_000;
const UA = 'Mozilla/5.0 (compatible; PreguntaleElPais/1.0; +https://www.elpais.com.uy)';

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .trim();
}

/** Extrae metadatos Open Graph / Twitter / title del HTML sin dependencias. */
export function parseOpenGraph(html: string): { title?: string; description?: string; imageUrl?: string; siteName?: string } {
  const head = html.slice(0, 200_000);
  const meta = (names: string[]): string | undefined => {
    for (const name of names) {
      const patterns = [
        new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, 'i'),
      ];
      for (const pattern of patterns) {
        const match = pattern.exec(head);
        if (match?.[1]) return decodeEntities(match[1]);
      }
    }
    return undefined;
  };
  const title = meta(['og:title', 'twitter:title']) ?? decodeEntities(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(head)?.[1] ?? '');
  const description = meta(['og:description', 'twitter:description', 'description']);
  const imageUrl = meta(['og:image:secure_url', 'og:image', 'twitter:image']);
  const siteName = meta(['og:site_name']);
  return {
    ...(title ? { title: title.slice(0, 300) } : {}),
    ...(description ? { description: description.slice(0, 400) } : {}),
    ...(imageUrl && /^https?:\/\//i.test(imageUrl) ? { imageUrl: imageUrl.slice(0, 500) } : {}),
    ...(siteName ? { siteName: siteName.slice(0, 80) } : {}),
  };
}

export async function fetchOpenGraph(url: string, fetchImpl: typeof fetch = fetch): Promise<ReturnType<typeof parseOpenGraph>> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`preview ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) return parseOpenGraph(await response.text());
  // Solo el principio del documento: el <head> alcanza y evita bajar páginas pesadas.
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < 300_000) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    received += value.byteLength;
    if (Buffer.concat(chunks).toString('utf8').includes('</head>')) break;
  }
  await reader.cancel().catch(() => undefined);
  return parseOpenGraph(Buffer.concat(chunks).toString('utf8'));
}

export interface PreviewDeps {
  store: Store;
  now: () => Date;
  fetchImpl?: typeof fetch;
}

/** Preview de una nota (solo hosts permitidos) con caché de 7 días en DynamoDB. */
export async function resolvePreview(deps: PreviewDeps, config: Config, url: string, known?: Partial<SourceItem>): Promise<PreviewResponse> {
  if (!isAllowedUrl(url, config.guardrails.allowedUrlHosts)) throw new Error('host no permitido');
  const clean = url.split('#')[0] ?? url;
  const key = keys.preview(sha256Hex(clean));
  const cached = await deps.store.db.get<PreviewRecord>(key);
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  if (cached && (!cached.expiresAt || cached.expiresAt > nowSeconds)) {
    return {
      url: clean,
      ...(cached.title ? { title: cached.title } : {}),
      ...(cached.description ? { description: cached.description } : {}),
      ...(cached.imageUrl ? { imageUrl: cached.imageUrl } : {}),
      ...(cached.siteName ? { siteName: cached.siteName } : {}),
      fallback: !cached.ok,
    };
  }
  let og: ReturnType<typeof parseOpenGraph> = {};
  let ok = false;
  try {
    og = await fetchOpenGraph(clean, deps.fetchImpl);
    ok = Boolean(og.title || og.imageUrl);
  } catch {
    ok = false;
  }
  const merged = {
    title: og.title ?? known?.title,
    description: og.description ?? known?.deck,
    imageUrl: og.imageUrl ?? known?.imageUrl,
    siteName: og.siteName ?? 'El País',
  };
  const record: PreviewRecord = {
    ...key,
    type: 'Preview',
    url: clean,
    ...(merged.title ? { title: merged.title } : {}),
    ...(merged.description ? { description: merged.description } : {}),
    ...(merged.imageUrl ? { imageUrl: merged.imageUrl } : {}),
    siteName: merged.siteName,
    fetchedAt: deps.now().toISOString(),
    ok,
    // Un fallo se recuerda poco tiempo para reintentar pronto.
    expiresAt: nowSeconds + (ok ? PREVIEW_TTL_SECONDS : 3600),
  };
  await deps.store.db.put(record).catch(() => undefined);
  return {
    url: clean,
    ...(merged.title ? { title: merged.title } : {}),
    ...(merged.description ? { description: merged.description } : {}),
    ...(merged.imageUrl ? { imageUrl: merged.imageUrl } : {}),
    siteName: merged.siteName,
    fallback: !ok,
  };
}
