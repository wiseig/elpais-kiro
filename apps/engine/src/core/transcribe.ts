import { createHash, createHmac } from 'node:crypto';
import { PollyClient } from '@aws-sdk/client-polly';
import { SignatureV4 } from '@smithy/signature-v4';
import type { Config } from '@pelp/domain';

/**
 * URL firmada para que el navegador abra el streaming de Amazon Transcribe directo, sin pasar el
 * audio por la Lambda. La firma dura 5 minutos, que es el máximo que acepta el servicio; alcanza
 * para abrir la conexión, que después vive lo que dure la charla.
 */

/** Lo que el firmador de Smithy puede pasar: texto o bytes en cualquiera de sus envoltorios. */
type SourceData = string | ArrayBuffer | ArrayBufferView;

function asBytes(data: SourceData): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Sha256 con la forma que espera el firmador de Smithy (`HashConstructor`), sobre el crypto de Node. */
class NodeSha256 {
  private readonly hash;
  constructor(secret?: SourceData) {
    this.hash = secret !== undefined ? createHmac('sha256', asBytes(secret)) : createHash('sha256');
  }
  update(data: SourceData): void {
    this.hash.update(asBytes(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

// Las credenciales del rol: el cliente de Polly ya las resuelve, así que no hace falta otro
// proveedor ni otra dependencia.
const credentials = new PollyClient({ region: process.env.AWS_REGION ?? 'us-east-1' }).config.credentials;

export interface TranscribeUrl {
  url: string;
  languageCode: string;
  sampleRate: number;
  expiresInSeconds: number;
}

export async function presignTranscribeUrl(config: Config, region = process.env.AWS_REGION ?? 'us-east-1'): Promise<TranscribeUrl> {
  const { languageCode, sampleRate, vocabularyName } = config.audio.transcribe;
  const signer = new SignatureV4({ service: 'transcribe', region, credentials, sha256: NodeSha256 });
  const expiresInSeconds = 300;
  const query: Record<string, string> = {
    'language-code': languageCode,
    'media-encoding': 'pcm',
    'sample-rate': String(sampleRate),
    ...(vocabularyName ? { 'vocabulary-name': vocabularyName } : {}),
  };
  const signed = await signer.presign(
    {
      method: 'GET',
      protocol: 'wss:',
      hostname: `transcribestreaming.${region}.amazonaws.com`,
      port: 8443,
      path: '/stream-transcription-websocket',
      headers: { host: `transcribestreaming.${region}.amazonaws.com:8443` },
      query,
    },
    { expiresIn: expiresInSeconds },
  );
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(signed.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (value !== undefined) params.append(key, String(value));
  }
  return { url: `wss://${signed.hostname}:${signed.port}${signed.path}?${params.toString()}`, languageCode, sampleRate, expiresInSeconds };
}
