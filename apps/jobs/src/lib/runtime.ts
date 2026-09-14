import { S3Client } from '@aws-sdk/client-s3';
import {
  ConfigProvider,
  DynamoDb,
  EventBridgePublisher,
  Store,
  awsGuardrails,
  awsModels,
  awsRetriever,
  logger,
  type EngineDeps,
} from '@pelp/engine/core';
import type { CorpusDeps } from './corpus';

let shared: { engine: EngineDeps; corpus: CorpusDeps } | undefined;

/** Dependencias reales compartidas por todos los jobs. */
export function runtime(): { engine: EngineDeps; corpus: CorpusDeps } {
  if (shared) return shared;
  const tableName = process.env.TABLE_NAME?.trim();
  if (!tableName) throw new Error('Falta TABLE_NAME');
  const bucket = process.env.CORPUS_BUCKET?.trim();
  if (!bucket) throw new Error('Falta CORPUS_BUCKET');
  const store = new Store(new DynamoDb(tableName));
  const now = () => new Date();
  shared = {
    engine: {
      store,
      config: new ConfigProvider(store),
      models: awsModels,
      retriever: awsRetriever,
      guard: awsGuardrails,
      events: new EventBridgePublisher(process.env.EVENT_BUS_NAME),
      log: logger,
      now,
    },
    corpus: {
      store,
      s3: new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' }),
      bucket,
      now,
    },
  };
  return shared;
}

export function setRuntime(value: { engine: EngineDeps; corpus: CorpusDeps } | undefined): void {
  shared = value;
}
