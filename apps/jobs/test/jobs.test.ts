import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_CONSENT_TEXT_VERSION, defaultConfig, type ReaderProfile } from '@pelp/domain';
import { METADATA_BUDGET_BYTES, articleFromFeedItem, articleHash, metadataSize, s3KeyFor, toMarkdown, toMetadata, type FeedResponse } from '../src/lib/corpus';
import { parseFeed } from '../src/lib/feed';
import { datesBetween } from '../src/lib/dailybrief';
import { applyProfilerRules, decayFactor, mergeWeights } from '../src/profiler';
import { scoreCitations } from '../src/evals';
import { buildMail } from '../src/alert-mail';

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
    const metadata = toMetadata(first).metadataAttributes;
    expect(metadata.dateEpoch).toBe(Math.floor(Date.parse('2026-09-11T03:00:00Z') / 1000));
    expect(Object.keys(metadata).sort()).toEqual(['articleId', 'date', 'dateEpoch', 'section', 'title', 'url']);
  });

  it('la metadata entra en el tope de S3 Vectors incluso con título y URL enormes', () => {
    const [base] = parseFeed(feed, '2026-09-11');
    const largo = {
      ...base!,
      title: 'Título larguísimo '.repeat(30),
      url: `https://www.elpais.com.uy/${'segmento-largo/'.repeat(30)}nota`,
      deck: 'Bajada larga '.repeat(40),
      imageUrl: `https://imgs.elpais.com.uy/${'x'.repeat(400)}.jpg`,
      keywords: Array.from({ length: 40 }, (_, i) => `palabra-clave-${i}`),
      author: 'Autor '.repeat(40),
    };
    const attributes = toMetadata(largo).metadataAttributes;
    expect(metadataSize(attributes)).toBeLessThanOrEqual(METADATA_BUDGET_BYTES);
    // Lo que la búsqueda necesita sigue estando entero.
    expect(attributes.articleId).toBe(largo.articleId);
    expect(attributes.dateEpoch).toBeGreaterThan(0);
    expect(attributes.url).toContain('elpais.com.uy');
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

  it('la orientación sale de las posturas observadas, no de lo que el modelo etiqueta', () => {
    const rechazaIzquierda = Array.from({ length: 5 }, (_, i) => ({
      cita: `frase ${i}`,
      objetivo: 'izquierda' as const,
      postura: 'rechaza' as const,
    }));

    // El caso que el modelo devolvía invertido: quien rechaza a la izquierda queda a la derecha.
    const derecha = applyProfilerRules({ frames: [{ id: 'seguridad', weight: 0.9 }] }, base, config, now, 12, rechazaIzquierda);
    expect(derecha.politicalLean?.bucket).toBe('derecha');
    expect(derecha.politicalLean?.score).toBe(1);

    // Encuadres no políticos: no se infiere aunque haya posturas.
    const soloDeporte = applyProfilerRules(
      { topics: [{ id: 'deportes', weight: 1 }], frames: [{ id: 'deporte', weight: 1 }] },
      base,
      config,
      now,
      12,
      rechazaIzquierda,
    );
    expect(soloDeporte.politicalLean).toEqual({ score: 0, bucket: 'sin-señal', confidence: 0 });

    // Pocas posturas: no alcanza.
    const pocas = applyProfilerRules({ frames: [{ id: 'seguridad', weight: 0.9 }] }, base, config, now, 12, rechazaIzquierda.slice(0, 3));
    expect(pocas.politicalLean?.bucket).toBe('sin-señal');

    // Sin posturas: tampoco.
    const ninguna = applyProfilerRules({ frames: [{ id: 'seguridad', weight: 0.9 }] }, base, config, now, 12);
    expect(ninguna.politicalLean?.bucket).toBe('sin-señal');
    expect(derecha.version).toBe(2);
    expect(derecha.evidenceCount).toBe(12);
  });

  it('sin consentimiento sensible nunca guarda orientación', () => {
    const noConsent = { ...base, consent: { ...base.consent, sensitiveInference: false } };
    const posturas = Array.from({ length: 6 }, () => ({ cita: 'x', objetivo: 'izquierda' as const, postura: 'rechaza' as const }));
    const next = applyProfilerRules({ frames: [{ id: 'seguridad', weight: 0.9 }] }, noConsent, config, now, 12, posturas);
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


describe('hardening de corpus', () => {
  const article = {
    articleId: 'article-1',
    externalId: 'external-1',
    title: 'Título',
    deck: '',
    bodyText: 'Cuerpo',
    url: 'https://www.elpais.com.uy/nota',
    section: 'informacion',
    date: '2026-09-11',
    author: 'El País',
    keywords: [],
    origin: 'feed' as const,
  };

  it('falla rápido cuando falta CORPUS_BUCKET', async () => {
    const { runtime, setRuntime } = await import('../src/lib/runtime');
    const previousTable = process.env.TABLE_NAME;
    const previousBucket = process.env.CORPUS_BUCKET;
    try {
      process.env.TABLE_NAME = 'test-table';
      delete process.env.CORPUS_BUCKET;
      setRuntime(undefined);
      expect(() => runtime()).toThrow('Falta CORPUS_BUCKET');
    } finally {
      if (previousTable === undefined) delete process.env.TABLE_NAME;
      else process.env.TABLE_NAME = previousTable;
      if (previousBucket === undefined) delete process.env.CORPUS_BUCKET;
      else process.env.CORPUS_BUCKET = previousBucket;
      setRuntime(undefined);
    }
  });

  it('propaga upserts parciales, conserva IDs fallidos y deja ingesta pendiente', async () => {
    const { MemoryDb, Store } = await import('@pelp/engine/core');
    const { CorpusUpsertError, getIngestionState, upsertArticles } = await import('../src/lib/corpus');
    const store = new Store(new MemoryDb());
    const commands: string[] = [];
    const s3 = {
      async send(command: { constructor: { name: string }; input?: { Key?: string } }) {
        commands.push(`${command.constructor.name}:${command.input?.Key ?? ''}`);
        if (command.constructor.name === 'PutObjectCommand' && command.input?.Key?.endsWith('.metadata.json')) throw new Error('metadata falló');
        return {};
      },
    };

    const promise = upsertArticles({ store, s3: s3 as never, bucket: 'corpus', now: () => new Date('2026-09-11T12:00:00Z') }, [article]);
    await expect(promise).rejects.toMatchObject({ name: 'CorpusUpsertError', result: { failed: 1, failedIds: ['article-1'] } });
    expect((await getIngestionState(store)).generation).toBe(1);
    expect(commands.filter((command) => command.startsWith('DeleteObjectCommand:'))).toHaveLength(2);
  });

  it('actualiza corpus.version sólo después de COMPLETE', async () => {
    const { MemoryDb, Store } = await import('@pelp/engine/core');
    const { checkIngestion, markIngestionPending, startIngestion } = await import('../src/lib/corpus');
    const store = new Store(new MemoryDb());
    const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
    config.corpus.knowledgeBaseId = 'kb-1';
    config.corpus.dataSourceId = 'ds-1';
    await store.putConfig(config, 'test');
    await markIngestionPending(store, new Date('2026-09-11T12:00:00Z'));
    let status = 'IN_PROGRESS';
    const client = {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'StartIngestionJobCommand') {
          return { ingestionJob: { ingestionJobId: 'job-1', status: 'STARTING' } };
        }
        return { ingestionJob: { ingestionJobId: 'job-1', status } };
      },
    };

    expect(await startIngestion(store, config, 'test', client as never)).toBe('job-1');
    expect((await store.getConfigRecord())?.config.corpus.version).toBe('initial');
    expect(await checkIngestion(store, config, client as never)).toMatchObject({ status: 'in-progress', pending: false });
    expect((await store.getConfigRecord())?.config.corpus.version).toBe('initial');
    status = 'COMPLETE';
    expect(await checkIngestion(store, config, client as never)).toMatchObject({ status: 'complete', ingestionJobId: 'job-1', pending: false });
    expect((await store.getConfigRecord())?.config.corpus.version).toBe('job-1');
  });

  it('conserva la generación pendiente cuando StartIngestion encuentra conflicto', async () => {
    const { MemoryDb, Store } = await import('@pelp/engine/core');
    const { getIngestionState, markIngestionPending, startIngestion } = await import('../src/lib/corpus');
    const store = new Store(new MemoryDb());
    const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
    config.corpus.knowledgeBaseId = 'kb-1';
    config.corpus.dataSourceId = 'ds-1';
    await markIngestionPending(store, new Date('2026-09-11T12:00:00Z'));
    const conflictClient = {
      async send() {
        const error = new Error('busy');
        error.name = 'ConflictException';
        throw error;
      },
    };

    await expect(startIngestion(store, config, 'test', conflictClient as never)).rejects.toMatchObject({ name: 'IngestionConflictError' });
    expect(await getIngestionState(store)).toMatchObject({ generation: 1, completedGeneration: 0, lastStatus: 'CONFLICT' });
    const retryClient = {
      async send() {
        return { ingestionJob: { ingestionJobId: 'job-retry', status: 'STARTING' } };
      },
    };
    expect(await startIngestion(store, config, 'retry', retryClient as never)).toBe('job-retry');
  });
});

describe('hardening de Daily Brief y backfill', () => {
  it('propaga fetches individuales fallidos en vez de devolver un lote parcial', async () => {
    const { DailyBriefClient, DailyBriefFetchError } = await import('../src/lib/dailybrief');
    class StubClient extends DailyBriefClient {
      override async getArticle(articleId: string) {
        if (articleId === 'bad') throw new Error('timeout');
        return { articleId, title: 'Título', bodyText: 'Cuerpo', link: 'https://www.elpais.com.uy/nota' };
      }
    }
    const client = new StubClient({ email: 'service@example.com', password: 'secret', clientId: 'client' });
    const promise = client.fetchFull([{ articleId: 'ok' }, { articleId: 'bad' }], '2026-09-11', 'backfill');
    await expect(promise).rejects.toMatchObject({ name: 'DailyBriefFetchError', failures: [{ articleId: 'bad', error: expect.stringContaining('timeout') }] } satisfies Partial<InstanceType<typeof DailyBriefFetchError>>);
  });

  it('rechaza fechas imposibles y rangos mayores a 400 días sin truncarlos', () => {
    expect(() => datesBetween('2026-02-30', '2026-03-01')).toThrow('Fecha inválida');
    const start = Date.UTC(2025, 0, 1);
    const day = (offset: number) => new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
    expect(datesBetween(day(0), day(399))).toHaveLength(400);
    expect(() => datesBetween(day(0), day(400))).toThrow('excede el máximo de 400 días');
  });
});


describe('errores terminales de ingesta', () => {
  it('persiste FAILED con su motivo y lo propaga al invocador', async () => {
    const { MemoryDb, Store } = await import('@pelp/engine/core');
    const { checkIngestion, getIngestionState, markIngestionPending, startIngestion } = await import('../src/lib/corpus');
    const store = new Store(new MemoryDb());
    const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
    config.corpus.knowledgeBaseId = 'kb-1';
    config.corpus.dataSourceId = 'ds-1';
    await markIngestionPending(store, new Date('2026-09-11T12:00:00Z'));
    const startClient = {
      async send() {
        return { ingestionJob: { ingestionJobId: 'job-failed', status: 'STARTING' } };
      },
    };
    await startIngestion(store, config, 'test', startClient as never);
    const failedClient = {
      async send() {
        return { ingestionJob: { ingestionJobId: 'job-failed', status: 'FAILED', failureReasons: ['documento inválido'] } };
      },
    };

    await expect(checkIngestion(store, config, failedClient as never)).rejects.toMatchObject({ name: 'IngestionFailedError' });
    expect(await getIngestionState(store)).toMatchObject({
      generation: 1,
      completedGeneration: 0,
      lastStatus: 'FAILED',
      lastError: 'documento inválido',
    });
  });
});

describe('ids de ingestión desactualizados', () => {
  it('se corrige solo cuando el data source de la config ya no existe', async () => {
    const { MemoryDb, Store } = await import('@pelp/engine/core');
    const { markIngestionPending, startIngestion } = await import('../src/lib/corpus');
    const store = new Store(new MemoryDb());
    const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
    config.corpus.knowledgeBaseId = 'kb-vieja';
    config.corpus.dataSourceId = 'ds-viejo';
    await store.putConfig(config, 'test');
    await markIngestionPending(store, new Date('2026-09-13T22:00:00Z'));

    const previoKb = process.env.KNOWLEDGE_BASE_ID;
    const previoDs = process.env.DATA_SOURCE_ID;
    process.env.KNOWLEDGE_BASE_ID = 'kb-nueva';
    process.env.DATA_SOURCE_ID = 'ds-nuevo';
    const vistos: string[] = [];
    const client = {
      async send(command: { constructor: { name: string }; input: { dataSourceId: string } }) {
        vistos.push(command.input.dataSourceId);
        if (command.input.dataSourceId === 'ds-viejo') {
          const error = new Error('DataSource with id ds-viejo is not found.');
          error.name = 'ResourceNotFoundException';
          throw error;
        }
        return { ingestionJob: { ingestionJobId: 'job-nuevo', status: 'STARTING' } };
      },
    };

    try {
      expect(await startIngestion(store, config, 'test', client as never)).toBe('job-nuevo');
      expect(vistos).toEqual(['ds-viejo', 'ds-nuevo']);
      const guardada = await store.getConfigRecord();
      expect(guardada?.config.corpus.dataSourceId).toBe('ds-nuevo');
      expect(guardada?.config.corpus.knowledgeBaseId).toBe('kb-nueva');
    } finally {
      if (previoKb === undefined) delete process.env.KNOWLEDGE_BASE_ID;
      else process.env.KNOWLEDGE_BASE_ID = previoKb;
      if (previoDs === undefined) delete process.env.DATA_SOURCE_ID;
      else process.env.DATA_SOURCE_ID = previoDs;
    }
  });

  it('propaga el error si el entorno apunta al mismo recurso inexistente', async () => {
    const { MemoryDb, Store } = await import('@pelp/engine/core');
    const { markIngestionPending, startIngestion } = await import('../src/lib/corpus');
    const store = new Store(new MemoryDb());
    const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
    config.corpus.knowledgeBaseId = 'kb-1';
    config.corpus.dataSourceId = 'ds-1';
    await store.putConfig(config, 'test');
    await markIngestionPending(store, new Date('2026-09-13T22:00:00Z'));
    const previoKb = process.env.KNOWLEDGE_BASE_ID;
    const previoDs = process.env.DATA_SOURCE_ID;
    process.env.KNOWLEDGE_BASE_ID = 'kb-1';
    process.env.DATA_SOURCE_ID = 'ds-1';
    const client = {
      async send() {
        const error = new Error('no existe');
        error.name = 'ResourceNotFoundException';
        throw error;
      },
    };
    try {
      await expect(startIngestion(store, config, 'test', client as never)).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    } finally {
      if (previoKb === undefined) delete process.env.KNOWLEDGE_BASE_ID;
      else process.env.KNOWLEDGE_BASE_ID = previoKb;
      if (previoDs === undefined) delete process.env.DATA_SOURCE_ID;
      else process.env.DATA_SOURCE_ID = previoDs;
    }
  });
});

describe('retención del corpus', () => {
  const indexRecord = (articleId: string, date: string, removed = false) => ({
    articleId,
    contentHash: `hash-${articleId}`,
    s3Key: `notas/${date.replace(/-/g, '/')}/${articleId}.md`,
    date,
    title: `Nota ${articleId}`,
    url: `https://www.elpais.com.uy/${articleId}`,
    section: 'informacion',
    origin: 'feed' as const,
    updatedAt: `${date}T12:00:00.000Z`,
    ...(removed ? { removed: true } : {}),
  });

  async function setup() {
    const { MemoryDb, Store } = await import('@pelp/engine/core');
    const store = new Store(new MemoryDb());
    const deleted: string[] = [];
    const s3 = {
      async send(command: { constructor: { name: string }; input?: { Key?: string } }) {
        if (command.constructor.name === 'DeleteObjectCommand') deleted.push(command.input?.Key ?? '');
        return {};
      },
    };
    return { store, s3, deleted };
  }

  it('borra las notas anteriores al corte y deja las de la ventana', async () => {
    const { pruneCorpus, getIngestionState } = await import('../src/lib/corpus');
    const { store, s3, deleted } = await setup();
    await store.putCorpusIndex(indexRecord('vieja-1', '2026-05-01'));
    await store.putCorpusIndex(indexRecord('vieja-2', '2026-06-10'));
    await store.putCorpusIndex(indexRecord('reciente', '2026-09-10'));
    await store.incrementCorpusDay('2026-05-01', 1);

    const result = await pruneCorpus({ store, s3: s3 as never, bucket: 'corpus', now: () => new Date('2026-09-13T12:00:00Z') }, { cutoffDay: '2026-06-15' });

    expect(result).toMatchObject({ removed: 2, more: false });
    expect(deleted).toEqual([
      'notas/2026/06/10/vieja-2.md',
      'notas/2026/06/10/vieja-2.md.metadata.json',
      'notas/2026/05/01/vieja-1.md',
      'notas/2026/05/01/vieja-1.md.metadata.json',
    ]);
    expect((await store.getCorpusIndex('reciente'))?.removed).toBeUndefined();
    const tombstone = await store.getCorpusIndex('vieja-1');
    expect(tombstone?.removed).toBe(true);
    expect(tombstone?.expiresAt).toBeGreaterThan(Math.floor(Date.parse('2026-09-13T12:00:00Z') / 1000));
    expect((await getIngestionState(store)).generation).toBe(1);
  });

  it('no repite el borrado de una lápida ni deja ingesta pendiente sin trabajo', async () => {
    const { pruneCorpus, getIngestionState } = await import('../src/lib/corpus');
    const { store, s3, deleted } = await setup();
    await store.putCorpusIndex(indexRecord('ya-borrada', '2026-05-01', true));

    const result = await pruneCorpus({ store, s3: s3 as never, bucket: 'corpus', now: () => new Date('2026-09-13T12:00:00Z') }, { cutoffDay: '2026-06-15' });

    expect(result).toMatchObject({ removed: 0, more: false });
    expect(deleted).toEqual([]);
    expect((await getIngestionState(store)).generation).toBe(0);
  });

  it('respeta el tope por corrida y avisa que queda más', async () => {
    const { pruneCorpus } = await import('../src/lib/corpus');
    const { store, s3 } = await setup();
    for (let i = 0; i < 4; i += 1) await store.putCorpusIndex(indexRecord(`vieja-${i}`, '2026-05-01'));

    const result = await pruneCorpus({ store, s3: s3 as never, bucket: 'corpus', now: () => new Date('2026-09-13T12:00:00Z') }, { cutoffDay: '2026-06-15', limit: 2 });

    expect(result).toMatchObject({ removed: 2, more: true });
  });

  it('la config trae 90 días de retención y el horizonte de recencia acompaña', () => {
    const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
    expect(config.corpus.retentionDays).toBe(90);
    expect(config.answering.retrieval.recencyHorizonDays).toBe(90);
  });
});

describe('correo de alarmas', () => {
  it('traduce el aviso de CloudWatch a castellano y hora de Montevideo', () => {
    const { subject, body } = buildMail(
      {
        AlarmName: 'pelp-grounding-failures-dev',
        NewStateValue: 'ALARM',
        OldStateValue: 'OK',
        NewStateReason: 'Threshold Crossed: 1 datapoint [25.0] was greater than the threshold (10.0).',
        StateChangeTime: '2026-09-14T12:43:46.000Z',
      },
      'crudo',
    );
    expect(subject).toBe('Preguntale a El País — pelp-grounding-failures-dev en alarma');
    // 12:43 UTC son las 09:43 en Montevideo: era justo lo que confundía en el correo original.
    expect(body).toContain('09:43');
    expect(body).toContain('hora de Montevideo');
    expect(body).toContain('saltó');
    expect(body).not.toContain('12:43');
  });

  it('reenvía tal cual lo que no sea una alarma, antes que perderlo', () => {
    const { body } = buildMail({}, 'un aviso suelto');
    expect(body).toBe('un aviso suelto');
  });
});
