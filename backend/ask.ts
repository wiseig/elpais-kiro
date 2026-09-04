import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { EDITORIAL_PROMPT, NO_COVERAGE_MESSAGE } from './prompt';
import { extractSources, isAnswerGrounded } from './sources';

const MAX_QUESTION_LENGTH = 600;
const BEDROCK_TIMEOUT_MS = 25_000;
const bedrock = new BedrockAgentRuntimeClient({});

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

function parseQuestion(event: APIGatewayProxyEventV2): string {
  if (!event.body) throw new Error('INVALID_JSON');

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error('INVALID_JSON');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_QUESTION');
  }

  const question = (body as Record<string, unknown>).question;
  if (typeof question !== 'string' || !question.trim()) {
    throw new Error('INVALID_QUESTION');
  }

  const normalized = question.trim().replace(/\s+/g, ' ');
  if (normalized.length > MAX_QUESTION_LENGTH) {
    throw new Error('QUESTION_TOO_LONG');
  }

  return normalized;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  let question: string;
  try {
    question = parseQuestion(event);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'QUESTION_TOO_LONG') {
      return json(400, {
        error: `La pregunta no puede superar los ${MAX_QUESTION_LENGTH} caracteres.`,
      });
    }
    return json(400, { error: 'La pregunta es obligatoria y debe enviarse como JSON válido.' });
  }

  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;
  const modelArn = process.env.MODEL_ARN;
  if (!knowledgeBaseId || !modelArn) {
    console.error('Missing KNOWLEDGE_BASE_ID or MODEL_ARN configuration');
    return json(500, { error: 'El servicio no está configurado correctamente.' });
  }

  try {
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), BEDROCK_TIMEOUT_MS);

    let response;
    try {
      response = await bedrock.send(
        new RetrieveAndGenerateCommand({
          input: { text: question },
          retrieveAndGenerateConfiguration: {
            type: 'KNOWLEDGE_BASE',
            knowledgeBaseConfiguration: {
              knowledgeBaseId,
              modelArn,
              retrievalConfiguration: {
                vectorSearchConfiguration: {
                  numberOfResults: 8,
                },
              },
              generationConfiguration: {
                promptTemplate: {
                  textPromptTemplate: EDITORIAL_PROMPT,
                },
                inferenceConfig: {
                  textInferenceConfig: {
                    maxTokens: 700,
                    temperature: 0,
                    topP: 0.9,
                  },
                },
              },
            },
          },
        }),
        { abortSignal: abortController.signal },
      );
    } finally {
      clearTimeout(abortTimer);
    }

    let answer = response.output?.text?.trim() || NO_COVERAGE_MESSAGE;
    const noCoverage = answer.startsWith(NO_COVERAGE_MESSAGE);
    let sources = extractSources(response.citations, noCoverage ? 2 : 5);

    if (!noCoverage && (!isAnswerGrounded(answer, response.citations) || sources.length === 0)) {
      console.warn('Bedrock returned an answer without complete usable citation coverage');
      answer = NO_COVERAGE_MESSAGE;
      sources = [];
    }

    return json(200, { answer, sources });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error('RetrieveAndGenerate failed', { errorName });
    return json(502, {
      error: 'No pudimos consultar las notas en este momento. Probá de nuevo en unos segundos.',
    });
  }
}
