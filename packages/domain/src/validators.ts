import type { AnswerBlock, SourceItem } from './types';

/** Solo URLs de los hosts permitidos (elpais.com.uy) pueden aparecer en respuestas y fuentes. */
export function isAllowedUrl(candidate: string, allowedHosts: readonly string[]): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export const META_TALK_PATTERNS: readonly RegExp[] = [
  /\bcomo (una )?(ia|inteligencia artificial|modelo de lenguaje|asistente virtual)\b/i,
  /\bseg[uú]n (el|los) fragmentos?\b/i,
  /\ben (el|los) fragmentos?\b/i,
  /\bla nota dice\b/i,
  /\b(el|los) (contexto|documentos?) (proporcionados?|provistos?|recibidos?)\b/i,
  /\bno tengo acceso\b/i,
  /\bmis instrucciones\b/i,
  /\bsystem prompt\b/i,
  /\bcomo asistente de el pa[ií]s\b/i,
];

export function hasMetaTalk(text: string): boolean {
  return META_TALK_PATTERNS.some((pattern) => pattern.test(text));
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)\]}>"']+/gi)].map((match) => match[0].replace(/[),.;:!?]+$/, ''));
}

export interface AnswerTextIssue {
  code: 'meta_talk' | 'too_many_paragraphs' | 'foreign_url' | 'empty' | 'bullets';
  detail: string;
}

/** Validadores propios de salida (sección 7): URLs solo de El País, sin meta-charla, ≤ N párrafos. */
export function validateAnswerText(
  text: string,
  options: { maxParagraphs: number; allowedUrlHosts: readonly string[] },
): AnswerTextIssue[] {
  const issues: AnswerTextIssue[] = [];
  if (!text.trim()) {
    issues.push({ code: 'empty', detail: 'Respuesta vacía.' });
    return issues;
  }
  const count = paragraphs(text).length;
  if (count > options.maxParagraphs) {
    issues.push({ code: 'too_many_paragraphs', detail: `${count} párrafos, máximo ${options.maxParagraphs}.` });
  }
  if (hasMetaTalk(text)) issues.push({ code: 'meta_talk', detail: 'Contiene meta-charla sobre el contexto o el modelo.' });
  for (const url of extractUrls(text)) {
    if (!isAllowedUrl(url, options.allowedUrlHosts)) issues.push({ code: 'foreign_url', detail: url });
  }
  if (/^\s*[-*•]\s+/m.test(text)) issues.push({ code: 'bullets', detail: 'Usa viñetas; el formato pedido es texto corrido.' });
  return issues;
}

/** Filtra fuentes a hosts permitidos y elimina duplicados por URL. */
export function sanitizeSources(sources: SourceItem[], allowedHosts: readonly string[]): SourceItem[] {
  const seen = new Set<string>();
  const out: SourceItem[] = [];
  for (const source of sources) {
    if (!isAllowedUrl(source.url, allowedHosts) || seen.has(source.url)) continue;
    seen.add(source.url);
    out.push(source);
  }
  return out;
}

export function textOfBlocks(blocks: AnswerBlock[]): string {
  return blocks
    .filter((block): block is Extract<AnswerBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

/** Frase exacta de la regla 5 del prompt canónico. */
export const NO_COVERAGE_MESSAGE = 'El País no publicó sobre esto en los últimos días.';

export function startsWithNoCoverage(text: string): boolean {
  return text.trim().replace(/\.$/, '').startsWith(NO_COVERAGE_MESSAGE.replace(/\.$/, ''));
}
