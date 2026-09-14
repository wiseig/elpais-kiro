import { createHmac, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Answer, InboundMessage } from '@pelp/domain';
import { CONSENT_BUTTONS, CURRENT_CONSENT_TEXT, CURRENT_CONSENT_TEXT_VERSION, TENANT_ID } from '@pelp/domain';
import { hashChannelIdentity } from '@pelp/domain/node';
import { answerToPlainText, type ChannelAdapter, type ChannelContext, type OutboundPayload } from '@pelp/channel-sdk';

/**
 * Adaptador WhatsApp (Meta Cloud API, fase 3 — sección 10.3).
 * El número en claro vive exclusivamente en este proceso y en la tabla privada del canal.
 * SQS y AnswerReady usan siempre channelUserId hasheado; las acciones de canal viajan como
 * meta.action y text vacío para que consentimiento/borrado no se interpreten como preguntas.
 */

interface WhatsAppWebhook {
  entry?: { changes?: { value?: { messages?: WhatsAppMessage[]; metadata?: { phone_number_id?: string } } }[] }[];
}

interface WhatsAppMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: { button_reply?: { id?: string; title?: string } };
}

export const MAX_WHATSAPP_CHARS = 1600;
export const DEFAULT_IDENTITY_TTL_SECONDS = 30 * 24 * 60 * 60;

export type WhatsAppAction = 'consent_personalize' | 'consent_neutral' | 'neutral' | 'personalize' | 'delete_data' | 'help' | 'confirm_age_personalize';

interface ParsedWhatsAppMessage {
  inbound: InboundMessage;
  /** Dato privado: nunca serializar en SQS ni EventBridge. */
  phoneNumber: string;
}

function normalizeCommand(text: string): WhatsAppAction | undefined {
  const command = text.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const commands: Record<string, WhatsAppAction> = {
    neutral: 'neutral',
    personalizar: 'personalize',
    'borrar mis datos': 'delete_data',
    ayuda: 'help',
  };
  return commands[command];
}

function actionForMessage(message: WhatsAppMessage, text: string): WhatsAppAction | undefined {
  const button = parseConsentButton(message.interactive?.button_reply?.id);
  if (button) return button.action;
  return message.type === 'text' || message.text?.body !== undefined ? normalizeCommand(text) : undefined;
}
let hydrated = false;
/** Secretos por ARN (Secrets Manager), nunca en variables de entorno en claro (sección 15). */
async function hydrateEnvFromSecrets(map: Record<string, string>): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const read = async (arn: string | undefined): Promise<string | undefined> => {
    if (!arn) return undefined;
    const output = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    return output.SecretString;
  };
  const identity = await read(process.env.IDENTITY_SECRET_ARN);
  if (identity && !process.env.PELP_IDENTITY_SECRET) {
    try {
      process.env.PELP_IDENTITY_SECRET = (JSON.parse(identity) as { secret?: string }).secret ?? identity;
    } catch {
      process.env.PELP_IDENTITY_SECRET = identity;
    }
  }
  const channel = await read(process.env.CHANNEL_SECRET_ARN);
  if (channel) {
    const json = JSON.parse(channel) as Record<string, string | undefined>;
    for (const [envName, key] of Object.entries(map)) {
      const value = json[key];
      if (!process.env[envName] && value && value !== 'PLACEHOLDER') process.env[envName] = value;
    }
  }
}

/** `consent_personalize:<textVersion>` → acción + versión del texto efectivamente mostrado. */
function parseConsentButton(id: string | undefined): { action: 'consent_personalize' | 'consent_neutral' | 'confirm_age_personalize'; textVersion?: string } | undefined {
  if (!id) return undefined;
  const [base, version] = id.split(':');
  if (base !== 'consent_personalize' && base !== 'consent_neutral' && base !== 'confirm_age_personalize') return undefined;
  return { action: base, ...(version ? { textVersion: version } : {}) };
}


function rawBody(req: APIGatewayProxyEvent): Buffer | undefined {
  if (!req.body) return undefined;
  return req.isBase64Encoded ? Buffer.from(req.body, 'base64') : Buffer.from(req.body, 'utf8');
}

function identityKey(channelUserId: string): { PK: { S: string }; SK: { S: string } } {
  return { PK: { S: `TENANT#${TENANT_ID}#CHANNEL#whatsapp#IDENT#${channelUserId}` }, SK: { S: 'DELIVERY' } };
}

/** Tabla privada de resolución de entrega. expiresAt debe configurarse como atributo TTL. */
export class WhatsAppIdentityStore {
  constructor(
    private readonly tableName: string,
    private readonly client: DynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
    private readonly ttlSeconds: number = DEFAULT_IDENTITY_TTL_SECONDS,
  ) {
    if (!tableName.trim()) throw new Error('WhatsApp identity table no configurada');
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error('WhatsApp identity TTL inválido');
  }

  async put(channelUserId: string, phoneNumber: string, now = new Date()): Promise<void> {
    const expiresAt = Math.floor(now.getTime() / 1000) + this.ttlSeconds;
    await this.client.send(new PutItemCommand({
      TableName: this.tableName,
      Item: {
        ...identityKey(channelUserId),
        channel: { S: 'whatsapp' },
        channelUserId: { S: channelUserId },
        phoneNumber: { S: phoneNumber },
        expiresAt: { N: String(expiresAt) },
      },
    }));
  }

  async resolve(channelUserId: string, now = new Date()): Promise<string | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: identityKey(channelUserId), ConsistentRead: true }));
    const phoneNumber = result.Item?.phoneNumber?.S;
    const expiresAt = Number(result.Item?.expiresAt?.N ?? 0);
    if (!phoneNumber || !expiresAt || expiresAt <= Math.floor(now.getTime() / 1000)) return undefined;
    return phoneNumber;
  }
}

export class WhatsAppAdapter implements ChannelAdapter<APIGatewayProxyEvent> {
  readonly channel = 'whatsapp';

  constructor(
    private readonly secrets: { appSecret?: string; identitySecret?: string; accessToken?: string; phoneNumberId?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  verify(req: APIGatewayProxyEvent): boolean {
    const header = req.headers['x-hub-signature-256'] ?? req.headers['X-Hub-Signature-256'];
    const raw = rawBody(req);
    if (!header || !raw || !this.secrets.appSecret) return false;
    const expected = `sha256=${createHmac('sha256', this.secrets.appSecret).update(raw).digest('hex')}`;
    return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
  }

  parse(req: APIGatewayProxyEvent): InboundMessage[] {
    return this.parseWithIdentities(req).map(({ inbound }) => inbound);
  }

  parseWithIdentities(req: APIGatewayProxyEvent): ParsedWhatsAppMessage[] {
    const raw = rawBody(req);
    if (!raw) return [];
    if (!this.secrets.identitySecret) throw new Error('WhatsApp identity secret no configurado');
    const payload = JSON.parse(raw.toString('utf8')) as WhatsAppWebhook;
    const out: ParsedWhatsAppMessage[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          const text = (message.text?.body ?? message.interactive?.button_reply?.title ?? '').trim();
          const action = actionForMessage(message, text);
          if (!message.from || (!text && !action)) continue;
          const channelUserId = hashChannelIdentity(this.secrets.identitySecret, this.channel, message.from);
          out.push({
            phoneNumber: message.from,
            inbound: {
              tenantId: TENANT_ID,
              channel: this.channel,
              channelUserId,
              text: action ? '' : text,
              receivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
              meta: {
                messageId: message.id ?? '',
                buttonId: message.interactive?.button_reply?.id ?? '',
                ...(action ? { action } : {}),
                ...(parseConsentButton(message.interactive?.button_reply?.id)?.textVersion ? { textVersion: parseConsentButton(message.interactive?.button_reply?.id)?.textVersion ?? '' } : {}),
              },
            },
          });
        }
      }
    }
    return out;
  }

  render(answer: Answer, _ctx: ChannelContext): OutboundPayload[] {
    const ageGate = answer.blocks.find((block) => block.type === 'notice' && block.code === 'age_confirmation_required');
    if (ageGate && ageGate.type === 'notice') {
      const version = answer.consentTextVersion ?? CURRENT_CONSENT_TEXT_VERSION;
      return [{
        kind: 'buttons',
        text: ageGate.text.slice(0, 1024),
        buttons: [
          { id: `confirm_age_personalize:${version}`, title: `Tengo ${answer.consentMinAge ?? 18} años o más` },
          { id: `consent_neutral:${version}`, title: CONSENT_BUTTONS.neutral },
        ],
      }];
    }
    const consent = answer.blocks.find((block) => block.type === 'notice' && block.code === 'consent_required');
    if (consent) {
      const termsUrl = process.env.TERMS_URL ?? 'https://www.elpais.com.uy/';
      const suffix = `\n\nTérminos completos: ${termsUrl}`;
      return [{
        kind: 'buttons',
        text: `${CURRENT_CONSENT_TEXT.slice(0, 1024 - suffix.length)}${suffix}`,
        buttons: [
          { id: `consent_personalize:${answer.consentTextVersion ?? CURRENT_CONSENT_TEXT_VERSION}`, title: CONSENT_BUTTONS.personalize },
          { id: `consent_neutral:${answer.consentTextVersion ?? CURRENT_CONSENT_TEXT_VERSION}`, title: CONSENT_BUTTONS.neutral },
        ],
      }];
    }
    const texts = answerToPlainText(answer, { maxChars: MAX_WHATSAPP_CHARS, personalizedLabel: 'Adaptada a tus intereses. Escribí "neutral" para ver la versión neutral.' });
    const payloads: OutboundPayload[] = texts.map((text) => ({ kind: 'text', text }));
    const suggestions = answer.blocks.find((block) => block.type === 'suggestions');
    if (suggestions?.type === 'suggestions' && suggestions.items.length) {
      payloads.push({ kind: 'buttons', text: 'Podés seguir con:', buttons: suggestions.items.slice(0, 3).map((item, index) => ({ id: `s${index}`, title: item.slice(0, 20) })) });
    }
    return payloads;
  }

  async deliver(payloads: OutboundPayload[], ctx: ChannelContext): Promise<void> {
    if (!this.secrets.accessToken || !this.secrets.phoneNumberId) throw new Error('WhatsApp sin token o phoneNumberId configurados');
    for (const payload of payloads) {
      const body = payload.kind === 'buttons'
        ? {
            messaging_product: 'whatsapp', to: ctx.channelUserId, type: 'interactive',
            interactive: {
              type: 'button', body: { text: payload.text.slice(0, 1024) },
              action: { buttons: payload.buttons.slice(0, 3).map((button) => ({ type: 'reply', reply: { id: button.id, title: button.title.slice(0, 20) } })) },
            },
          }
        : { messaging_product: 'whatsapp', to: ctx.channelUserId, type: 'text', text: { body: payload.kind === 'text' ? payload.text : JSON.stringify(payload) } };
      const response = await this.fetchImpl(`https://graph.facebook.com/v20.0/${this.secrets.phoneNumberId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.secrets.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`WhatsApp API ${response.status}`);
    }
  }
}

let sqs: SQSClient | undefined;
let dynamo: DynamoDBClient | undefined;

function requiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function identityTableName(): string | undefined {
  return requiredEnv('CHANNEL_IDENTITIES_TABLE_NAME') ?? requiredEnv('TABLE_NAME');
}

function identityTtlSeconds(): number {
  const configured = Number(process.env.CHANNEL_IDENTITY_TTL_SECONDS ?? DEFAULT_IDENTITY_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDENTITY_TTL_SECONDS;
}

export function inboundQueueBody(inbound: InboundMessage): string {
  return JSON.stringify({ inbound, ctx: { meta: inbound.meta } });
}

/** Webhook: GET de verificación de Meta y POST de mensajes → cola pelp-inbound. */
export async function webhook(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  await hydrateEnvFromSecrets({ WHATSAPP_APP_SECRET: 'appSecret', WHATSAPP_VERIFY_TOKEN: 'verifyToken', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_ID: 'phoneNumberId' });
  if (event.httpMethod === 'GET') {
    const verifyToken = requiredEnv('WHATSAPP_VERIFY_TOKEN');
    if (!verifyToken) return { statusCode: 500, body: 'webhook not configured' };
    const params = event.queryStringParameters ?? {};
    if (params['hub.mode'] === 'subscribe' && params['hub.verify_token'] === verifyToken && params['hub.challenge']) return { statusCode: 200, body: params['hub.challenge'] };
    return { statusCode: 403, body: 'forbidden' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  const appSecret = requiredEnv('WHATSAPP_APP_SECRET');
  const identitySecret = requiredEnv('PELP_IDENTITY_SECRET');
  const queueUrl = requiredEnv('INBOUND_QUEUE_URL');
  const tableName = identityTableName();
  if (!appSecret || !identitySecret || !queueUrl || !tableName) return { statusCode: 500, body: 'webhook not configured' };

  const adapter = new WhatsAppAdapter({ appSecret, identitySecret });
  if (!adapter.verify(event)) return { statusCode: 401, body: 'invalid signature' };
  let parsed: ParsedWhatsAppMessage[];
  try {
    parsed = adapter.parseWithIdentities(event);
  } catch {
    return { statusCode: 400, body: 'bad request' };
  }

  sqs ??= new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  dynamo ??= new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const identities = new WhatsAppIdentityStore(tableName, dynamo, identityTtlSeconds());
  for (const { inbound, phoneNumber } of parsed) {
    await identities.put(inbound.channelUserId, phoneNumber);
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: inboundQueueBody(inbound) }));
  }
  return { statusCode: 200, body: 'ok' };
}

/** Entrega AnswerReady: resuelve el hash en la tabla privada; nunca acepta meta.to. */
export async function deliverHandler(event: EventBridgeEvent<'AnswerReady', { answer: Answer; channelUserId: string; conversationId: string; meta?: Record<string, string> }>): Promise<void> {
  await hydrateEnvFromSecrets({ WHATSAPP_APP_SECRET: 'appSecret', WHATSAPP_VERIFY_TOKEN: 'verifyToken', WHATSAPP_TOKEN: 'token', WHATSAPP_PHONE_ID: 'phoneNumberId' });
  const accessToken = requiredEnv('WHATSAPP_TOKEN');
  const phoneNumberId = requiredEnv('WHATSAPP_PHONE_ID');
  const tableName = identityTableName();
  if (!accessToken || !phoneNumberId || !tableName) throw new Error('WhatsApp delivery no configurado');
  dynamo ??= new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const phoneNumber = await new WhatsAppIdentityStore(tableName, dynamo, identityTtlSeconds()).resolve(event.detail.channelUserId);
  if (!phoneNumber) throw new Error('AnswerReady sin identidad vigente para whatsapp');
  const adapter = new WhatsAppAdapter({ accessToken, phoneNumberId });
  const ctx: ChannelContext = { channel: 'whatsapp', channelUserId: phoneNumber, conversationId: event.detail.conversationId, ...(event.detail.meta ? { meta: event.detail.meta } : {}) };
  await adapter.deliver(adapter.render(event.detail.answer, ctx), ctx);
}

export const handler = webhook;
