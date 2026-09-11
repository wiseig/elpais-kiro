import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
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
