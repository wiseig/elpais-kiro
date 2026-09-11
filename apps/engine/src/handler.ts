import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSEvent } from 'aws-lambda';
import type { InboundMessage } from '@pelp/domain';
import { ConfigProvider } from './core/config';
import { DynamoDb } from './core/db';
import { askQuestion, type EngineDeps } from './core/engine';
import { EventBridgePublisher, awsGuardrails, awsModels, awsRetriever } from './core/gateways';
import { logger } from './core/log';
import { identitySecret } from './core/secrets';
import { Store } from './core/store';
import { handleHttp, type WebDeps } from './web/routes';

let deps: Promise<WebDeps> | undefined;

async function buildDeps(): Promise<WebDeps> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('Falta TABLE_NAME');
  const store = new Store(new DynamoDb(tableName));
  const secret = await identitySecret();
  return {
    store,
    config: new ConfigProvider(store),
    models: awsModels,
    retriever: awsRetriever,
    guard: awsGuardrails,
    events: new EventBridgePublisher(process.env.EVENT_BUS_NAME),
    log: logger,
    now: () => new Date(),
    secret,
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? '*',
  };
}

function getDeps(): Promise<WebDeps> {
  deps ??= buildDeps().catch((error: unknown) => {
    deps = undefined;
    throw error;
  });
  return deps;
}

interface QueuedMessage {
  inbound: InboundMessage;
  ctx?: { conversationId?: string; meta?: Record<string, string> };
}

/** Canales asíncronos (10.1): SQS pelp-inbound → motor → evento AnswerReady para el adaptador. */
async function handleQueue(engine: EngineDeps, event: SQSEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as QueuedMessage;
      const result = await askQuestion(engine, message.inbound);
      await engine.events.publish('AnswerReady', message.inbound.channel, {
        answer: result.answer,
        channelUserId: message.inbound.channelUserId,
        conversationId: result.answer.conversationId,
        ...(message.ctx?.meta ? { meta: message.ctx.meta } : {}),
      });
    } catch (error) {
      logger.error('queue.failed', { messageId: record.messageId, error: String(error) });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

export async function handler(event: APIGatewayProxyEvent | SQSEvent): Promise<APIGatewayProxyResult | { batchItemFailures: { itemIdentifier: string }[] }> {
  const resolved = await getDeps();
  if ('Records' in event) return handleQueue(resolved, event);
  return handleHttp(resolved, event);
}
