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
  // "Los fragmentos disponibles hablan sobre..." se le escapó al modelo el 15/9/2026 y llegó al
  // lector: "fragmento" es vocabulario nuestro, no de una nota. Se pide el sujeto o el adjetivo
  // para no marcar el uso legítimo ("un fragmento del discurso").
  /\b(los|las) fragmentos? (disponibles?|provistos?|proporcionados?|recibidos?|citados?|entregados?)\b/i,
  /\b(el|los) fragmentos? (no )?(hablan?|mencionan?|dicen?|indican?|muestran?|incluyen?|contienen?)\b/i,
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
/**
 * Cierre de cortesía tipo "podés leer la nota completa en El País". No es un hecho y no está en
 * ninguna fuente, así que al medir sustento arrastra el puntaje: una paráfrasis fiel pasaba de
 * 0,97 a 0,63 solo por llevarlo (medido contra el guardrail el 14/9/2026). El lector igual lo ve:
 * la respuesta trae un bloque `cta` aparte, tanto en la web como en los canales.
 */
const READING_VERB = /\b(le[eé]|leer|leel[ao]|ley[eé]ndo|consult[aá]|ampli[aá]|encontr[aá]|mir[aá]|invitamos|te dejo|te dejamos|segu[ií])/i;
const EL_PAIS = /\bel pa[ií]s\b/i;

/** Dónde arranca la última oración: después del último punto, signo o salto que no sea el final. */
function lastSentenceStart(text: string): number {
  for (let index = text.length - 2; index >= 0; index -= 1) {
    if ('.!?\n'.includes(text[index] ?? '')) {
      const rest = text.slice(index + 1);
      if (rest.trim()) return index + 1;
    }
  }
  return 0;
}

/** El texto sin ese cierre; si no lo tiene, o si es todo lo que hay, devuelve lo mismo. */
export function withoutClosingInvitation(answer: string): string {
  const trimmed = answer.trimEnd();
  const start = lastSentenceStart(trimmed);
  const last = trimmed.slice(start);
  if (!EL_PAIS.test(last) || !READING_VERB.test(last)) return trimmed;
  return trimmed.slice(0, start).trim() || trimmed;
}

export const NO_COVERAGE_MESSAGE = 'El País no publicó sobre esto en los últimos días.';

/**
 * Hay cobertura, pero el verificador de sustento no dejó pasar el resumen. Decir "no publicó"
 * era mentira: el lector veía la nota exacta listada como fuente debajo del aviso (14/9/2026).
 */
export const UNVERIFIED_MESSAGE =
  'El País sí publicó sobre esto, pero no pude armar un resumen que respalde palabra por palabra. Te dejo las notas para que las leas completas.';

/**
 * Detecta la frase de "sin cobertura" al inicio, incluso cuando el modelo la escribe con el
 * tema en el medio ("El País no publicó sobre Fulano en los últimos días"): así no se le
 * antepone otra vez la frase canónica y el lector no la lee dos veces.
 */
export function startsWithNoCoverage(text: string): boolean {
  const head = text.trim().slice(0, 160).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^el pais no (publico|ha publicado|tiene notas)/.test(head);
}
