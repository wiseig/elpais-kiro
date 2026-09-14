import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchEventsClient } from '@aws-sdk/client-cloudwatch-events';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SNSClient } from '@aws-sdk/client-sns';
import { ConfigProvider, DynamoDb, Store } from '@pelp/engine/core';

export interface AdminContext {
  store: Store;
  config: ConfigProvider;
  actor: string;
  now: Date;
  s3: S3Client;
  lambda: LambdaClient;
  bedrockAgent: BedrockAgentClient;
  events: CloudWatchEventsClient;
  cloudwatch: CloudWatchClient;
  sns: SNSClient;
  cognito: CognitoIdentityProviderClient;
  env: NodeJS.ProcessEnv;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': process.env.ALLOWED_ORIGIN ?? '*',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

export function parseBody<T extends Record<string, unknown>>(event: APIGatewayProxyEvent): Partial<T> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(raw, 'utf8') > 512 * 1024) throw new HttpError(413, 'Cuerpo demasiado grande.', 'too_large');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Partial<T>;
  } catch {
    throw new HttpError(400, 'El cuerpo debe ser JSON válido.', 'invalid_json');
  }
}

export function query(event: APIGatewayProxyEvent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) if (value !== undefined) out[key] = value;
  return out;
}

export function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Claims del authorizer Cognito de API Gateway REST. Exige grupo admin (sección 11). */
export function requireAdmin(event: APIGatewayProxyEvent): string {
  const claims = (event.requestContext?.authorizer as { claims?: Record<string, unknown> } | undefined)?.claims;
  if (!claims) {
    if (process.env.PELP_ALLOW_UNAUTH === '1') return 'local-dev';
    throw new HttpError(401, 'Autenticación requerida.', 'unauthorized');
  }
  const rawGroups = claims['cognito:groups'];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.map(String)
    : typeof rawGroups === 'string'
      ? rawGroups.replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean)
      : [];
  if (!groups.includes('admin')) throw new HttpError(403, 'Requiere grupo admin.', 'forbidden');
  return String(claims.email ?? claims['cognito:username'] ?? claims.sub ?? 'admin');
}

let shared: Omit<AdminContext, 'actor' | 'now'> | undefined;

export function buildContext(actor: string): AdminContext {
  if (!shared) {
    const tableName = process.env.TABLE_NAME;
    if (!tableName) throw new Error('Falta TABLE_NAME');
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const store = new Store(new DynamoDb(tableName));
    shared = {
      store,
      config: new ConfigProvider(store, 0),
      s3: new S3Client({ region }),
      lambda: new LambdaClient({ region }),
      bedrockAgent: new BedrockAgentClient({ region }),
      events: new CloudWatchEventsClient({ region }),
      cloudwatch: new CloudWatchClient({ region }),
      sns: new SNSClient({ region }),
      cognito: new CognitoIdentityProviderClient({ region }),
      env: process.env,
    };
  }
  return { ...shared, actor, now: new Date() };
}

export function setSharedContext(value: Omit<AdminContext, 'actor' | 'now'> | undefined): void {
  shared = value;
}

/** Invoca un job Lambda de forma asíncrona (Event). */
export async function invokeJob(ctx: AdminContext, envName: string, payload: Record<string, unknown>): Promise<{ started: boolean; detail?: string }> {
  const functionName = ctx.env[envName];
  if (!functionName) return { started: false, detail: `Falta ${envName} en el entorno de la admin-api` };
  await ctx.lambda.send(new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
  return { started: true };
}

export async function audit(ctx: AdminContext, action: string, target?: string, details: { before?: unknown; after?: unknown; reason?: string } = {}): Promise<void> {
  await ctx.store.putAudit({ actor: ctx.actor, action, ...(target ? { target } : {}), ...details, at: ctx.now.toISOString() });
}
