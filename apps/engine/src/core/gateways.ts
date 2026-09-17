import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { splitForSpeech } from '@pelp/domain';
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

export class S3CorpusBody implements CorpusBodyGateway, AudioStoreGateway {
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

  async exists(key: string): Promise<boolean> {
    if (!this.bucket) return false;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    if (!this.bucket) throw new Error('Falta CORPUS_BUCKET');
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    if (!this.bucket) throw new Error('Falta CORPUS_BUCKET');
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}

/**
 * Guardado del audio ya sintetizado. Va al mismo bucket del corpus bajo `audio/`, fuera del
 * prefijo que indexa la Knowledge Base, así que no ensucia la búsqueda.
 */
export interface AudioStoreGateway {
  exists(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

/** Síntesis de voz. La implementación real es Amazon Polly. */
export interface SpeechGateway {
  synthesize(input: { text: string; voice: string; engine: string }): Promise<Uint8Array>;
}

export class PollySpeech implements SpeechGateway {
  private readonly client = new PollyClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

  /**
   * Polly acepta 3.000 caracteres por llamada, así que una nota entera se sintetiza por partes y
   * se pegan los MP3. El corte va por párrafo o por oración (ver `splitForSpeech`): partir por
   * cantidad de caracteres mete cortes en mitad de una palabra al unir los pedazos.
   */
  async synthesize({ text, voice, engine }: { text: string; voice: string; engine: string }): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (const chunk of splitForSpeech(text)) {
      const output = await this.client.send(
        new SynthesizeSpeechCommand({ Text: chunk, OutputFormat: 'mp3', VoiceId: voice as never, Engine: engine as never }),
      );
      const bytes = await output.AudioStream?.transformToByteArray();
      if (bytes?.length) parts.push(bytes);
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const audio = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      audio.set(part, offset);
      offset += part.length;
    }
    return audio;
  }
}
