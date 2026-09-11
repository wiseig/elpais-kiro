import { describe, expect, it } from 'vitest';
import { dayToEpoch, needsRewrite, normalizeQuestion } from '../src/normalize';
import { isUlid, ulid, ulidTime } from '../src/ulid';
import { hasMetaTalk, isAllowedUrl, startsWithNoCoverage, validateAnswerText } from '../src/validators';
import { questionHash } from '../src/node';

describe('normalización', () => {
  it('iguala variantes de puntuación y mayúsculas', () => {
    expect(normalizeQuestion('¿Cuánto sube UTE?')).toBe('cuánto sube ute');
    expect(normalizeQuestion('cuanto sube UTE!!  ')).toBe('cuanto sube ute');
    expect(questionHash('¿Cuánto sube UTE?')).toBe(questionHash('cuánto sube ute'));
  });

  it('decide cuándo reescribir (6.4)', () => {
    expect(needsRewrite('¿y qué dijo el ministro?', false)).toBe(true);
    expect(needsRewrite('¿Qué medidas anunció el gobierno sobre el transporte esta semana?', false)).toBe(false);
    expect(needsRewrite('¿Qué medidas anunció el gobierno sobre eso esta semana?', false)).toBe(true);
    expect(needsRewrite('cualquier cosa', true)).toBe(true);
  });

  it('convierte días de Montevideo a epoch', () => {
    expect(dayToEpoch('2026-09-11')).toBe(Math.floor(Date.parse('2026-09-11T03:00:00Z') / 1000));
  });
});

describe('ulid', () => {
  it('genera ids válidos y ordenables por tiempo', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(isUlid(a)).toBe(true);
    expect(ulidTime(a)).toBe(1_000_000);
    expect(a < b).toBe(true);
  });
});

describe('validadores de salida', () => {
  const hosts = ['www.elpais.com.uy', 'elpais.com.uy'];
  it('solo acepta URLs de El País', () => {
    expect(isAllowedUrl('https://www.elpais.com.uy/informacion/nota', hosts)).toBe(true);
    expect(isAllowedUrl('https://elpais.com/espana', hosts)).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)', hosts)).toBe(false);
  });
  it('detecta meta-charla', () => {
    expect(hasMetaTalk('Según el fragmento, el dólar subió.')).toBe(true);
    expect(hasMetaTalk('Como IA no puedo opinar.')).toBe(true);
    expect(hasMetaTalk('El dólar cerró estable este viernes.')).toBe(false);
  });
  it('reporta párrafos y URLs ajenas', () => {
    const issues = validateAnswerText('a\n\nb\n\nc\n\nd https://google.com', { maxParagraphs: 3, allowedUrlHosts: hosts });
    expect(issues.map((issue) => issue.code)).toEqual(['too_many_paragraphs', 'foreign_url']);
  });
  it('reconoce la frase de sin cobertura', () => {
    expect(startsWithNoCoverage('El País no publicó sobre esto en los últimos días. Temas cercanos: …')).toBe(true);
  });
});
