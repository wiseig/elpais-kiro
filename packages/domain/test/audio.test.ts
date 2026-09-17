import { describe, expect, it } from 'vitest';
import { audioScript, bodyFromMarkdown, splitForSpeech } from '../src/audio';

const markdown = [
  '# Cancillería exhortó a legisladores',
  '',
  '- Medio: El País (Uruguay)',
  '- Fecha: 2026-09-14',
  '- URL: https://www.elpais.com.uy/informacion/politica/nota',
  '',
  '> La queja llegó por la vía diplomática.',
  '',
  'El embajador argentino presentó una nota formal.',
  'La delegación respondió que el stand es privado.',
  '',
  'El caso sigue abierto.',
  '',
].join('\n');

describe('bodyFromMarkdown', () => {
  it('deja el cuerpo en párrafos y descarta el encabezado', () => {
    const body = bodyFromMarkdown(markdown);
    expect(body.startsWith('El embajador argentino')).toBe(true);
    expect(body).not.toContain('- URL:');
    expect(body).not.toContain('La queja llegó');
    expect(body.split('\n\n')).toHaveLength(2);
  });

  it('devuelve vacío cuando la nota no tiene cuerpo', () => {
    expect(bodyFromMarkdown('# Solo título\n\n- Fecha: 2026-09-14\n')).toBe('');
  });
});

describe('audioScript', () => {
  it('lee título, bajada y cuerpo', () => {
    const script = audioScript({ title: 'Titular', deck: 'La bajada', body: 'El cuerpo.' }, 9000);
    expect(script.text).toBe('Titular\n\nLa bajada\n\nEl cuerpo.');
    expect(script.truncated).toBe(false);
    expect(script.chars).toBe(script.text.length);
  });

  it('corta en el límite de un párrafo, no en mitad de una frase', () => {
    const script = audioScript({ title: 'T', body: 'a'.repeat(40) + '\n\n' + 'b'.repeat(40) }, 50);
    expect(script.truncated).toBe(true);
    expect(script.text).not.toContain('b');
    expect(script.text.endsWith('a')).toBe(true);
  });

  it('si ni el primer párrafo entra, corta por palabra', () => {
    const script = audioScript({ title: 'uno dos tres cuatro cinco seis', body: '' }, 14);
    expect(script.truncated).toBe(true);
    expect(script.text.endsWith('-')).toBe(false);
    expect(script.text.length).toBeLessThanOrEqual(14);
  });
});

describe('splitForSpeech', () => {
  it('respeta el tope de cada llamada y no parte palabras', () => {
    const texto = Array.from({ length: 20 }, (_, i) => `Oración número ${i} con algo de texto adentro.`).join(' ');
    const chunks = splitForSpeech(texto, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('Oración número 19');
  });

  it('un texto corto va en una sola llamada', () => {
    expect(splitForSpeech('Corto.', 100)).toEqual(['Corto.']);
  });
});
