import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_CONSENT_TEXT_VERSION, defaultConfig, type ReaderProfile } from '@pelp/domain';
import { articleFromFeedItem, articleHash, s3KeyFor, toMarkdown, toMetadata, type FeedResponse } from '../src/lib/corpus';
import { parseFeed } from '../src/lib/feed';
import { datesBetween } from '../src/lib/dailybrief';
import { applyProfilerRules, decayFactor, mergeWeights } from '../src/profiler';
import { scoreCitations } from '../src/evals';

const here = path.dirname(fileURLToPath(import.meta.url));
const feed = JSON.parse(readFileSync(path.join(here, '../../../packages/testing/fixtures/feed-sample.json'), 'utf8')) as FeedResponse;

describe('corpus', () => {
  it('normaliza el feed al formato de la sección 5.2 con articleId compatible con Daily Brief', () => {
    const articles = parseFeed(feed, '2026-09-11');
    expect(articles).toHaveLength(2);
    const first = articles[0]!;
    expect(first.articleId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bodyText).toBe('Cuerpo en HTML de la nota de prueba.');
    expect(s3KeyFor(first)).toBe(`notas/2026/09/11/${first.articleId}.md`);
    const md = toMarkdown(first);
    expect(md.startsWith('# Nota de prueba sobre tarifas\n\n- Medio: El País (Uruguay)\n- Fecha: 2026-09-11\n- Sección: informacion/politica\n- URL: https://www.elpais.com.uy/informacion/politica/nota-de-prueba-sobre-tarifas\n\n> Bajada de la nota de prueba.\n')).toBe(true);
    const metadata = toMetadata(first, articleHash(first)).metadataAttributes;
    expect(metadata.dateEpoch).toBe(Math.floor(Date.parse('2026-09-11T03:00:00Z') / 1000));
    expect(metadata.keywords).toBe('tarifas, UTE');
    expect(metadata.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('descarta ítems sin título, link o cuerpo', () => {
    expect(articleFromFeedItem({ notId: 'x', titulo: '', link: 'https://www.elpais.com.uy/a', cuerpo_texto: 'b' }, '2026-09-11')).toBeUndefined();
  });

  it('el hash cambia cuando cambia el cuerpo (detección de correcciones)', () => {
    const [a] = parseFeed(feed, '2026-09-11');
    expect(articleHash({ ...a!, bodyText: `${a!.bodyText} corregido` })).not.toBe(articleHash(a!));
  });

  it('genera rangos de fechas en Montevideo', () => {
    expect(datesBetween('2026-09-09', '2026-09-11')).toEqual(['2026-09-09', '2026-09-10', '2026-09-11']);
    expect(datesBetween('2026-09-11', '2026-09-09')).toEqual([]);
  });
});

describe('profiler', () => {
  const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
  const base: ReaderProfile = {
    readerId: 'r1',
    tenantId: 'el-pais',
    terms: { accepted: true, version: 'v', at: '2026-09-01T00:00:00Z' },
    consent: { personalization: true, sensitiveInference: true, version: 'v', at: '2026-09-01T00:00:00Z' },
    topics: [{ id: 'deportes', weight: 0.9 }],
    frames: [{ id: 'deporte', weight: 0.9 }],
    style: { length: 'media', dataAffinity: 'media', tone: 'directo' },
    evidenceCount: 5,
    updatedAt: '2026-08-01T00:00:00Z',
    version: 1,
  };
  const now = new Date('2026-09-11T00:00:00Z');

  it('decae el perfil viejo y fusiona con la inferencia nueva', () => {
    expect(decayFactor('2026-08-01T00:00:00Z', now, 90)).toBeCloseTo(1 - 41 / 90, 2);
    const merged = mergeWeights([{ id: 'deportes', weight: 0.9 }], [{ id: 'economia', weight: 0.8 }], 0.5);
    expect(merged).toEqual([{ id: 'economia', weight: 0.8 }, { id: 'deportes', weight: 0.45 }]);
  });

  it('no infiere orientación política desde encuadres no políticos ni sin 5 expresiones explícitas', () => {
    const next = applyProfilerRules(
      { topics: [{ id: 'deportes', weight: 1 }], frames: [{ id: 'deporte', weight: 1 }], politicalLean: { score: 0.8, bucket: 'derecha', confidence: 0.9, explicitStatements: 7 }, confidence: { topics: 0.9, frames: 0.9, style: 0.5 } },
      base,
      config,
      now,
      12,
    );
    expect(next.politicalLean).toEqual({ score: 0, bucket: 'sin-señal', confidence: 0 });
    const withPolitics = applyProfilerRules(
      { frames: [{ id: 'seguridad', weight: 0.9 }], politicalLean: { score: -0.5, bucket: 'centro-izquierda', confidence: 0.8, explicitStatements: 5 } },
      base,
      config,
      now,
      12,
    );
    expect(withPolitics.politicalLean?.bucket).toBe('centro-izquierda');
    const few = applyProfilerRules({ frames: [{ id: 'seguridad', weight: 0.9 }], politicalLean: { score: -0.5, bucket: 'centro-izquierda', confidence: 0.8, explicitStatements: 3 } }, base, config, now, 12);
    expect(few.politicalLean?.bucket).toBe('sin-señal');
    expect(withPolitics.version).toBe(2);
    expect(withPolitics.evidenceCount).toBe(12);
  });

  it('sin consentimiento sensible nunca guarda orientación', () => {
    const noConsent = { ...base, consent: { ...base.consent, sensitiveInference: false } };
    const next = applyProfilerRules({ frames: [{ id: 'seguridad', weight: 0.9 }], politicalLean: { score: 1, bucket: 'derecha', confidence: 1, explicitStatements: 9 } }, noConsent, config, now, 12);
    expect(next.politicalLean).toBeUndefined();
  });

  it('ignora encuadres fuera de la taxonomía', () => {
    const next = applyProfilerRules({ frames: [{ id: 'partido-x', weight: 1 }, { id: 'salud', weight: 0.5 }] }, base, config, now, 12);
    expect(next.frames.map((frame) => frame.id)).toEqual(expect.arrayContaining(['salud']));
    expect(next.frames.some((frame) => frame.id === 'partido-x')).toBe(false);
  });
});

describe('evals', () => {
  it('mide precisión y cobertura de citas ignorando www y query', () => {
    expect(scoreCitations(['https://www.elpais.com.uy/a?x=1', 'https://www.elpais.com.uy/b'], ['https://elpais.com.uy/a'])).toEqual({ precision: 0.5, recall: 1 });
    expect(scoreCitations([], [])).toEqual({ precision: 1, recall: 1 });
    expect(scoreCitations(['https://www.elpais.com.uy/a'], [])).toEqual({ precision: 0, recall: 1 });
  });
});
