import type { RetrieveAndGenerateCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime';

export interface Source {
  title: string;
  url: string;
  date: string;
  snippet: string;
}

type Citation = NonNullable<RetrieveAndGenerateCommandOutput['citations']>[number];
type RetrievedReference = NonNullable<Citation['retrievedReferences']>[number];

const TITLE_KEYS = new Set([
  'title',
  'titulo',
  'título',
  'documenttitle',
  'articletitle',
  'xamzbedrockkbtitle',
]);
const URL_KEYS = new Set([
  'url',
  'link',
  'sourceurl',
  'articleurl',
  'canonicalurl',
  'canonical',
]);
const DATE_KEYS = new Set([
  'date',
  'fecha',
  'publisheddate',
  'publishedat',
  'feeddate',
  'publicationdate',
]);

function normalizeKey(key: string): string {
  return key.toLocaleLowerCase('es').replace(/[^a-záéíóúüñ0-9]/g, '');
}

function attributeToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return undefined;

  const attribute = value as Record<string, unknown>;
  for (const key of ['stringValue', 'numberValue', 'booleanValue']) {
    const nestedValue = attribute[key];
    if (typeof nestedValue === 'string' && nestedValue.trim()) return nestedValue.trim();
    if (typeof nestedValue === 'number' || typeof nestedValue === 'boolean') {
      return String(nestedValue);
    }
  }
  return undefined;
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  acceptedKeys: Set<string>,
): string | undefined {
  if (!metadata) return undefined;

  for (const [key, value] of Object.entries(metadata)) {
    if (acceptedKeys.has(normalizeKey(key))) {
      const parsed = attributeToString(value);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function titleFrom(text: string): string | undefined {
  return firstMatch(text, [
    /^\s*#\s+(.+)$/m,
    /^\s*(?:t[ií]tulo|title)\s*:\s*(.+)$/im,
  ]);
}

function dateFrom(text: string): string | undefined {
  return firstMatch(text, [
    /^\s*(?:fecha|date|publicado|publicada)\s*:\s*(.+)$/im,
  ]);
}

function urlFrom(text: string): string | undefined {
  const labeledUrl = firstMatch(text, [
    /^\s*(?:url|enlace|link)\s*:\s*(https?:\/\/\S+)$/im,
  ]);
  if (labeledUrl) return labeledUrl.replace(/[),.;\]]+$/, '');

  return text
    .match(/https?:\/\/[^\s)\]]*elpais\.com\.uy[^\s)\]]*/i)?.[0]
    ?.replace(/[),.;\]]+$/, '');
}

function locationUrl(reference: RetrievedReference): string | undefined {
  const location = reference.location;
  if (!location) return undefined;

  if (location.webLocation?.url) return location.webLocation.url;
  if (location.confluenceLocation?.url) return location.confluenceLocation.url;
  if (location.salesforceLocation?.url) return location.salesforceLocation.url;
  if (location.sharePointLocation?.url) return location.sharePointLocation.url;
  return undefined;
}

function isElPaisUrl(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      (url.hostname === 'elpais.com.uy' || url.hostname.endsWith('.elpais.com.uy'))
    );
  } catch {
    return false;
  }
}

function anyEditorialUrl(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  for (const value of Object.values(metadata)) {
    const parsed = attributeToString(value);
    if (isElPaisUrl(parsed)) return parsed;
  }
  return undefined;
}

function snippetFrom(text: string): string {
  const body = text
    .split('\n')
    .filter((line) => !/^\s*(?:#|t[ií]tulo|title|fecha|date|secci[oó]n|url|enlace|link)\s*[:#]?/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (body.length <= 280) return body;
  return `${body.slice(0, 277).trimEnd()}…`;
}

function sourceFrom(reference: RetrievedReference): Source | undefined {
  const text = reference.content?.text?.trim() ?? '';
  const metadata = reference.metadata as Record<string, unknown> | undefined;
  const title = metadataValue(metadata, TITLE_KEYS) ?? titleFrom(text);
  const candidateUrl =
    metadataValue(metadata, URL_KEYS) ?? anyEditorialUrl(metadata) ?? urlFrom(text) ?? locationUrl(reference);
  const date = metadataValue(metadata, DATE_KEYS) ?? dateFrom(text) ?? '';

  if (!title || !isElPaisUrl(candidateUrl)) return undefined;

  return {
    title,
    url: candidateUrl,
    date,
    snippet: snippetFrom(text),
  };
}

export function extractSources(
  citations: RetrieveAndGenerateCommandOutput['citations'],
  limit: number,
): Source[] {
  const unique = new Map<string, Source>();

  for (const citation of citations ?? []) {
    for (const reference of citation.retrievedReferences ?? []) {
      const source = sourceFrom(reference);
      if (source && !unique.has(source.url)) unique.set(source.url, source);
      if (unique.size >= limit) return [...unique.values()];
    }
  }

  return [...unique.values()];
}

interface TextRange {
  start: number;
  end: number;
}

function isClosingInvitation(text: string, isLast: boolean): boolean {
  return (
    isLast &&
    /^(?:le[ée]|pod[eé]s leer|te invitamos|para conocer|segu[ií] leyendo)\b/i.test(text) &&
    /\bEl País\b/i.test(text)
  );
}

/**
 * Falla cerrado si una oración factual no intersecta una cita que además tenga
 * una URL editorial utilizable. Los spans los produce RetrieveAndGenerate sobre
 * el texto final; la invitación editorial de cierre no necesita evidencia.
 */
export function isAnswerGrounded(
  answer: string,
  citations: RetrieveAndGenerateCommandOutput['citations'],
): boolean {
  const evidenceRanges: TextRange[] = [];

  for (const citation of citations ?? []) {
    if (extractSources([citation], 1).length === 0) continue;
    const span = citation.generatedResponsePart?.textResponsePart?.span;
    if (
      typeof span?.start === 'number' &&
      typeof span.end === 'number' &&
      span.end > span.start
    ) {
      evidenceRanges.push({ start: span.start, end: span.end });
    }
  }

  if (evidenceRanges.length === 0) return false;

  const sentencePattern = /[^.!?\n]+(?:[.!?]+|$)/g;
  const sentences = [...answer.matchAll(sentencePattern)]
    .map((match) => {
      const raw = match[0];
      const leadingWhitespace = raw.length - raw.trimStart().length;
      const start = (match.index ?? 0) + leadingWhitespace;
      const text = raw.trim();
      return { text, start, end: start + text.length };
    })
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence.text));

  return sentences.every((sentence, index) => {
    if (isClosingInvitation(sentence.text, index === sentences.length - 1)) return true;
    return evidenceRanges.some(
      (range) => range.start < sentence.end && range.end > sentence.start,
    );
  });
}
