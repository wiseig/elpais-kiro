import { ConverseCommand, type ConverseCommandOutput, type SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { TokenUsage } from '@pelp/domain';
import { ZERO_USAGE } from '@pelp/domain';
import { bedrockRuntime } from './clients';

export interface ConverseTextOptions {
  modelId: string;
  system: string;
  userText: string;
  maxTokens?: number;
  temperature?: number;
  /** Agrega un cachePoint de Bedrock al final del system prompt (6.3). */
  cacheSystem?: boolean;
  abortSignal?: AbortSignal;
}

export interface ConverseTextResult {
  text: string;
  usage: TokenUsage;
  stopReason: string;
  latencyMs: number;
  modelId: string;
}

export function usageFromConverse(output: ConverseCommandOutput): TokenUsage {
  const usage = output.usage;
  if (!usage) return { ...ZERO_USAGE };
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadInputTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
  };
}

export async function converseText(options: ConverseTextOptions): Promise<ConverseTextResult> {
  const started = Date.now();
  const system: SystemContentBlock[] = [{ text: options.system }];
  if (options.cacheSystem !== false) system.push({ cachePoint: { type: 'default' } });

  const output = await bedrockRuntime().send(
    new ConverseCommand({
      modelId: options.modelId,
      system,
      messages: [{ role: 'user', content: [{ text: options.userText }] }],
      inferenceConfig: {
        maxTokens: options.maxTokens ?? 1200,
        temperature: options.temperature ?? 0,
      },
    }),
    { abortSignal: options.abortSignal },
  );

  const text = (output.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  return {
    text,
    usage: usageFromConverse(output),
    stopReason: output.stopReason ?? 'unknown',
    latencyMs: Date.now() - started,
    modelId: options.modelId,
  };
}

/**
 * Extrae el primer objeto JSON de una respuesta de modelo, tolerando fences de
 * markdown y texto alrededor. Devuelve undefined si no hay JSON válido.
 */
export function parseJsonObject<T = Record<string, unknown>>(text: string): T | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const char = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
