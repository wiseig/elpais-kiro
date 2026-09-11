import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BedrockAgentClient, GetIngestionJobCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import type { Config, CorpusIndexRecord } from '@pelp/domain';
import { dayToEpoch, keys, topicFromSection } from '@pelp/domain';
import { contentHash, sha256Hex } from '@pelp/domain/node';
import type { Store } from '@pelp/engine/core';

/** Nota normalizada, sea del feed o de la API de Daily Brief. */
export interface Article {
  articleId: string;
  externalId: string;
  title: string;
  deck: string;
  bodyText: string;
  url: string;
  section: string;
  /** YYYY-MM-DD en Montevideo. */
  date: string;
  feedDate?: string;
  author: string;
  keywords: string[];
  origin: 'feed' | 'dailybrief-api' | 'backfill';
}

export interface FeedItem {
  notId: string;
  titulo: string;
  bajada?: string;
  cuerpo?: string;
  cuerpo_texto?: string;
  fecha?: string;
  fecha_creacion?: string;
  categorySlug?: string;
  link: string;
  autor?: string;
  imagenes?: string[];
  keywords?: string[];
}

export interface FeedResponse {
  date?: string;
  category?: string;
  count?: number;
  items?: FeedItem[];
}

export interface DailyBriefArticle {
  articleId: string;
  externalId?: string;
  source?: string;
  title?: string;
  deck?: string;
  bodyHtml?: string;
  bodyText?: string;
  feedDate?: string;
  link?: string;
  category?: string;
  keywords?: string[];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<\s*(br|p|div|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Mismo articleId que Daily Brief (`sha256("elpais:" + notId)`), para reconciliar sin duplicar. */
export function articleIdFor(notId: string): string {
  return sha256Hex(`elpais:${notId}`);
}

function dayFrom(value: string | undefined, fallback: string): string {
  const match = value?.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? fallback;
}

export function articleFromFeedItem(item: FeedItem, feedDay: string): Article | undefined {
  const title = (item.titulo ?? '').trim();
  const body = (item.cuerpo_texto?.trim() || stripHtml(item.cuerpo ?? '')).trim();
  if (!item.notId || !title || !item.link || !body) return undefined;
  return {
    articleId: articleIdFor(item.notId),
    externalId: item.notId,
    title,
    deck: (item.bajada ?? '').trim(),
    bodyText: body,
    url: item.link.trim(),
    section: (item.categorySlug ?? '').trim() || 'sin-seccion',
    date: dayFrom(item.fecha, feedDay),
    ...(item.fecha ? { feedDate: item.fecha } : {}),
    author: (item.autor ?? '').trim(),
    keywords: (item.keywords ?? []).filter((keyword) => typeof keyword === 'string' && keyword.trim()).map((keyword) => keyword.trim()),
    origin: 'feed',
  };
}

export function articleFromDailyBrief(article: DailyBriefArticle, fallbackDay: string, origin: 'dailybrief-api' | 'backfill'): Article | undefined {
  const title = (article.title ?? '').trim();
  const body = (article.bodyText?.trim() || stripHtml(article.bodyHtml ?? '')).trim();
  if (!article.articleId || !title || !article.link || !body) return undefined;
  const feedDate = article.feedDate ? montevideoDayFromIso(article.feedDate) : undefined;
  return {
    articleId: article.articleId,
    externalId: article.externalId ?? '',
    title,
    deck: (article.deck ?? '').trim(),
    bodyText: body,
    url: article.link.trim(),
    section: (article.category ?? '').trim() || 'sin-seccion',
    date: feedDate ?? fallbackDay,
    ...(article.feedDate ? { feedDate: article.feedDate } : {}),
    author: (article.source ?? '').trim(),
    keywords: (article.keywords ?? []).filter((keyword) => typeof keyword === 'string' && keyword.trim()),
    origin,
  };
}

export function montevideoDayFromIso(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(parsed));
}

/** Formato de la sección 5.2. */
export function toMarkdown(article: Article): string {
  const lines = [
    `# ${article.title}`,
    '',
    '- Medio: El País (Uruguay)',
    `- Fecha: ${article.date}`,
    `- Sección: ${article.section}`,
    `- URL: ${article.url}`,
    '',
  ];
  if (article.deck) lines.push(`> ${article.deck}`, '');
  lines.push(article.bodyText, '');
  return lines.join('\n');
}

export function toMetadata(article: Article, hash: string): { metadataAttributes: Record<string, string | number> } {
  return {
    metadataAttributes: {
      articleId: article.articleId,
      title: article.title.slice(0, 200),
      url: article.url.slice(0, 300),
      section: article.section.slice(0, 60),
      date: article.date,
      dateEpoch: dayToEpoch(article.date),
      author: article.author.slice(0, 80),
      keywords: article.keywords.join(', ').slice(0, 200),
      contentHash: hash,
    },
  };
}

export function s3KeyFor(article: Article): string {
  const [year, month, day] = article.date.split('-');
  return `notas/${year}/${month}/${day}/${article.articleId}.md`;
}

export function articleHash(article: Article): string {
  return contentHash(article.title, article.bodyText, article.url);
}

export interface UpsertResult {
  written: number;
  unchanged: number;
  failed: number;
  writtenIds: string[];
  failedIds: string[];
}

export class CorpusUpsertError extends Error {
  constructor(readonly result: UpsertResult) {
    super(`Falló el upsert de ${result.failed} nota(s): ${result.failedIds.join(', ')}`);
    this.name = 'CorpusUpsertError';
  }
}

export interface CorpusDeps {
  store: Store;
  s3: S3Client;
  bucket: string;
  now: () => Date;
}

const INGESTION_STATE_KEY = { PK: 'SYSTEM#CORPUS', SK: 'INGESTION#STATE' } as const;

export interface IngestionState {
  generation: number;
  completedGeneration: number;
  dirtyAt?: string;
  activeJobId?: string;
  activeGeneration?: number;
  activeStartedAt?: string;
  lastStatus?: string;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface IngestionCheckResult {
  status: 'idle' | 'starting' | 'in-progress' | 'complete';
  ingestionJobId?: string;
  pending: boolean;
}

export class IngestionConflictError extends Error {
  constructor() {
    super('Ya hay una ingestión en curso; la generación pendiente quedó persistida para reintento');
    this.name = 'IngestionConflictError';
  }
}

export class IngestionFailedError extends Error {
  constructor(jobId: string, status: string, reasons: string[]) {
    super(`La ingestión ${jobId} terminó en ${status}${reasons.length ? `: ${reasons.join('; ')}` : ''}`);
    this.name = 'IngestionFailedError';
  }
}

export async function getIngestionState(store: Store): Promise<IngestionState> {
  const record = await store.db.get<Partial<IngestionState>>(INGESTION_STATE_KEY);
  return {
    generation: record?.generation ?? 0,
    completedGeneration: record?.completedGeneration ?? 0,
    ...(record?.dirtyAt ? { dirtyAt: record.dirtyAt } : {}),
    ...(record?.activeJobId ? { activeJobId: record.activeJobId } : {}),
    ...(record?.activeGeneration !== undefined ? { activeGeneration: record.activeGeneration } : {}),
    ...(record?.activeStartedAt ? { activeStartedAt: record.activeStartedAt } : {}),
    ...(record?.lastStatus ? { lastStatus: record.lastStatus } : {}),
    ...(record?.lastCheckedAt ? { lastCheckedAt: record.lastCheckedAt } : {}),
    ...(record?.lastError ? { lastError: record.lastError } : {}),
  };
}

/** Persiste trabajo pendiente antes de publicar objetos bajo el prefijo observado por Bedrock. */
export async function markIngestionPending(store: Store, now: Date): Promise<void> {
  await store.db.update(INGESTION_STATE_KEY, {
    add: { generation: 1 },
    set: { dirtyAt: now.toISOString(), lastStatus: 'PENDING' },
    remove: ['lastError'],
  });
}

/** Escribe .md + .metadata.json solo si la nota es nueva o cambió (contentHash). */
export async function upsertArticles(deps: CorpusDeps, articles: Article[]): Promise<UpsertResult> {
  const result: UpsertResult = { written: 0, unchanged: 0, failed: 0, writtenIds: [], failedIds: [] };
  for (const article of articles) {
    const key = s3KeyFor(article);
    let indexCommitted = false;
    try {
      const hash = articleHash(article);
      const existing = await deps.store.getCorpusIndex(article.articleId);
      if (existing && existing.contentHash === hash && !existing.removed) {
        result.unchanged += 1;
        continue;
      }

      await markIngestionPending(deps.store, deps.now());
      await deps.s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: toMarkdown(article), ContentType: 'text/markdown; charset=utf-8' }));
      await deps.s3.send(
        new PutObjectCommand({ Bucket: deps.bucket, Key: `${key}.metadata.json`, Body: JSON.stringify(toMetadata(article, hash)), ContentType: 'application/json' }),
      );
      const record: Omit<CorpusIndexRecord, 'PK' | 'SK' | 'type'> = {
        articleId: article.articleId,
        contentHash: hash,
        s3Key: key,
        date: article.date,
        title: article.title,
        url: article.url,
        section: topicFromSection(article.section),
        origin: article.origin,
        updatedAt: deps.now().toISOString(),
      };
      await deps.store.putCorpusIndex(record);
      indexCommitted = true;
      if (!existing || existing.removed) await deps.store.incrementCorpusDay(article.date, 1);
      if (existing && existing.s3Key !== key) {
        await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: existing.s3Key }));
        await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: `${existing.s3Key}.metadata.json` }));
      }
      result.written += 1;
      result.writtenIds.push(article.articleId);
    } catch (error) {
      if (!indexCommitted) {
        await Promise.allSettled([
          deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: key })),
          deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: `${key}.metadata.json` })),
        ]);
      }
      result.failed += 1;
      result.failedIds.push(article.articleId);
      console.error(JSON.stringify({ level: 'error', message: 'corpus.upsert_failed', articleId: article.articleId, error: String(error) }));
    }
  }
  if (result.failed > 0) throw new CorpusUpsertError(result);
  return result;
}

/** Quita una nota del corpus (backoffice): borra objetos, marca el índice y reingesta. */
export async function removeArticle(deps: CorpusDeps, articleId: string): Promise<CorpusIndexRecord | undefined> {
  const existing = await deps.store.getCorpusIndex(articleId);
  if (!existing) return undefined;
  await markIngestionPending(deps.store, deps.now());
  await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: existing.s3Key }));
  await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: `${existing.s3Key}.metadata.json` }));
  await deps.store.putCorpusIndex({ ...existing, removed: true, updatedAt: deps.now().toISOString() });
  await deps.store.incrementCorpusDay(existing.date, -1);
  return existing;
}

let agentClient: BedrockAgentClient | undefined;

function bedrockClient(): BedrockAgentClient {
  agentClient ??= new BedrockAgentClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return agentClient;
}

function ingestionIds(config: Config): { knowledgeBaseId: string; dataSourceId: string } {
  const knowledgeBaseId = config.corpus.knowledgeBaseId || process.env.KNOWLEDGE_BASE_ID;
  const dataSourceId = config.corpus.dataSourceId || process.env.DATA_SOURCE_ID;
  if (!knowledgeBaseId || !dataSourceId) throw new Error('Falta KNOWLEDGE_BASE_ID o DATA_SOURCE_ID para procesar la ingesta pendiente');
  return { knowledgeBaseId, dataSourceId };
}

/**
 * Consulta una ingesta sin esperar dentro de Lambda. Sólo publica corpus.version cuando
 * Bedrock confirma COMPLETE; los estados terminales fallidos se persisten y propagan.
 */
export async function checkIngestion(
  store: Store,
  config: Config,
  client: BedrockAgentClient = bedrockClient(),
): Promise<IngestionCheckResult> {
  const state = await getIngestionState(store);
  if (!state.activeJobId) {
    return { status: 'idle', pending: state.generation > state.completedGeneration };
  }
  const { knowledgeBaseId, dataSourceId } = ingestionIds(config);
  const output = await client.send(new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId: state.activeJobId }));
  const status = output.ingestionJob?.status;
  const checkedAt = new Date().toISOString();
  if (!status) throw new Error(`Bedrock no devolvió estado para la ingestión ${state.activeJobId}`);

  await store.db.update(INGESTION_STATE_KEY, { set: { lastStatus: status, lastCheckedAt: checkedAt } });
  if (status === 'COMPLETE') {
    const completedGeneration = state.activeGeneration ?? state.generation;
    await store.db.update(keys.config(), {
      set: {
        'config.corpus.version': state.activeJobId,
        'config.corpus.knowledgeBaseId': knowledgeBaseId,
        'config.corpus.dataSourceId': dataSourceId,
      },
      mustExist: true,
    });
    await store.db.update(INGESTION_STATE_KEY, {
      set: { completedGeneration, lastStatus: status, lastCheckedAt: checkedAt },
      remove: ['activeJobId', 'activeGeneration', 'activeStartedAt', 'lastError'],
    });
    const latest = await getIngestionState(store);
    return { status: 'complete', ingestionJobId: state.activeJobId, pending: latest.generation > completedGeneration };
  }

  if (status === 'FAILED' || status === 'STOPPED') {
    const reasons = output.ingestionJob?.failureReasons ?? [];
    await store.db.update(INGESTION_STATE_KEY, {
      set: { lastStatus: status, lastCheckedAt: checkedAt, lastError: reasons.join('; ') || status },
      remove: ['activeJobId', 'activeGeneration', 'activeStartedAt'],
    });
    throw new IngestionFailedError(state.activeJobId, status, reasons);
  }

  return { status: 'in-progress', ingestionJobId: state.activeJobId, pending: state.generation > (state.activeGeneration ?? 0) };
}

/**
 * Coordina una generación pendiente. Ante conflicto conserva la generación en Dynamo;
 * una invocación posterior (incluido el status helper) volverá a intentar iniciarla.
 */
export async function startIngestion(
  store: Store,
  config: Config,
  reason: string,
  client: BedrockAgentClient = bedrockClient(),
): Promise<string | undefined> {
  let state = await getIngestionState(store);
  if (state.activeJobId) {
    const checked = await checkIngestion(store, config, client);
    if (checked.status !== 'complete' || !checked.pending) return checked.ingestionJobId;
    state = await getIngestionState(store);
  }
  if (state.generation <= state.completedGeneration) return undefined;

  const { knowledgeBaseId, dataSourceId } = ingestionIds(config);
  try {
    const output = await client.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId, description: reason.slice(0, 200) }));
    const jobId = output.ingestionJob?.ingestionJobId;
    if (!jobId) throw new Error('Bedrock aceptó StartIngestionJob sin devolver ingestionJobId');
    await store.db.update(INGESTION_STATE_KEY, {
      set: {
        activeJobId: jobId,
        activeGeneration: state.generation,
        activeStartedAt: new Date().toISOString(),
        lastStatus: output.ingestionJob?.status ?? 'STARTING',
      },
      remove: ['lastError'],
    });
    return jobId;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConflictException') {
      await store.db.update(INGESTION_STATE_KEY, {
        set: { lastStatus: 'CONFLICT', lastCheckedAt: new Date().toISOString(), lastError: String(error) },
      });
      throw new IngestionConflictError();
    }
    throw error;
  }
}
