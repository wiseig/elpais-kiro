import { CANONICAL_STRICT_SUFFIX_V1, CANONICAL_SYSTEM_V1 } from './canonical.v1';
import { CANONICAL_STRICT_SUFFIX_V2, CANONICAL_SYSTEM_V2 } from './canonical.v2';
import { CANONICAL_STRICT_SUFFIX_V3, CANONICAL_SYSTEM_V3 } from './canonical.v3';
import { CANONICAL_STRICT_SUFFIX_V4, CANONICAL_SYSTEM_V4 } from './canonical.v4';
import { CANONICAL_STRICT_SUFFIX_V5, CANONICAL_SYSTEM_V5 } from './canonical.v5';
import { CANONICAL_STRICT_SUFFIX_V6, CANONICAL_SYSTEM_V6 } from './canonical.v6';
import { ADAPTATION_SYSTEM_V1 } from './adaptation.v1';
import { ADAPTATION_SYSTEM_V2 } from './adaptation.v2';
import { ADAPTATION_SYSTEM_V3 } from './adaptation.v3';
import { VERIFIER_SYSTEM_V1 } from './verifier.v1';
import { PROFILER_SYSTEM_V1 } from './profiler.v1';
import { profilerSystemV2 } from './profiler.v2';
import { profilerSystemV3 } from './profiler.v3';
import { profilerSystemV4 } from './profiler.v4';
import { REWRITE_SYSTEM_V1 } from './rewrite.v1';
import { REWRITE_SYSTEM_V2 } from './rewrite.v2';
import { REWRITE_SYSTEM_V3 } from './rewrite.v3';
import { deniedTopicConfirmV1 } from './denied.v1';
import { offTopicSystemV1 } from './offtopic.v1';
import { offTopicSystemV2 } from './offtopic.v2';
import { BIAS_JUDGE_SYSTEM_V1 } from './bias-judge.v1';

export type PromptKind = 'canonical' | 'adaptation' | 'verifier' | 'profiler' | 'rewrite' | 'offTopic' | 'biasJudge';

const STATIC_PROMPTS: Record<Exclude<PromptKind, 'offTopic'>, Record<string, string>> = {
  canonical: { v1: CANONICAL_SYSTEM_V1, v2: CANONICAL_SYSTEM_V2, v3: CANONICAL_SYSTEM_V3, v4: CANONICAL_SYSTEM_V4, v5: CANONICAL_SYSTEM_V5, v6: CANONICAL_SYSTEM_V6 },
  adaptation: { v1: ADAPTATION_SYSTEM_V1, v2: ADAPTATION_SYSTEM_V2, v3: ADAPTATION_SYSTEM_V3 },
  verifier: { v1: VERIFIER_SYSTEM_V1 },
  profiler: { v1: PROFILER_SYSTEM_V1 },
  rewrite: { v1: REWRITE_SYSTEM_V1, v2: REWRITE_SYSTEM_V2, v3: REWRITE_SYSTEM_V3 },
  biasJudge: { v1: BIAS_JUDGE_SYSTEM_V1 },
};

const OFF_TOPIC_PROMPTS: Record<string, (deniedTopics: readonly string[]) => string> = {
  v1: offTopicSystemV1,
  v2: offTopicSystemV2,
};

/** Confirmación de tema vedado: comparte la versión con el clasificador de alcance. */
const DENIED_TOPIC_PROMPTS: Record<string, (topic: string) => string> = {
  v1: deniedTopicConfirmV1,
  v2: deniedTopicConfirmV1,
};

const STRICT_SUFFIX: Record<string, string> = {
  v1: CANONICAL_STRICT_SUFFIX_V1,
  v2: CANONICAL_STRICT_SUFFIX_V2,
  v3: CANONICAL_STRICT_SUFFIX_V3,
  v4: CANONICAL_STRICT_SUFFIX_V4,
  v5: CANONICAL_STRICT_SUFFIX_V5,
  v6: CANONICAL_STRICT_SUFFIX_V6,
};

export function getPrompt(kind: Exclude<PromptKind, 'offTopic'>, version: string): string {
  const prompt = STATIC_PROMPTS[kind][version];
  if (!prompt) throw new Error(`Prompt ${kind}@${version} no existe`);
  return prompt;
}

export function getOffTopicPrompt(version: string, deniedTopics: readonly string[]): string {
  const factory = OFF_TOPIC_PROMPTS[version];
  if (!factory) throw new Error(`Prompt offTopic@${version} no existe`);
  return factory(deniedTopics);
}

/** Contexto político del perfilador: solo para entender de qué se habla, nunca para inferir. */
export interface PoliticalContext {
  enabled: boolean;
  government: string;
  parties: readonly string[];
  figures: readonly string[];
  notes: string;
}

export function buildPoliticalContext(context: PoliticalContext | undefined): string {
  if (!context?.enabled) return '';
  const lines = [
    context.government.trim() ? `Gobierno actual: ${context.government.trim()}` : '',
    context.parties.length ? `Partidos y coaliciones: ${context.parties.join('; ')}` : '',
    context.figures.length ? `Figuras y cargos frecuentes: ${context.figures.join('; ')}` : '',
    context.notes.trim(),
  ].filter(Boolean);
  if (!lines.length) return '';
  return `\n<CONTEXTO_URUGUAY>\n${lines.join('\n')}\n</CONTEXTO_URUGUAY>\n`;
}

const PROFILER_PROMPTS: Record<string, (context: string) => string> = {
  v1: () => PROFILER_SYSTEM_V1,
  v2: profilerSystemV2,
  v3: profilerSystemV3,
  v4: profilerSystemV4,
};

export function getProfilerPrompt(version: string, context: string): string {
  const factory = PROFILER_PROMPTS[version];
  if (!factory) throw new Error(`Prompt profiler@${version} no existe`);
  return factory(context);
}

export function getDeniedTopicPrompt(version: string, topic: string): string {
  const factory = DENIED_TOPIC_PROMPTS[version];
  if (!factory) throw new Error(`Prompt deniedTopic@${version} no existe`);
  return factory(topic);
}

export function getCanonicalStrictSuffix(version: string): string {
  return STRICT_SUFFIX[version] ?? CANONICAL_STRICT_SUFFIX_V1;
}

export function listPromptVersions(): Record<PromptKind, string[]> {
  return {
    canonical: Object.keys(STATIC_PROMPTS.canonical),
    adaptation: Object.keys(STATIC_PROMPTS.adaptation),
    verifier: Object.keys(STATIC_PROMPTS.verifier),
    profiler: Object.keys(PROFILER_PROMPTS),
    rewrite: Object.keys(STATIC_PROMPTS.rewrite),
    offTopic: Object.keys(OFF_TOPIC_PROMPTS),
    biasJudge: Object.keys(STATIC_PROMPTS.biasJudge),
  };
}

export * from './builders';
export {
  CANONICAL_SYSTEM_V1,
  CANONICAL_STRICT_SUFFIX_V1,
  CANONICAL_SYSTEM_V2,
  CANONICAL_STRICT_SUFFIX_V2,
  CANONICAL_SYSTEM_V3,
  CANONICAL_STRICT_SUFFIX_V3,
  CANONICAL_SYSTEM_V4,
  CANONICAL_SYSTEM_V5,
  CANONICAL_SYSTEM_V6,
  CANONICAL_STRICT_SUFFIX_V4,
  ADAPTATION_SYSTEM_V1,
  ADAPTATION_SYSTEM_V2,
  ADAPTATION_SYSTEM_V3,
  VERIFIER_SYSTEM_V1,
  PROFILER_SYSTEM_V1,
  REWRITE_SYSTEM_V1,
  REWRITE_SYSTEM_V2,
  REWRITE_SYSTEM_V3,
  BIAS_JUDGE_SYSTEM_V1,
  offTopicSystemV1,
  deniedTopicConfirmV1,
};
