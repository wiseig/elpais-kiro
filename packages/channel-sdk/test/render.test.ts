import { describe, expect, it } from 'vitest';
import type { Answer } from '@pelp/domain';
import { answerToPlainText, noticeAnswer, splitText } from '../src/render';

const answer: Answer = {
  answerId: 'a',
  conversationId: 'c',
  hadCoverage: true,
  personalized: true,
  latencyMs: 10,
  blocks: [
    { type: 'text', text: 'Primer párrafo.\n\nSegundo párrafo.' },
    { type: 'sources', items: [{ title: 'Nota', url: 'https://www.elpais.com.uy/n', date: '2026-09-04', section: 's' }] },
    { type: 'cta', text: 'Leé más', url: 'https://www.elpais.com.uy/' },
    { type: 'suggestions', items: ['¿Y el dólar?'] },
  ],
};

describe('render de canales', () => {
  it('texto plano con fuentes numeradas y marca de personalización', () => {
    const [text] = answerToPlainText(answer, { maxChars: 1600 });
    expect(text).toContain('1. Nota (2026-09-04)\nhttps://www.elpais.com.uy/n');
    expect(text).toContain('Adaptada a tus intereses');
    expect(text).toContain('• ¿Y el dólar?');
  });

  it('parte mensajes largos sin cortar párrafos cuando puede', () => {
    const parts = splitText(`${'a'.repeat(900)}\n\n${'b'.repeat(900)}`, 1600);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('a'.repeat(900));
  });

  it('parte párrafos gigantes por oraciones', () => {
    const parts = splitText(`${'Frase uno. '.repeat(200)}`, 500);
    expect(parts.every((part) => part.length <= 500)).toBe(true);
  });

  it('construye avisos', () => {
    const notice = noticeAnswer({ answerId: 'x', conversationId: 'c', text: 'Antes de empezar…', code: 'consent_required' });
    expect(notice.blocks[0]).toEqual({ type: 'notice', text: 'Antes de empezar…', code: 'consent_required' });
    expect(notice.hadCoverage).toBe(false);
  });
});
