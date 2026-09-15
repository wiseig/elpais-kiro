import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  checkGrounding,
  checkInput,
  converseText,
  retrieveChunks,
  type ConverseTextOptions,
  type ConverseTextResult,
  type GroundingCheck,
  type GuardrailRef,
  type InputCheck,
  type RetrieveOptions,
  type RetrieveOutcome,
} from '@pelp/bedrock';
import { EVENT_SOURCE } from '@pelp/domain';

export interface ModelGateway {
  converse(options: ConverseTextOptions): Promise<ConverseTextResult>;
}

export interface RetrieverGateway {
  retrieve(options: RetrieveOptions): Promise<RetrieveOutcome>;
}

export interface GuardrailGateway {
  checkInput(ref: GuardrailRef, text: string, abortSignal?: AbortSignal): Promise<InputCheck>;
  checkGrounding(ref: GuardrailRef, input: { question: string; answer: string; sources: string[] }, abortSignal?: AbortSignal): Promise<GroundingCheck>;
}

export interface EventPublisher {
  publish(type: string, channel: string, detail: Record<string, unknown>): Promise<void>;
}

export class EventBridgePublisher implements EventPublisher {
  private readonly client = new EventBridgeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  constructor(private readonly busName: string | undefined) {}

  async publish(type: string, channel: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.busName) return;
    await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: EVENT_SOURCE,
            DetailType: type,
            Detail: JSON.stringify({ ...detail, channel, at: new Date().toISOString() }),
          },
        ],
      }),
    );
  }
}

export class NoopPublisher implements EventPublisher {
  readonly published: { type: string; channel: string; detail: Record<string, unknown> }[] = [];
  async publish(type: string, channel: string, detail: Record<string, unknown>): Promise<void> {
    this.published.push({ type, channel, detail });
  }
}

export const awsModels: ModelGateway = { converse: converseText };
export const awsRetriever: RetrieverGateway = { retrieve: retrieveChunks };
export const awsGuardrails: GuardrailGateway = { checkInput, checkGrounding };

export type { ConverseTextOptions, ConverseTextResult, GroundingCheck, GuardrailRef, InputCheck, RetrieveOptions, RetrieveOutcome };

/**
 * Lectura del cuerpo de una nota guardada en S3. El panorama no sale de una búsqueda semántica:
 * elige notas por fecha y sección desde el índice, que solo tiene título y bajada. Con eso el
 * modelo no puede escribir noticias, y el 15/9/2026 las escribía igual rellenando cargos y
 * nombres de su propio conocimiento ("el intendente de Montevideo, Mario Bergara"): el guardrail
 * lo frenaba con razón y el lector terminaba sin resumen. El cuerpo real es lo que le falta.
 */
export interface CorpusBodyGateway {
  read(s3Key: string): Promise<string | undefined>;
}

export class S3CorpusBody implements CorpusBodyGateway {
  private readonly client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  constructor(private readonly bucket: string | undefined) {}

  async read(s3Key: string): Promise<string | undefined> {
    if (!this.bucket) return undefined;
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }));
      return await output.Body?.transformToString();
    } catch {
      // Una nota que no se puede leer no puede tumbar el panorama: se cae al titular.
      return undefined;
    }
  }
}
