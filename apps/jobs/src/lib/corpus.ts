import type { S3Client } from '@aws-sdk/client-s3';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
  /** Primera imagen de la nota (feed `imagenes[0]`, API `images[0]`). */
  imageUrl?: string;
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
  images?: string[];
}

function firstHttpUrl(values: string[] | undefined): string | undefined {
  const candidate = (values ?? []).find((value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()));
  return candidate?.trim();
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
    ...(firstHttpUrl(item.imagenes) ? { imageUrl: firstHttpUrl(item.imagenes) } : {}),
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
    ...(firstHttpUrl(article.images) ? { imageUrl: firstHttpUrl(article.images) } : {}),
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

/** Tope de metadata filtrable por vector en S3 Vectors, con margen. */
export const METADATA_BUDGET_BYTES = 900;

/**
 * Metadata que acompaña a cada nota en la Knowledge Base. S3 Vectors acepta ~1 KB de metadata
 * filtrable por vector y descarta el documento en silencio si se pasa: el 13/9/2026 quedaron
 * sin indexar 80 notas del día, todas con URL de imagen larga. Por eso viaja solo lo que la
 * búsqueda necesita (filtro de fecha y datos de la fuente); la imagen, la bajada, el autor y
 * las palabras clave se leen del índice del corpus en DynamoDB al armar la respuesta.
 */
export function toMetadata(article: Article): { metadataAttributes: Record<string, string | number> } {
  // Bedrock rechaza atributos con string vacío ("invalid metadata attributes"): se omiten.
  const attributes: Record<string, string | number> = {
    articleId: article.articleId,
    title: article.title.slice(0, 200),
    url: article.url.slice(0, 300),
    section: article.section.slice(0, 60),
    date: article.date,
    dateEpoch: dayToEpoch(article.date),
  };
  // Red de seguridad: si un título o una URL extremos empujan el total, se recorta el título.
  let size = metadataSize(attributes);
  if (size > METADATA_BUDGET_BYTES) {
    const exceso = size - METADATA_BUDGET_BYTES;
    attributes.title = String(attributes.title).slice(0, Math.max(40, String(attributes.title).length - exceso));
    size = metadataSize(attributes);
  }
  return { metadataAttributes: attributes };
}

export function metadataSize(attributes: Record<string, string | number>): number {
  return Buffer.byteLength(JSON.stringify(attributes));
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
        new PutObjectCommand({ Bucket: deps.bucket, Key: `${key}.metadata.json`, Body: JSON.stringify(toMetadata(article)), ContentType: 'application/json' }),
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
        ...(article.imageUrl ? { imageUrl: article.imageUrl } : {}),
        ...(article.deck.trim() ? { deck: article.deck.trim().slice(0, 200) } : {}),
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

export interface PruneOptions {
  /** Se borra todo lo publicado en esta fecha o antes (YYYY-MM-DD, Montevideo). */
  cutoffDay: string;
  /** Tope por corrida para no pasarse del tiempo de Lambda. */
  limit?: number;
  /** Días que la ficha borrada queda como lápida en el índice antes de expirar sola. */
  tombstoneDays?: number;
}

export interface PruneResult {
  scanned: number;
  removed: number;
  /** true si quedaron notas viejas sin borrar por el tope de la corrida. */
  more: boolean;
}

const DEFAULT_PRUNE_LIMIT = 500;
const DEFAULT_TOMBSTONE_DAYS = 30;

/**
 * Borra del bucket y del índice las notas anteriores al corte de retención (ADR 0007). La
 * ficha queda como lápida con TTL para no re-bajar la misma nota, y la ingestión posterior
 * saca los vectores de la base de conocimiento.
 */
export async function pruneCorpus(deps: CorpusDeps, options: PruneOptions): Promise<PruneResult> {
  const limit = options.limit ?? DEFAULT_PRUNE_LIMIT;
  const tombstoneDays = options.tombstoneDays ?? DEFAULT_TOMBSTONE_DAYS;
  const candidates = await deps.store.listCorpusByDate('1970-01-01', options.cutoffDay, limit + 1);
  const stale = candidates.filter((record) => !record.removed);
  const batch = stale.slice(0, limit);
  const now = deps.now();
  const expiresAt = Math.floor(now.getTime() / 1000) + tombstoneDays * 86_400;

  for (const record of batch) {
    await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: record.s3Key }));
    await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.bucket, Key: `${record.s3Key}.metadata.json` }));
    await deps.store.putCorpusIndex({ ...record, removed: true, updatedAt: now.toISOString(), expiresAt });
    await deps.store.incrementCorpusDay(record.date, -1);
  }
  if (batch.length) await markIngestionPending(deps.store, now);
  return { scanned: candidates.length, removed: batch.length, more: stale.length > batch.length };
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

function isNotFound(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ResourceNotFoundException';
}

/**
 * Los ids de la config mandan sobre las variables de entorno, así que si la Knowledge Base o
 * el data source se recrean, la config vieja deja todas las ingestas fallando con
 * `ResourceNotFoundException` hasta que alguien la edite a mano (pasó el 13/9/2026 al cambiar
 * de data source). Cuando Bedrock dice que no existe, se vuelve a lo que despliega
 * CloudFormation y se corrige la config sola.
 */
async function healIngestionIds(
  store: Store,
  ids: { knowledgeBaseId: string; dataSourceId: string },
): Promise<{ knowledgeBaseId: string; dataSourceId: string } | undefined> {
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID?.trim();
  const dataSourceId = process.env.DATA_SOURCE_ID?.trim();
  if (!knowledgeBaseId || !dataSourceId) return undefined;
  if (knowledgeBaseId === ids.knowledgeBaseId && dataSourceId === ids.dataSourceId) return undefined;
  await store.db.update(keys.config(), {
    set: { 'config.corpus.knowledgeBaseId': knowledgeBaseId, 'config.corpus.dataSourceId': dataSourceId },
    mustExist: true,
  });
  console.warn(
    JSON.stringify({
      level: 'warn',
      message: 'corpus.ingestion_ids_healed',
      anteriores: ids,
      nuevos: { knowledgeBaseId, dataSourceId },
    }),
  );
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
  let ids = ingestionIds(config);
  let output;
  try {
    output = await client.send(new GetIngestionJobCommand({ ...ids, ingestionJobId: state.activeJobId }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const healed = await healIngestionIds(store, ids);
    if (!healed) throw error;
    ids = healed;
    // La ingestión activa era del recurso viejo: se descarta y queda pendiente para la próxima.
    await store.db.update(INGESTION_STATE_KEY, { set: { lastStatus: 'STOPPED', lastCheckedAt: new Date().toISOString() }, remove: ['activeJobId', 'activeGeneration', 'activeStartedAt'] });
    return { status: 'idle', pending: state.generation > state.completedGeneration };
  }
  const { knowledgeBaseId, dataSourceId } = ids;
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

  let ids = ingestionIds(config);
  try {
    let output;
    try {
      output = await client.send(new StartIngestionJobCommand({ ...ids, description: reason.slice(0, 200) }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const healed = await healIngestionIds(store, ids);
      if (!healed) throw error;
      ids = healed;
      output = await client.send(new StartIngestionJobCommand({ ...ids, description: reason.slice(0, 200) }));
    }
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
