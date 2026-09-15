import { describe, expect, it } from 'vitest';
import { parseOpenGraph, resolvePreview } from '../src/core/preview';
import { questionFromTitle, suggestionCards, suggestions, resetSuggestionsCache } from '../src/core/suggestions';
import { buildDeps, testConfig } from './fakes';

const HTML = `<!doctype html><html><head><title>Fallback &amp; título</title>
<meta property="og:title" content="Alerta por sablazo en la industria cárnica" />
<meta content="Frigorífico Tacuarembó alcanza los 1.300 trabajadores en seguro de paro" property="og:description">
<meta property="og:image" content="https://www.elpais.com.uy/resizer/v2/abc.jpg?auth=1&width=1200" />
<meta property="og:site_name" content="El País Uruguay">
</head><body>mucho html</body></html>`;

describe('preview Open Graph', () => {
  it('extrae título, descripción, imagen y sitio con ambos órdenes de atributos', () => {
    const og = parseOpenGraph(HTML);
    expect(og.title).toBe('Alerta por sablazo en la industria cárnica');
    expect(og.description).toContain('1.300 trabajadores');
    expect(og.imageUrl).toBe('https://www.elpais.com.uy/resizer/v2/abc.jpg?auth=1&width=1200');
    expect(og.siteName).toBe('El País Uruguay');
  });

  it('cae al <title> decodificado si no hay og:title', () => {
    expect(parseOpenGraph('<html><head><title>Solo &amp; título</title></head></html>').title).toBe('Solo & título');
  });

  it('resuelve con caché en DynamoDB y rechaza hosts ajenos', async () => {
    const { deps, store } = buildDeps();
    const config = testConfig();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const url = 'https://www.elpais.com.uy/negocios/nota#comentarios';
    const first = await resolvePreview({ store, now: deps.now, fetchImpl }, config, url);
    expect(first.imageUrl).toContain('abc.jpg');
    expect(first.fallback).toBe(false);
    const second = await resolvePreview({ store, now: deps.now, fetchImpl }, config, url);
    expect(second.title).toBe(first.title);
    expect(calls).toBe(1);
    await expect(resolvePreview({ store, now: deps.now, fetchImpl }, config, 'https://elpais.com/espana')).rejects.toThrow('host no permitido');
  });

  it('marca fallback cuando el sitio no responde y recuerda lo conocido', async () => {
    const { deps, store } = buildDeps();
    const fetchImpl = (async () => {
      throw new Error('timeout');
    }) as unknown as typeof fetch;
    const preview = await resolvePreview({ store, now: deps.now, fetchImpl }, testConfig(), 'https://www.elpais.com.uy/x', { title: 'Conocido', deck: 'Bajada' });
    expect(preview).toMatchObject({ fallback: true, title: 'Conocido', description: 'Bajada' });
  });
});

describe('tarjetas de sugerencias', () => {
  it('convierte títulos en preguntas naturales', () => {
    expect(questionFromTitle('Conflicto portuario: resolución de gobierno deja dudas en TCP')).toBe('¿Qué se sabe sobre "Conflicto portuario"?');
    expect(questionFromTitle('“Desapareceremos”: los comerciantes de 8 de Octubre')).toBe('¿Qué se sabe sobre "Desapareceremos"?');
    const long = questionFromTitle('Una cita imperdible para descubrir los sabores y aromas del té junto a la sommelier Mónica Devoto en Montevideo');
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).not.toContain('…');
    expect(long.endsWith('"?')).toBe(true);
  });

  it('descarta tendencias apoyadas en notas viejas y usa la actualidad', async () => {
    resetSuggestionsCache();
    const { deps, store } = buildDeps();
    const vieja = { title: 'Frigorífico Tacuarembó', url: 'https://www.elpais.com.uy/frigo', date: '2026-08-01', section: 'negocios' };
    const log = {
      convId: 'c1',
      channel: 'web',
      day: '2026-09-11',
      questionNormalized: 'qué pasó con el frigorífico',
      qnormHash: 'hash-viejo',
      hadCoverage: true,
      personalized: false,
      cached: false,
      sources: [vieja],
      canonicalAnswer: 'texto',
      topics: [],
      latencyMs: 10,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      model: 'us.amazon.nova-pro-v1:0',
      corpusVersion: 'v',
      turn: 0,
    };
    // Dos veces la misma pregunta: sería tendencia si la nota no fuera de hace más de un mes.
    await store.putQuestionLog({ ...log, msgId: '01M2D0000000000000000000A1', at: '2026-09-11T10:00:00.000Z', questionMasked: '¿Qué pasó con el Frigorífico Tacuarembó?' });
    await store.putQuestionLog({ ...log, msgId: '01M2D0000000000000000000A2', at: '2026-09-11T11:00:00.000Z', questionMasked: '¿Qué pasó con el Frigorífico Tacuarembó?' });

    const items = await suggestions(store, testConfig(), deps.now());
    expect(items).not.toContain('¿Qué pasó con el Frigorífico Tacuarembó?');

    resetSuggestionsCache();
    const cards = await suggestionCards(store, testConfig(), deps.now());
    expect(cards.every((card) => card.kind !== 'trending')).toBe(true);
  });

  it('ofrece las tendencias sin el diario de sujeto', async () => {
    resetSuggestionsCache();
    const { deps, store } = buildDeps();
    const fresca = { title: 'Cancillería y Malvinas', url: 'https://www.elpais.com.uy/malvinas', date: '2026-09-11', section: 'informacion/politica' };
    const log = {
      convId: 'c1',
      channel: 'web',
      day: '2026-09-11',
      questionNormalized: 'qué dice el país sobre cancillería y malvinas',
      qnormHash: 'hash-malvinas',
      hadCoverage: true,
      personalized: false,
      cached: false,
      sources: [fresca],
      canonicalAnswer: 'texto',
      topics: [],
      latencyMs: 10,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      model: 'us.amazon.nova-pro-v1:0',
      corpusVersion: 'v',
      turn: 0,
    };
    const pregunta = '¿Qué dice El País sobre "Cancillería y Malvinas"?';
    await store.putQuestionLog({ ...log, msgId: '01M2D0000000000000000000B1', at: '2026-09-11T10:00:00.000Z', questionMasked: pregunta });
    await store.putQuestionLog({ ...log, msgId: '01M2D0000000000000000000B2', at: '2026-09-11T11:00:00.000Z', questionMasked: pregunta });
    const items = await suggestions(store, testConfig(), deps.now());
    expect(items).toContain('¿Qué se sabe sobre "Cancillería y Malvinas"?');
    expect(items).not.toContain(pregunta);
  });

  it('rearma la portada al cambiar el día aunque la caché siga caliente', async () => {
    resetSuggestionsCache();
    const { store } = buildDeps();
    const day = '2026-09-11';
    const base = { contentHash: 'h', s3Key: 'k', origin: 'feed' as const, updatedAt: `${day}T00:00:00Z` };
    await store.putCorpusIndex({ ...base, articleId: 'ayer', date: day, title: 'Nota de ayer', url: 'https://www.elpais.com.uy/ayer', section: 'informacion', imageUrl: 'https://www.elpais.com.uy/img/ayer.jpg' });
    const primero = await suggestionCards(store, testConfig(), new Date('2026-09-11T18:00:00Z'));
    expect(primero[0]?.source?.url).toContain('/ayer');

    await store.putCorpusIndex({ ...base, articleId: 'hoy', date: '2026-09-12', title: 'Nota de hoy', url: 'https://www.elpais.com.uy/hoy', section: 'informacion', imageUrl: 'https://www.elpais.com.uy/img/hoy.jpg' });
    const segundo = await suggestionCards(store, testConfig(), new Date('2026-09-12T09:00:00Z'));
    expect(segundo[0]?.source?.url).toContain('/hoy');
  });

  it('arma la portada con notas recientes con foto y sin los moldes diarios', async () => {
    resetSuggestionsCache();
    const { deps, store } = buildDeps();
    const day = '2026-09-11';
    const base = { contentHash: 'h', s3Key: 'k', date: day, origin: 'feed' as const, updatedAt: `${day}T00:00:00Z` };
    await store.putCorpusIndex({ ...base, articleId: 'a', title: 'Este es el horóscopo del signo Aries hoy', url: 'https://www.elpais.com.uy/h', section: 'horoscopo' });
    await store.putCorpusIndex({ ...base, articleId: 'b', title: 'La soja golpeó las exportaciones', url: 'https://www.elpais.com.uy/soja', section: 'negocios', imageUrl: 'https://www.elpais.com.uy/img/soja.jpg', deck: 'Cayeron 16 %' });
    await store.putCorpusIndex({ ...base, articleId: 'c', title: 'Nacional con otra vibra', url: 'https://www.elpais.com.uy/nac', section: 'ovacion' });
    await store.putCorpusIndex({ ...base, articleId: 'd', title: 'Otra de negocios', url: 'https://www.elpais.com.uy/neg2', section: 'negocios' });
    const cards = await suggestionCards(store, testConfig(), deps.now());
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards.some((card) => card.source?.url.endsWith('/h'))).toBe(false);
    expect(cards[0]?.kind).toBe('recent');
    expect(cards.find((card) => card.source?.url.endsWith('/soja'))?.source?.imageUrl).toContain('soja.jpg');
  });

  it('solo ofrece notas con foto', async () => {
    resetSuggestionsCache();
    const { deps, store } = buildDeps();
    const day = '2026-09-11';
    const base = { contentHash: 'h', s3Key: 'k', date: day, origin: 'feed' as const, updatedAt: `${day}T00:00:00Z` };
    await store.putCorpusIndex({ ...base, articleId: 'sin', title: 'Nota sin foto', url: 'https://www.elpais.com.uy/sin', section: 'informacion' });
    await store.putCorpusIndex({ ...base, articleId: 'con1', title: 'Nota con foto', url: 'https://www.elpais.com.uy/con1', section: 'negocios', imageUrl: 'https://www.elpais.com.uy/img/1.jpg' });
    await store.putCorpusIndex({ ...base, articleId: 'con2', title: 'Otra con foto', url: 'https://www.elpais.com.uy/con2', section: 'ovacion', imageUrl: 'https://www.elpais.com.uy/img/2.jpg' });

    const cards = await suggestionCards(store, testConfig(), deps.now());
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => Boolean(card.source?.imageUrl))).toBe(true);
    expect(cards.some((card) => card.source?.url.endsWith('/sin'))).toBe(false);
  });

  it('elige las cuatro más recientes por hora de publicación y se renueva con la versión del corpus', async () => {
    resetSuggestionsCache();
    const { store } = buildDeps();
    const day = '2026-09-11';
    const base = { contentHash: 'h', s3Key: 'k', date: day, origin: 'feed' as const, section: 'informacion', updatedAt: `${day}T23:00:00Z` };
    for (const [id, hour] of [['a', '08'], ['b', '12'], ['c', '09'], ['d', '15'], ['e', '11'], ['f', '10']] as const) {
      await store.putCorpusIndex({ ...base, articleId: id, title: `Nota ${id}`, url: `https://www.elpais.com.uy/${id}`, imageUrl: `https://www.elpais.com.uy/img/${id}.jpg`, publishedAt: `${day}T${hour}:00:00Z` });
    }
    // Sin foto y más nueva que todas: no entra.
    await store.putCorpusIndex({ ...base, articleId: 'sinfoto', title: 'Sin foto', url: 'https://www.elpais.com.uy/sinfoto', publishedAt: `${day}T20:00:00Z` });
    const now = new Date('2026-09-11T23:30:00Z');
    const cards = await suggestionCards(store, testConfig(), now);
    expect(cards.map((card) => card.source?.url.split('/').pop())).toEqual(['d', 'b', 'e', 'f']);
    expect(cards.every((card) => card.kind === 'recent')).toBe(true);

    // Llega una nota nueva. Con la misma versión del corpus la portada no se toca (todavía no se
    // puede buscar); con la versión nueva, encabeza.
    await store.putCorpusIndex({ ...base, articleId: 'g', title: 'Nota g', url: 'https://www.elpais.com.uy/g', imageUrl: 'https://www.elpais.com.uy/img/g.jpg', publishedAt: `${day}T22:00:00Z` });
    const misma = await suggestionCards(store, testConfig(), now);
    expect(misma.map((card) => card.source?.url.split('/').pop())).toEqual(['d', 'b', 'e', 'f']);
    const nueva = await suggestionCards(store, testConfig((c) => { c.corpus.version = 'ing-2'; }), now);
    expect(nueva.map((card) => card.source?.url.split('/').pop())).toEqual(['g', 'd', 'b', 'e']);
  });
});
