/**
 * Lectura en voz de una nota (spec v2, 14.x). Dos escalones: el plan base usa la voz del propio
 * navegador —gratis, sin infraestructura y con la calidad más baja, que es justo el escalón que
 * corresponde— y el plan pro sintetiza en el servidor con una voz mejor. Lo del servidor se
 * guarda una sola vez por nota: el audio de una nota que no cambió no se vuelve a generar.
 */

export const AUDIO_PLANS = ['base', 'pro'] as const;
export type AudioPlan = (typeof AUDIO_PLANS)[number];

export function isAudioPlan(value: unknown): value is AudioPlan {
  return typeof value === 'string' && (AUDIO_PLANS as readonly string[]).includes(value);
}

/** Qué se pide: el texto para que lo diga el cliente, o el audio ya sintetizado. */
export const AUDIO_MODES = ['script', 'audio'] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];

export function isAudioMode(value: unknown): value is AudioMode {
  return typeof value === 'string' && (AUDIO_MODES as readonly string[]).includes(value);
}

/**
 * Cambiar cómo se arma el texto invalida lo ya guardado: sin esto, una nota cacheada seguiría
 * sonando con el guion viejo para siempre.
 */
export const AUDIO_SCRIPT_VERSION = 'v1';

export interface AudioScript {
  text: string;
  chars: number;
  /** La nota no entraba entera en el tope configurado. */
  truncated: boolean;
}

/** El cuerpo de una nota guardada como Markdown, sin el encabezado de metadatos. */
export function bodyFromMarkdown(markdown: string): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of markdown.split('\n')) {
    const text = line.trim();
    // El .md abre con el título, una lista de metadatos y la bajada citada; el cuerpo viene después.
    if (!text || text.startsWith('#') || text.startsWith('- ') || text.startsWith('> ')) {
      if (current.length) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(text);
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.join('\n\n').trim();
}

/**
 * El texto que se va a leer: título, bajada y cuerpo, separados por párrafos para que la voz
 * respire. Se corta en el límite de un párrafo y no en mitad de una frase: una nota cortada al
 * medio de una oración suena a error, no a resumen.
 */
export function audioScript(
  article: { title: string; deck?: string | undefined; body: string },
  maxChars: number,
): AudioScript {
  const parts = [article.title.trim(), (article.deck ?? '').trim(), article.body.trim()].filter(Boolean);
  const full = parts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  if (full.length <= maxChars) return { text: full, chars: full.length, truncated: false };

  const kept: string[] = [];
  let used = 0;
  for (const paragraph of full.split('\n\n')) {
    if (used + paragraph.length > maxChars) break;
    kept.push(paragraph);
    used += paragraph.length + 2;
  }
  // Si ni el primer párrafo entra, se corta por palabra antes que devolver nada.
  const text = kept.length ? kept.join('\n\n') : full.slice(0, full.lastIndexOf(' ', maxChars) + 1 || maxChars).trim();
  return { text, chars: text.length, truncated: true };
}

/**
 * Trozos que Polly acepta en una sola llamada (3.000 caracteres). Se parte por párrafo y, si un
 * párrafo no entra, por oración: cortar por cantidad de caracteres mete silencios en mitad de una
 * palabra al pegar los pedazos.
 */
export function splitForSpeech(text: string, limit = 2800): string[] {
  const chunks: string[] = [];
  let current = '';
  const push = (piece: string) => {
    if (!piece) return;
    if (current && current.length + piece.length + 1 > limit) {
      chunks.push(current);
      current = piece;
      return;
    }
    current = current ? `${current}\n${piece}` : piece;
  };
  for (const paragraph of text.split('\n\n')) {
    if (paragraph.length <= limit) {
      push(paragraph);
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (sentence.length <= limit) push(sentence);
      else for (let i = 0; i < sentence.length; i += limit) push(sentence.slice(i, i + limit));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
