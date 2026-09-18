import type { EventBridgeEvent, SNSEvent } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendWhatsAppMessageCommand, SocialMessagingClient } from '@aws-sdk/client-socialmessaging';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Answer, InboundMessage } from '@pelp/domain';
import { CONSENT_BUTTONS, CURRENT_CONSENT_TEXT, CURRENT_CONSENT_TEXT_VERSION, TENANT_ID } from '@pelp/domain';
import { hashChannelIdentity } from '@pelp/domain/node';
import { answerToPlainText, type ChannelAdapter, type ChannelContext, type OutboundPayload } from '@pelp/channel-sdk';

/**
 * Adaptador WhatsApp sobre AWS End User Messaging Social (sección 10.3).
 *
 * Hasta el 18/9/2026 hablaba directo con la Cloud API de Meta: un webhook público con firma
 * HMAC y un token de acceso de larga vida en Secrets Manager. Ahora AWS recibe el webhook de
 * Meta y lo publica en un tema de SNS al que está suscrita esta Lambda, y el envío es una llamada
 * al SDK con IAM. Se van todos los secretos de Meta (app secret, verify token, token, id del
 * número) y el webhook público con su verificación de firma; queda solo el secreto de identidad,
 * que es nuestro. Lo que no cambia: el número en claro vive exclusivamente en este proceso y en
 * la tabla privada del canal; SQS y AnswerReady usan siempre channelUserId hasheado; las acciones
 * de canal viajan como meta.action y text vacío para que consentimiento/borrado no se interpreten
 * como preguntas.
 *
 * Meta no desaparece: hace falta una WhatsApp Business Account vinculada desde la consola de AWS
 * (Embedded Signup) y un número. Con el negocio sin verificar se puede operar con los límites que
 * Meta pone a esa etapa; para este asistente, que solo responde, alcanza.
 */

/** El cuerpo del webhook de Meta, tal como lo reenvía AWS. */
interface WhatsAppWebhook {
  entry?: WhatsAppEntry[];
}

interface WhatsAppEntry {
  changes?: { value?: { messages?: WhatsAppMessage[]; metadata?: { phone_number_id?: string } } }[];
}

/**
 * Lo que End User Messaging publica en SNS: la entrada del webhook de Meta como texto, más el
 * contexto de la cuenta. Se acepta también el cuerpo crudo de Meta, por si el evento llega sin
 * envolver (pruebas, o un cambio de formato del servicio).
 */
interface SocialMessagingNotification {
  webhookEntry?: string;
  context?: { MetaWaId?: string; MetaPhoneNumberIds?: string[] };
  message_timestamp?: string;
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
/** El secreto de identidad por ARN (Secrets Manager), nunca en variables de entorno en claro (sección 15). */
async function hydrateIdentitySecret(): Promise<void> {
  if (hydrated || process.env.PELP_IDENTITY_SECRET) return;
  hydrated = true;
  const arn = process.env.IDENTITY_SECRET_ARN;
  if (!arn) return;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const output = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const identity = output.SecretString;
  if (!identity) return;
  try {
    process.env.PELP_IDENTITY_SECRET = (JSON.parse(identity) as { secret?: string }).secret ?? identity;
  } catch {
    process.env.PELP_IDENTITY_SECRET = identity;
  }
}

/** `consent_personalize:<textVersion>` → acción + versión del texto efectivamente mostrado. */
function parseConsentButton(id: string | undefined): { action: 'consent_personalize' | 'consent_neutral' | 'confirm_age_personalize'; textVersion?: string } | undefined {
  if (!id) return undefined;
  const [base, version] = id.split(':');
  if (base !== 'consent_personalize' && base !== 'consent_neutral' && base !== 'confirm_age_personalize') return undefined;
  return { action: base, ...(version ? { textVersion: version } : {}) };
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

/** Cliente de envío, inyectable en las pruebas. */
export interface WhatsAppSender {
  send(command: SendWhatsAppMessageCommand): Promise<{ messageId?: string | undefined }>;
}

/** Versión de la Graph API de Meta con la que se arma el cuerpo. AWS la reenvía tal cual. */
export const META_API_VERSION = 'v20.0';

export class WhatsAppAdapter implements ChannelAdapter<SNSEvent> {
  readonly channel = 'whatsapp';

  constructor(
    private readonly options: { identitySecret?: string; originationPhoneNumberId?: string },
    private readonly sender: WhatsAppSender = new SocialMessagingClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
  ) {}

  /**
   * La autenticidad la da la ruta: el evento llega por un tema de SNS al que solo publica End
   * User Messaging (política del tema) y solo consume esta Lambda. No hay firma de Meta que
   * comprobar porque el webhook ya no es nuestro.
   */
  verify(req: SNSEvent): boolean {
    return Array.isArray(req.Records) && req.Records.every((record) => record.EventSource === 'aws:sns');
  }

  parse(req: SNSEvent): InboundMessage[] {
    return this.parseWithIdentities(req).map(({ inbound }) => inbound);
  }

  parseWithIdentities(req: SNSEvent): ParsedWhatsAppMessage[] {
    if (!this.options.identitySecret) throw new Error('WhatsApp identity secret no configurado');
    const out: ParsedWhatsAppMessage[] = [];
    for (const record of req.Records ?? []) {
      for (const entry of entriesFrom(record.Sns?.Message)) {
        for (const change of entry.changes ?? []) {
          for (const message of change.value?.messages ?? []) {
            const text = (message.text?.body ?? message.interactive?.button_reply?.title ?? '').trim();
            const action = actionForMessage(message, text);
            if (!message.from || (!text && !action)) continue;
            const channelUserId = hashChannelIdentity(this.options.identitySecret, this.channel, message.from);
            const textVersion = parseConsentButton(message.interactive?.button_reply?.id)?.textVersion;
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
                  ...(textVersion ? { textVersion } : {}),
                },
              },
            });
          }
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
    const originationPhoneNumberId = this.options.originationPhoneNumberId;
    if (!originationPhoneNumberId) throw new Error('WhatsApp sin número de origen configurado (WHATSAPP_ORIGINATION_PHONE_NUMBER_ID)');
    for (const payload of payloads) {
      // El mismo cuerpo que pide la Cloud API de Meta: AWS lo reenvía sin tocarlo.
      const body = payload.kind === 'buttons'
        ? {
            messaging_product: 'whatsapp', to: ctx.channelUserId, type: 'interactive',
            interactive: {
              type: 'button', body: { text: payload.text.slice(0, 1024) },
              action: { buttons: payload.buttons.slice(0, 3).map((button) => ({ type: 'reply', reply: { id: button.id, title: button.title.slice(0, 20) } })) },
            },
          }
        : { messaging_product: 'whatsapp', to: ctx.channelUserId, type: 'text', text: { body: payload.kind === 'text' ? payload.text : JSON.stringify(payload) } };
      await this.sender.send(new SendWhatsAppMessageCommand({
        originationPhoneNumberId,
        metaApiVersion: META_API_VERSION,
        message: new TextEncoder().encode(JSON.stringify(body)),
      }));
    }
  }
}

/** Las entradas del webhook de Meta que trae una notificación de SNS, envuelta o cruda. */
export function entriesFrom(message: string | undefined): WhatsAppEntry[] {
  if (!message) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const wrapped = parsed as SocialMessagingNotification & WhatsAppWebhook;
  if (typeof wrapped.webhookEntry === 'string') {
    try {
      const entry = JSON.parse(wrapped.webhookEntry) as WhatsAppEntry | WhatsAppEntry[];
      return Array.isArray(entry) ? entry : [entry];
    } catch {
      return [];
    }
  }
  return Array.isArray(wrapped.entry) ? wrapped.entry : [];
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
/**
 * Entrada: la Lambda está suscrita al tema de SNS donde End User Messaging publica los eventos
 * de la cuenta de WhatsApp. Cada mensaje del lector se hashea, se guarda su identidad para poder
 * responderle y se encola para el motor.
 */
export async function inboundHandler(event: SNSEvent): Promise<void> {
  await hydrateIdentitySecret();
  const identitySecret = requiredEnv('PELP_IDENTITY_SECRET');
  const queueUrl = requiredEnv('INBOUND_QUEUE_URL');
  const tableName = identityTableName();
  if (!identitySecret || !queueUrl || !tableName) throw new Error('WhatsApp inbound no configurado');

  const adapter = new WhatsAppAdapter({ identitySecret });
  if (!adapter.verify(event)) throw new Error('evento que no viene de SNS');
  const parsed = adapter.parseWithIdentities(event);

  sqs ??= new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  dynamo ??= new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const identities = new WhatsAppIdentityStore(tableName, dynamo, identityTtlSeconds());
  for (const { inbound, phoneNumber } of parsed) {
    await identities.put(inbound.channelUserId, phoneNumber);
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: inboundQueueBody(inbound) }));
  }
}

/** Entrega AnswerReady: resuelve el hash en la tabla privada; nunca acepta meta.to. */
export async function deliverHandler(event: EventBridgeEvent<'AnswerReady', { answer: Answer; channelUserId: string; conversationId: string; meta?: Record<string, string> }>): Promise<void> {
  const originationPhoneNumberId = requiredEnv('WHATSAPP_ORIGINATION_PHONE_NUMBER_ID');
  const tableName = identityTableName();
  if (!originationPhoneNumberId || !tableName) throw new Error('WhatsApp delivery no configurado');
  dynamo ??= new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const phoneNumber = await new WhatsAppIdentityStore(tableName, dynamo, identityTtlSeconds()).resolve(event.detail.channelUserId);
  if (!phoneNumber) throw new Error('AnswerReady sin identidad vigente para whatsapp');
  const adapter = new WhatsAppAdapter({ originationPhoneNumberId });
  const ctx: ChannelContext = { channel: 'whatsapp', channelUserId: phoneNumber, conversationId: event.detail.conversationId, ...(event.detail.meta ? { meta: event.detail.meta } : {}) };
  await adapter.deliver(adapter.render(event.detail.answer, ctx), ctx);
}

export const handler = inboundHandler;
