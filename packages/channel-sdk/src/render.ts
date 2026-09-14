import type { Answer, AnswerBlock, NoticeCode, SourceItem } from '@pelp/domain';

/** Parte un texto en trozos ≤ max respetando párrafos y, si hace falta, oraciones. */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (paragraph.length > max) {
      push();
      for (const sentence of paragraph.match(/[^.!?]+[.!?]*\s*/g) ?? [paragraph]) {
        if (sentence.length > max) {
          push();
          for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max).trim());
          continue;
        }
        if ((current + sentence).length > max) push();
        current += sentence;
      }
      push();
      continue;
    }
    if ((current + '\n\n' + paragraph).length > max) push();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();
  return out;
}

export function renderSourcesList(items: SourceItem[]): string {
  return items.map((source, index) => `${index + 1}. ${source.title} (${source.date})\n${source.url}`).join('\n');
}

/** Render a texto plano con fuentes numeradas (WhatsApp y otros canales de texto). */
export function answerToPlainText(answer: Answer, options: { maxChars: number; personalizedLabel?: string }): string[] {
  const parts: string[] = [];
  for (const block of answer.blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'notice':
        parts.push(`ℹ️ ${block.text}`);
        break;
      case 'sources':
        if (block.items.length) parts.push(`Fuentes:\n${renderSourcesList(block.items)}`);
        break;
      case 'cta':
        parts.push(`${block.text}: ${block.url}`);
        break;
      case 'suggestions':
        if (block.items.length) parts.push(`Podés seguir con:\n${block.items.map((item) => `• ${item}`).join('\n')}`);
        break;
      default:
        break;
    }
  }
  if (answer.personalized) parts.push(options.personalizedLabel ?? 'Adaptada a tus intereses. Escribí "neutral" para ver la versión neutral.');
  return splitText(parts.join('\n\n'), options.maxChars);
}

export function answerToMarkdown(answer: Answer): string {
  return answer.blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'notice':
          return `> ${block.text}`;
        case 'sources':
          return block.items.map((source) => `- [${source.title}](${source.url}) · ${source.date}`).join('\n');
        case 'cta':
          return `[${block.text}](${block.url})`;
        case 'suggestions':
          return block.items.map((item) => `- ${item}`).join('\n');
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

export function noticeBlock(text: string, code?: NoticeCode): AnswerBlock {
  return code ? { type: 'notice', text, code } : { type: 'notice', text };
}

/** Respuesta compuesta solo por un aviso (consentimiento, pausa, bloqueo…). */
export function noticeAnswer(input: { answerId: string; conversationId: string; text: string; code: NoticeCode; latencyMs?: number }): Answer {
  return {
    answerId: input.answerId,
    conversationId: input.conversationId,
    blocks: [noticeBlock(input.text, input.code)],
    hadCoverage: false,
    personalized: false,
    latencyMs: input.latencyMs ?? 0,
  };
}

export function firstText(answer: Answer): string {
  const block = answer.blocks.find((item) => item.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}
