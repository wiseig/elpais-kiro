import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@pelp/domain';
import type { RetrievedChunk } from '@pelp/domain';
import { parseJsonObject } from '../src/converse';
import { costUsd } from '../src/cost';
import { rerankScore, selectChunks, sourcesFromChunks, toChunk } from '../src/retrieve';

const config = defaultConfig('x'.repeat(64));
const retrieval = config.answering.retrieval;
const now = Math.floor(Date.parse('2026-09-11T12:00:00Z') / 1000);

function chunk(overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    text: 'texto',
    score: 0.8,
    articleId: 'a',
    title: 'Nota',
    url: 'https://www.elpais.com.uy/n',
    date: '2026-09-10',
    dateEpoch: now - 86_400,
    section: 'informacion',
    ...overrides,
  };
}

describe('recuperación', () => {
  it('convierte metadata en citas y rechaza URLs ajenas', () => {
    const ok = toChunk(
      { content: { text: 'hola' }, score: 0.7, metadata: { title: 'T', url: 'https://www.elpais.com.uy/a', date: '2026-09-04', dateEpoch: 1789000000, section: 's', articleId: 'id1' } },
      config.guardrails.allowedUrlHosts,
    );
    expect(ok?.articleId).toBe('id1');
    expect(ok?.dateEpoch).toBe(1789000000);
    const bad = toChunk(
      { content: { text: 'hola' }, score: 0.7, metadata: { title: 'T', url: 'https://elpais.com/es' } },
      config.guardrails.allowedUrlHosts,
    );
    expect(bad).toBeUndefined();
  });

  it('pondera recencia: score × (0,7 + 0,3 × recencia)', () => {
    const fresh = chunk({ dateEpoch: now });
    const old = chunk({ dateEpoch: now - 365 * 86_400 });
    expect(rerankScore(fresh, retrieval, now)).toBeCloseTo(0.8, 5);
    expect(rerankScore(old, retrieval, now)).toBeCloseTo(0.8 * 0.7, 5);
  });

  it('deduplica por nota, limita chunks por nota y notas totales, descarta score bajo', () => {
    const candidates = [
      chunk({ articleId: 'a', text: 'a1', score: 0.9 }),
      chunk({ articleId: 'a', text: 'a2', score: 0.85 }),
      chunk({ articleId: 'a', text: 'a3', score: 0.84 }),
      chunk({ articleId: 'a', text: 'a4', score: 0.83 }),
      chunk({ articleId: 'b', text: 'b1', score: 0.7 }),
      chunk({ articleId: 'c', text: 'c1', score: 0.3 }),
    ];
    const selected = selectChunks(candidates, { ...retrieval, maxChunksPerArticle: 3 }, 5, now);
    expect(selected.filter((item) => item.articleId === 'a')).toHaveLength(3);
    expect(selected.some((item) => item.articleId === 'c')).toBe(false);
    expect(selected.map((item) => item.index)).toEqual([1, 2, 3, 4]);
    const limited = selectChunks(candidates, retrieval, 1, now);
    expect(new Set(limited.map((item) => item.articleId)).size).toBe(1);
  });

  it('las fuentes salen de la metadata en orden de uso', () => {
    const chunks = selectChunks([chunk({ articleId: 'a', text: 'a1' }), chunk({ articleId: 'b', text: 'b1', url: 'https://www.elpais.com.uy/b', score: 0.75 })], retrieval, 5, now);
    expect(sourcesFromChunks(chunks, [2, 1]).map((source) => source.url)).toEqual(['https://www.elpais.com.uy/b', 'https://www.elpais.com.uy/n']);
  });
});

describe('converse helpers', () => {
  it('extrae JSON aunque venga con fences y texto', () => {
    expect(parseJsonObject('Acá va:\n```json\n{"answer": "a {b}", "usedChunks": [1]}\n```\ngracias')).toEqual({ answer: 'a {b}', usedChunks: [1] });
    expect(parseJsonObject('sin json')).toBeUndefined();
    expect(parseJsonObject('{"s": "con \\"comillas\\" y }"}')).toEqual({ s: 'con "comillas" y }' });
  });

  it('calcula costo con precios de config y factores de caché', () => {
    const cost = costUsd(config.pricing, 'us.anthropic.claude-sonnet-4-6', {
      inputTokens: 3500,
      outputTokens: 350,
      cacheReadTokens: 1500,
      cacheWriteTokens: 0,
    });
    // 3500×3 + 350×15 + 1500×3×0,1 = 10,5 + 5,25 + 0,45 = 16,2 por millón
    expect(cost).toBeCloseTo(0.0162, 6);
    expect(costUsd(config.pricing, 'desconocido', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });
});
