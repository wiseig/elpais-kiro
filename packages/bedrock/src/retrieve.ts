import {
  RetrieveCommand,
  type KnowledgeBaseRetrievalResult,
  type RetrievalFilter,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type { Config, RetrievedChunk, SourceItem } from '@pelp/domain';
import { dayToEpoch, isAllowedUrl } from '@pelp/domain';
import { bedrockAgentRuntime } from './clients';

export type RetrievalConfig = Config['answering']['retrieval'];

export interface RetrieveOptions {
  knowledgeBaseId: string;
  query: string;
  retrieval: RetrievalConfig;
  maxSources: number;
  allowedUrlHosts: readonly string[];
  now?: Date;
  abortSignal?: AbortSignal;
}

export interface RetrieveOutcome {
  chunks: RetrievedChunk[];
  widened: boolean;
  rawCount: number;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = metadata?.[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return Number.NaN;
}

/** Convierte un resultado de Retrieve en chunk con citas tomadas SOLO de la metadata (6.2). */
export function toChunk(result: KnowledgeBaseRetrievalResult, allowedUrlHosts: readonly string[]): RetrievedChunk | undefined {
  const text = result.content?.text?.trim();
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (!text) return undefined;
  const url = metadataString(metadata, 'url');
  const title = metadataString(metadata, 'title');
  if (!title || !isAllowedUrl(url, allowedUrlHosts)) return undefined;
  const date = metadataString(metadata, 'date');
  let dateEpoch = metadataNumber(metadata, 'dateEpoch');
  if (!Number.isFinite(dateEpoch)) dateEpoch = date ? dayToEpoch(date) : 0;
  const imageUrl = metadataString(metadata, 'imageUrl');
  const deck = metadataString(metadata, 'deck');
  return {
    text,
    score: typeof result.score === 'number' ? result.score : 0,
    articleId: metadataString(metadata, 'articleId') || url,
    title,
    url,
    date,
    dateEpoch,
    section: metadataString(metadata, 'section'),
    ...(imageUrl && isAllowedUrl(imageUrl, [...allowedUrlHosts, 'elpais.com.uy', 'glbimg.com', 'cloudfront.net', 'amazonaws.com']) ? { imageUrl } : {}),
    ...(deck ? { deck } : {}),
  };
}

/** score × ((1 - w) + w × recencia); la recencia decae linealmente a 0 en `recencyHorizonDays`. */
export function rerankScore(chunk: RetrievedChunk, retrieval: RetrievalConfig, nowEpoch: number): number {
  const ageDays = Math.max(0, (nowEpoch - chunk.dateEpoch) / 86_400);
  const recency = Math.max(0, 1 - ageDays / retrieval.recencyHorizonDays);
  const weight = retrieval.recencyWeight;
  return chunk.score * (1 - weight + weight * recency);
}

/** Reordena, deduplica por nota y limita chunks por nota y notas totales. */
export function selectChunks(
  candidates: RetrievedChunk[],
  retrieval: RetrievalConfig,
  maxSources: number,
  nowEpoch: number,
): RetrievedChunk[] {
  const scored = candidates
    .filter((chunk) => chunk.score >= retrieval.minScore)
    .map((chunk) => ({ chunk, rank: rerankScore(chunk, retrieval, nowEpoch) }))
    .sort((a, b) => b.rank - a.rank);

  const perArticle = new Map<string, number>();
  const selected: RetrievedChunk[] = [];
  for (const { chunk } of scored) {
    const count = perArticle.get(chunk.articleId) ?? 0;
    if (count >= retrieval.maxChunksPerArticle) continue;
    if (count === 0 && perArticle.size >= maxSources) continue;
    perArticle.set(chunk.articleId, count + 1);
    selected.push(chunk);
  }
  return selected.map((chunk, index) => ({ ...chunk, index: index + 1 }));
}

export async function retrieveChunks(options: RetrieveOptions): Promise<RetrieveOutcome> {
  const now = options.now ?? new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const sinceEpoch = nowEpoch - options.retrieval.recentDaysFirst * 86_400;

  const run = async (filter?: RetrievalFilter) => {
    const output = await bedrockAgentRuntime().send(
      new RetrieveCommand({
        knowledgeBaseId: options.knowledgeBaseId,
        retrievalQuery: { text: options.query.slice(0, 1000) },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: options.retrieval.topK,
            ...(filter ? { filter } : {}),
          },
        },
      }),
      { abortSignal: options.abortSignal },
    );
    return (output.retrievalResults ?? [])
      .map((result) => toChunk(result, options.allowedUrlHosts))
      .filter((chunk): chunk is RetrievedChunk => Boolean(chunk));
  };

  let candidates = await run({ greaterThanOrEquals: { key: 'dateEpoch', value: sinceEpoch } });
  let widened = false;
  const relevant = candidates.filter((chunk) => chunk.score >= options.retrieval.minScore).length;
  if (relevant < options.retrieval.minResultsBeforeWiden) {
    const wide = await run();
    const seen = new Set(candidates.map((chunk) => `${chunk.articleId}:${chunk.text.slice(0, 80)}`));
    for (const chunk of wide) {
      const key = `${chunk.articleId}:${chunk.text.slice(0, 80)}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(chunk);
      }
    }
    widened = true;
  }
  candidates = selectChunks(candidates, options.retrieval, options.maxSources, nowEpoch);
  return { chunks: candidates, widened, rawCount: candidates.length };
}

/** Fuentes en orden de primer uso; nunca salen del texto generado. */
export function sourcesFromChunks(chunks: RetrievedChunk[], usedIndexes: number[] | undefined): SourceItem[] {
  const indexes = usedIndexes && usedIndexes.length ? usedIndexes : chunks.map((chunk) => chunk.index ?? 0);
  const seen = new Set<string>();
  const sources: SourceItem[] = [];
  for (const index of indexes) {
    const chunk = chunks.find((candidate) => candidate.index === index);
    if (!chunk || seen.has(chunk.articleId)) continue;
    seen.add(chunk.articleId);
    sources.push({
      articleId: chunk.articleId,
      title: chunk.title,
      url: chunk.url,
      date: chunk.date,
      section: chunk.section,
      ...(chunk.imageUrl ? { imageUrl: chunk.imageUrl } : {}),
      ...(chunk.deck ? { deck: chunk.deck } : {}),
    });
  }
  return sources;
}
