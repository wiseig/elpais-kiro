import type { Config, RetrievedChunk } from '@pelp/domain';
import { CURRENT_CONSENT_TEXT_VERSION, defaultConfig } from '@pelp/domain';
import type { ConverseTextOptions, ConverseTextResult, GroundingCheck, GuardrailRef, InputCheck, RetrieveOptions, RetrieveOutcome } from '../src/core/gateways';
import { NoopPublisher } from '../src/core/gateways';
import { StaticConfig } from '../src/core/config';
import { MemoryDb } from '../src/core/db';
import { silentLogger } from '../src/core/log';
import { Store } from '../src/core/store';
import type { WebDeps } from '../src/web/routes';

export const SECRET = 'test-secret-0123456789';

export function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    text: 'Frigorífico Tacuarembó envió a 1.300 trabajadores al seguro de paro, informó la empresa el 4 de setiembre.',
    score: 0.82,
    articleId: 'art-1',
    title: 'Alerta por sablazo en la industria cárnica',
    url: 'https://www.elpais.com.uy/negocios/frigorifico-tacuarembo',
    date: '2026-09-04',
    dateEpoch: Math.floor(Date.parse('2026-09-04T03:00:00Z') / 1000),
    section: 'negocios/empresas',
    ...overrides,
  };
}

export interface FakeModelState {
  calls: ConverseTextOptions[];
  canonicalJson: () => string;
  adaptationJson: () => string;
  verifierJson: () => string;
  rewriteJson: () => string;
  offTopicJson: () => string;
}

export function fakeModels(overrides: Partial<FakeModelState> = {}): FakeModelState & { converse(options: ConverseTextOptions): Promise<ConverseTextResult> } {
  const state: FakeModelState = {
    calls: [],
    canonicalJson: () =>
      JSON.stringify({
        answer: 'Frigorífico Tacuarembó envió a 1.300 trabajadores al seguro de paro, según lo publicado el 4 de setiembre.\n\nPodés leer la nota completa en El País.',
        usedChunks: [1],
        hadCoverage: true,
      }),
    adaptationJson: () =>
      JSON.stringify({
        answer: 'Para tu bolsillo: 1.300 trabajadores de Frigorífico Tacuarembó fueron enviados al seguro de paro, según lo publicado el 4 de setiembre.\n\nPodés leer la nota completa en El País.',
        changed: true,
        explain: 'Sueles preguntar por empleo, por eso empezamos por el impacto laboral.',
        suggestions: ['¿Qué dijo el sindicato?'],
      }),
    verifierJson: () => JSON.stringify({ ok: true, missingFacts: [], newFacts: [], citationsEqual: true, opinionDetected: false }),
    rewriteJson: () => JSON.stringify({ question: '¿Qué pasó con los trabajadores del Frigorífico Tacuarembó?' }),
    offTopicJson: () => JSON.stringify({ offTopic: false, confidence: 0.95, deniedTopic: null }),
    ...overrides,
  };
  return {
    ...state,
    async converse(options: ConverseTextOptions): Promise<ConverseTextResult> {
      state.calls.push(options);
      let text: string;
      if (options.system.startsWith('Actuás como editor de El País (Uruguay). Respondés')) text = state.canonicalJson();
      else if (options.system.includes('Reescribí la respuesta para este lector')) text = state.adaptationJson();
      else if (options.system.startsWith('Sos un verificador editorial')) text = state.verifierJson();
      else if (options.system.includes('Reescribí la nueva pregunta')) text = state.rewriteJson();
      else if (options.system.startsWith('Clasificás preguntas')) text = state.offTopicJson();
      else text = '{}';
      return { text, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', latencyMs: 5, modelId: options.modelId };
    },
  };
}

export function fakeRetriever(chunks: RetrievedChunk[] = [chunk()]) {
  const calls: RetrieveOptions[] = [];
  return {
    calls,
    async retrieve(options: RetrieveOptions): Promise<RetrieveOutcome> {
      calls.push(options);
      const indexed = chunks.map((item, index) => ({ ...item, index: index + 1 }));
      return { chunks: indexed, widened: false, rawCount: indexed.length };
    },
  };
}

export function fakeGuard(overrides: { input?: (text: string) => InputCheck; grounding?: () => GroundingCheck } = {}) {
  const groundingCalls: { answer: string }[] = [];
  return {
    groundingCalls,
    async checkInput(_ref: GuardrailRef, text: string): Promise<InputCheck> {
      return overrides.input ? overrides.input(text) : { action: 'pass', text, kinds: [] };
    },
    async checkGrounding(_ref: GuardrailRef, input: { question: string; answer: string; sources: string[] }): Promise<GroundingCheck> {
      groundingCalls.push({ answer: input.answer });
      return overrides.grounding ? overrides.grounding() : { passed: true, grounding: 0.9, relevance: 0.8, blockedByContent: false };
    },
  };
}

export function testConfig(mutate?: (config: Config) => void): Config {
  const config = defaultConfig(CURRENT_CONSENT_TEXT_VERSION);
  config.guardrails.bedrockGuardrailId = 'g1';
  config.guardrails.bedrockGuardrailVersion = '1';
  config.corpus.knowledgeBaseId = 'kb1';
  config.corpus.version = 'ing-1';
  mutate?.(config);
  return config;
}

export function buildDeps(options: { config?: Config; models?: ReturnType<typeof fakeModels>; retriever?: ReturnType<typeof fakeRetriever>; guard?: ReturnType<typeof fakeGuard>; now?: () => Date } = {}) {
  const db = new MemoryDb();
  const store = new Store(db);
  const models = options.models ?? fakeModels();
  const retriever = options.retriever ?? fakeRetriever();
  const guard = options.guard ?? fakeGuard();
  const events = new NoopPublisher();
  let tick = Date.parse('2026-09-11T15:00:00Z');
  const deps: WebDeps = {
    store,
    config: new StaticConfig(options.config ?? testConfig()),
    models,
    retriever,
    guard,
    events,
    log: silentLogger,
    now: options.now ?? (() => new Date((tick += 1000))),
    secret: SECRET,
  };
  return { deps, db, store, models, retriever, guard, events };
}
