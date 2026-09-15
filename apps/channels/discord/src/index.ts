import { verify as verifySignature } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, EventBridgeEvent } from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Answer, InboundMessage } from '@pelp/domain';
import { CONSENT_BUTTONS, CURRENT_CONSENT_TEXT, CURRENT_CONSENT_TEXT_VERSION, TENANT_ID, sectionLabel } from '@pelp/domain';
import { hashChannelIdentity } from '@pelp/domain/node';
import { answerToMarkdown, type ChannelAdapter, type ChannelContext, type OutboundPayload } from '@pelp/channel-sdk';

/**
 * Adaptador Discord (sección 10.4). Los componentes de consentimiento (type 3) y los
 * comandos de canal se normalizan con meta.action y text vacío: ese es el contrato
 * asíncrono con el consumidor y evita tratarlos como preguntas si el motor no tiene ruta propia.
 */

interface DiscordInteraction {
  type: number;
  id: string;
  token: string;
  application_id?: string;
  data?: { name?: string; options?: { name: string; value: string }[]; custom_id?: string };
  member?: { user?: { id?: string } };
  user?: { id?: string };
  guild_id?: string;
  channel_id?: string;
}

export type DiscordAction = 'consent_personalize' | 'consent_neutral' | 'neutral' | 'personalize' | 'delete_data' | 'help' | 'confirm_age_personalize';

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

function normalizeCommand(text: string): DiscordAction | undefined {
  const command = text.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const commands: Record<string, DiscordAction> = {
    neutral: 'neutral',
    personalizar: 'personalize',
    'borrar mis datos': 'delete_data',
    ayuda: 'help',
  };
  return commands[command];
}

function componentAction(customId: string | undefined): DiscordAction | undefined {
  return parseConsentButton(customId)?.action;
}

export class DiscordAdapter implements ChannelAdapter<APIGatewayProxyEvent> {
  readonly channel = 'discord';

  constructor(
    private readonly secrets: { publicKey?: string; identitySecret?: string; applicationId?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  verify(req: APIGatewayProxyEvent): boolean {
    const signature = req.headers['x-signature-ed25519'] ?? req.headers['X-Signature-Ed25519'];
    const timestamp = req.headers['x-signature-timestamp'] ?? req.headers['X-Signature-Timestamp'];
    if (!signature || !timestamp || !req.body || !this.secrets.publicKey) return false;
    const raw = req.isBase64Encoded ? Buffer.from(req.body, 'base64').toString('utf8') : req.body;
    try {
      const publicKey = Buffer.from(this.secrets.publicKey, 'hex');
      const signatureBytes = Buffer.from(signature, 'hex');
      if (publicKey.length !== 32 || signatureBytes.length !== 64) return false;
      const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
      return verifySignature(null, Buffer.from(timestamp + raw), { key: der, format: 'der', type: 'spki' }, signatureBytes);
    } catch {
      return false;
    }
  }

  parse(req: APIGatewayProxyEvent): InboundMessage[] {
    const interaction = readInteraction(req);
    if (!interaction || (interaction.type !== 2 && interaction.type !== 3) || !this.secrets.identitySecret) return [];
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!userId) return [];

    let text = '';
    let action: DiscordAction | undefined;
    let consentTextVersion: string | undefined;
    if (interaction.type === 2) {
      if (interaction.data?.name !== 'elpais') return [];
      const question = interaction.data.options?.find((option) => option.name === 'pregunta')?.value?.trim() ?? '';
      if (!question) return [];
      action = normalizeCommand(question);
      text = action ? '' : question;
    } else {
      action = componentAction(interaction.data?.custom_id);
      consentTextVersion = parseConsentButton(interaction.data?.custom_id)?.textVersion;
      if (!action) return [];
    }

    return [{
      tenantId: TENANT_ID,
      channel: this.channel,
      channelUserId: hashChannelIdentity(this.secrets.identitySecret, this.channel, userId),
      text,
      receivedAt: new Date().toISOString(),
      meta: {
        interactionToken: interaction.token,
        guildId: interaction.guild_id ?? '',
        applicationId: interaction.application_id ?? this.secrets.applicationId ?? '',
        ...(action ? { action } : {}),
        ...(consentTextVersion ? { textVersion: consentTextVersion } : {}),
      },
    }];
  }

  render(answer: Answer, _ctx: ChannelContext): OutboundPayload[] {
    const ageGate = answer.blocks.find((block) => block.type === 'notice' && block.code === 'age_confirmation_required');
    if (ageGate && ageGate.type === 'notice') {
      const version = answer.consentTextVersion ?? CURRENT_CONSENT_TEXT_VERSION;
      return [{ kind: 'buttons', text: ageGate.text.slice(0, 1900), buttons: [
        { id: `confirm_age_personalize:${version}`, title: `Tengo ${answer.consentMinAge ?? 18} años o más` },
        { id: `consent_neutral:${version}`, title: CONSENT_BUTTONS.neutral },
      ] }];
    }
    const consent = answer.blocks.find((block) => block.type === 'notice' && block.code === 'consent_required');
    if (consent) {
      const version = answer.consentTextVersion ?? CURRENT_CONSENT_TEXT_VERSION;
      return [{ kind: 'buttons', text: CURRENT_CONSENT_TEXT.slice(0, 1900), buttons: [
        { id: `consent_personalize:${version}`, title: CONSENT_BUTTONS.personalize },
        { id: `consent_neutral:${version}`, title: CONSENT_BUTTONS.neutral },
      ] }];
    }
    const sources = answer.blocks.find((block) => block.type === 'sources');
    const text = answer.blocks.find((block) => block.type === 'text');
    return [{
      kind: 'embed',
      title: answer.hadCoverage ? 'Preguntale a El País' : 'Sin cobertura',
      description: (text?.type === 'text' ? text.text : answerToMarkdown(answer)).slice(0, 4000),
      fields: sources?.type === 'sources' ? sources.items.slice(0, 5).map((source) => ({ name: source.title.slice(0, 250), value: `${sectionLabel(source.section)} · ${source.date} · ${source.url}`.slice(0, 1024) })) : [],
    }];
  }

  async deliver(payloads: OutboundPayload[], ctx: ChannelContext): Promise<void> {
    const token = ctx.meta?.interactionToken;
    const applicationId = ctx.meta?.applicationId ?? this.secrets.applicationId;
    if (!token || !applicationId) throw new Error('Discord sin interactionToken/applicationId');
    for (const payload of payloads) {
      const body = payload.kind === 'embed'
        ? { embeds: [{ title: payload.title, description: payload.description, fields: payload.fields, color: 0x004f88 }] }
        : payload.kind === 'buttons'
          ? { content: payload.text, flags: 64, components: [{ type: 1, components: payload.buttons.map((button) => ({ type: 2, style: 1, label: button.title.slice(0, 80), custom_id: button.id })) }] }
          : { content: payload.kind === 'text' ? payload.text.slice(0, 2000) : JSON.stringify(payload).slice(0, 2000) };
      const response = await this.fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Discord API ${response.status}`);
    }
  }
}

function readInteraction(req: APIGatewayProxyEvent): DiscordInteraction | undefined {
  if (!req.body) return undefined;
  const raw = req.isBase64Encoded ? Buffer.from(req.body, 'base64').toString('utf8') : req.body;
  try {
    return JSON.parse(raw) as DiscordInteraction;
  } catch {
    return undefined;
  }
}

let sqs: SQSClient | undefined;

function requiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function inboundQueueBody(inbound: InboundMessage): string {
  return JSON.stringify({ inbound, ctx: { meta: inbound.meta } });
}

/** PING → PONG; slash command → defer efímero; componente → defer update del mensaje efímero. */
export async function interactions(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  await hydrateEnvFromSecrets({ DISCORD_PUBLIC_KEY: 'publicKey', DISCORD_APPLICATION_ID: 'applicationId' });
  const publicKey = requiredEnv('DISCORD_PUBLIC_KEY');
  const identitySecret = requiredEnv('PELP_IDENTITY_SECRET');
  if (!publicKey || !identitySecret) return { statusCode: 500, body: 'interactions not configured' };
  const adapter = new DiscordAdapter({ publicKey, identitySecret, applicationId: requiredEnv('DISCORD_APPLICATION_ID') });
  if (!adapter.verify(event)) return { statusCode: 401, body: 'invalid request signature' };
  const interaction = readInteraction(event);
  if (!interaction) return { statusCode: 400, body: 'bad request' };
  if (interaction.type === 1) return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 1 }) };
  if (interaction.type !== 2 && interaction.type !== 3) return { statusCode: 400, body: 'unsupported interaction' };

  const queueUrl = requiredEnv('INBOUND_QUEUE_URL');
  if (!queueUrl) return { statusCode: 500, body: 'queue not configured' };
  const inbound = adapter.parse(event);
  if (inbound.length === 0) return { statusCode: 400, body: 'unsupported interaction data' };
  sqs ??= new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  for (const message of inbound) await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: inboundQueueBody(message) }));
  const acknowledgement = interaction.type === 3 ? { type: 6 } : { type: 5, data: { flags: 64 } };
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(acknowledgement) };
}

export async function deliverHandler(event: EventBridgeEvent<'AnswerReady', { answer: Answer; channelUserId: string; conversationId: string; meta?: Record<string, string> }>): Promise<void> {
  await hydrateEnvFromSecrets({ DISCORD_PUBLIC_KEY: 'publicKey', DISCORD_APPLICATION_ID: 'applicationId' });
  const adapter = new DiscordAdapter({ applicationId: requiredEnv('DISCORD_APPLICATION_ID') });
  const ctx: ChannelContext = { channel: 'discord', channelUserId: event.detail.channelUserId, conversationId: event.detail.conversationId, ...(event.detail.meta ? { meta: event.detail.meta } : {}) };
  await adapter.deliver(adapter.render(event.detail.answer, ctx), ctx);
}

export const handler = interactions;
