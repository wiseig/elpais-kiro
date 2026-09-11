import {
  ApplyGuardrailCommand,
  type ApplyGuardrailCommandOutput,
  type GuardrailAssessment,
  type GuardrailContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { BlockKind } from '@pelp/domain';
import { bedrockRuntime } from './clients';

export interface GuardrailRef {
  id: string;
  version: string;
}

export interface InputCheck {
  action: 'pass' | 'block' | 'anonymize';
  /** Texto a usar de acá en más (enmascarado si hubo PII). */
  text: string;
  kinds: BlockKind[];
  detail?: string;
}

export interface GroundingCheck {
  passed: boolean;
  grounding?: number;
  relevance?: number;
  blockedByContent: boolean;
}

function assessments(output: ApplyGuardrailCommandOutput): GuardrailAssessment[] {
  return output.assessments ?? [];
}

/** Guardrails de entrada (sección 7): prompt attack, temas vedados, palabras, PII → ANONYMIZE. */
export async function checkInput(ref: GuardrailRef, text: string, abortSignal?: AbortSignal): Promise<InputCheck> {
  if (!ref.id || !ref.version) return { action: 'pass', text, kinds: [] };
  const output = await bedrockRuntime().send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: ref.id,
      guardrailVersion: ref.version,
      source: 'INPUT',
      content: [{ text: { text } }],
    }),
    { abortSignal },
  );

  const kinds: BlockKind[] = [];
  let anonymized = false;
  for (const assessment of assessments(output)) {
    for (const topic of assessment.topicPolicy?.topics ?? []) {
      if (topic.action === 'BLOCKED') kinds.push('denied_topic');
    }
    for (const filter of assessment.contentPolicy?.filters ?? []) {
      if (filter.action !== 'BLOCKED') continue;
      kinds.push(filter.type === 'PROMPT_ATTACK' ? 'prompt_attack' : 'content');
    }
    if ((assessment.wordPolicy?.customWords ?? []).some((word) => word.action === 'BLOCKED')) kinds.push('blocked_word');
    if ((assessment.wordPolicy?.managedWordLists ?? []).some((word) => word.action === 'BLOCKED')) kinds.push('blocked_word');
    for (const entity of assessment.sensitiveInformationPolicy?.piiEntities ?? []) {
      if (entity.action === 'ANONYMIZED') anonymized = true;
      if (entity.action === 'BLOCKED') kinds.push('content');
    }
    for (const regex of assessment.sensitiveInformationPolicy?.regexes ?? []) {
      if (regex.action === 'ANONYMIZED') anonymized = true;
      if (regex.action === 'BLOCKED') kinds.push('content');
    }
  }

  if (kinds.length) return { action: 'block', text, kinds: [...new Set(kinds)], detail: output.actionReason };
  if (anonymized) {
    const masked = (output.outputs ?? []).map((item) => item.text ?? '').join('').trim() || text;
    return { action: 'anonymize', text: masked, kinds: [] };
  }
  return { action: 'pass', text, kinds: [] };
}

/** Grounding contextual y filtros de salida sobre el texto final (sección 7). */
export async function checkGrounding(
  ref: GuardrailRef,
  input: { question: string; answer: string; sources: string[] },
  abortSignal?: AbortSignal,
): Promise<GroundingCheck> {
  if (!ref.id || !ref.version) return { passed: true, blockedByContent: false };
  const content: GuardrailContentBlock[] = [
    ...input.sources.map((source) => ({ text: { text: source, qualifiers: ['grounding_source' as const] } })),
    { text: { text: input.question, qualifiers: ['query'] } },
    { text: { text: input.answer, qualifiers: ['guard_content'] } },
  ];
  const output = await bedrockRuntime().send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: ref.id,
      guardrailVersion: ref.version,
      source: 'OUTPUT',
      content,
    }),
    { abortSignal },
  );

  let grounding: number | undefined;
  let relevance: number | undefined;
  let groundingBlocked = false;
  let blockedByContent = false;
  for (const assessment of assessments(output)) {
    for (const filter of assessment.contextualGroundingPolicy?.filters ?? []) {
      if (filter.type === 'GROUNDING') grounding = filter.score;
      if (filter.type === 'RELEVANCE') relevance = filter.score;
      if (filter.action === 'BLOCKED') groundingBlocked = true;
    }
    if ((assessment.contentPolicy?.filters ?? []).some((filter) => filter.action === 'BLOCKED')) blockedByContent = true;
    if ((assessment.topicPolicy?.topics ?? []).some((topic) => topic.action === 'BLOCKED')) blockedByContent = true;
  }
  return { passed: !groundingBlocked && !blockedByContent, grounding, relevance, blockedByContent };
}
