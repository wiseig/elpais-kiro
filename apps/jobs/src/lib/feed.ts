import { getSecretJson, getSecretString } from '@pelp/engine/core';
import type { Article, FeedResponse } from './corpus';
import { articleFromFeedItem } from './corpus';

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_ATTEMPTS = 3;

/** La URL completa del feed (con token) vive en Secrets Manager: {"url": "https://…?token=…"} o string. */
export async function feedUrl(): Promise<string> {
  const arn = process.env.FEED_SECRET_ARN;
  if (!arn) throw new Error('Falta FEED_SECRET_ARN');
  const raw = await getSecretString(arn);
  if (raw.trim().startsWith('{')) {
    const json = await getSecretJson<{ url?: string; token?: string }>(arn);
    if (json.url) return json.url;
    if (json.token) return `https://herramientas.elpais.com.uy/feed-articles.php?token=${encodeURIComponent(json.token)}`;
  }
  if (raw.startsWith('http')) return raw.trim();
  if (raw.includes('PLACEHOLDER') || raw.length < 8) throw new Error('El secreto del feed todavía tiene el valor de plantilla. Cargalo desde Secrets Manager (ver docs/runbook.md).');
  return `https://herramientas.elpais.com.uy/feed-articles.php?token=${encodeURIComponent(raw.trim())}`;
}

export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<FeedResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': process.env.FEED_USER_AGENT ?? DEFAULT_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`feed ${response.status}`);
      return (await response.json()) as FeedResponse;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function parseFeed(feed: FeedResponse, fallbackDay: string): Article[] {
  const day = feed.date && /^\d{4}-\d{2}-\d{2}$/.test(feed.date) ? feed.date : fallbackDay;
  return (feed.items ?? []).map((item) => articleFromFeedItem(item, day)).filter((article): article is Article => Boolean(article));
}
