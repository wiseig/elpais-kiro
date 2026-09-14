import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSEvent } from 'aws-lambda';
import type { Answer, InboundMessage, NoticeCode, ReaderRecord } from '@pelp/domain';
import { CONSENT_TEXT_VERSIONS, TENANT_ID, isChannelAction, ulid } from '@pelp/domain';
import { ConfigProvider } from './core/config';
import { DynamoDb } from './core/db';
import { askQuestion, type EngineDeps } from './core/engine';
import { EventBridgePublisher, awsGuardrails, awsModels, awsRetriever } from './core/gateways';
import { logger } from './core/log';
import { deleteReader, needsConsent, readerMode, recordDecision, resolveReader } from './core/readers';
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

function queuedMessage(body: string): QueuedMessage {
  const parsed = JSON.parse(body) as Partial<QueuedMessage>;
  const inbound = parsed.inbound;
  if (
    !inbound ||
    inbound.tenantId !== TENANT_ID ||
    typeof inbound.channel !== 'string' ||
    !inbound.channel ||
    typeof inbound.channelUserId !== 'string' ||
    !inbound.channelUserId ||
    typeof inbound.text !== 'string' ||
    typeof inbound.receivedAt !== 'string'
  ) {
    throw new Error('Mensaje de canal inválido');
  }
  if (inbound.meta?.action !== undefined && !isChannelAction(inbound.meta.action)) throw new Error('Acción de canal inválida');
  return parsed as QueuedMessage;
}

function actionAnswer(
  inbound: InboundMessage,
  now: Date,
  text: string,
  options: { notice?: NoticeCode; consentTextVersion?: string; consentMinAge?: number } = {},
): Answer {
  const conversationId = inbound.conversationId ?? ulid(now.getTime());
  return {
    answerId: ulid(now.getTime()),
    conversationId,
    blocks: options.notice ? [{ type: 'notice', text, code: options.notice }] : [{ type: 'text', text }],
    hadCoverage: false,
    personalized: false,
    ...(options.consentTextVersion ? { consentTextVersion: options.consentTextVersion } : {}),
    ...(options.consentMinAge !== undefined ? { consentMinAge: options.consentMinAge } : {}),
    latencyMs: 0,
  };
}

async function existingReader(engine: EngineDeps, inbound: InboundMessage): Promise<ReaderRecord | undefined> {
  const readerId = await engine.store.findReaderIdByIdentity(inbound.channel, inbound.channelUserId);
  return readerId ? engine.store.getReader(readerId) : undefined;
}

/**
 * Procesa mutaciones y ayuda antes del flujo de preguntas. Así consentimiento y borrado
 * siguen disponibles con el kill switch activo y nunca se interpretan como texto vacío.
 */
async function handleChannelAction(engine: EngineDeps, inbound: InboundMessage): Promise<Answer | undefined> {
  const actionValue = inbound.meta?.action;
  if (actionValue === undefined) return undefined;
  if (!isChannelAction(actionValue)) throw new Error('Acción de canal inválida');

  const now = engine.now();
  const config = await engine.config.get();
  const consentText = CONSENT_TEXT_VERSIONS[config.consent.textVersion];
  if (!consentText) throw new Error(`Versión de consentimiento no desplegada: ${config.consent.textVersion}`);
  const consentOptions = {
    consentTextVersion: config.consent.textVersion,
    consentMinAge: config.consent.minAgePersonalization,
  };
  const consentGate = () => actionAnswer(inbound, now, consentText, {
    notice: 'consent_required',
    ...consentOptions,
  });
  const ageGate = () => actionAnswer(
    inbound,
    now,
    `Para activar la personalización, confirmá explícitamente que tenés ${config.consent.minAgePersonalization} años o más.`,
    { notice: 'age_confirmation_required', ...consentOptions },
  );

  if (actionValue === 'help') {
    return actionAnswer(
      inbound,
      now,
      'Escribí una pregunta sobre la actualidad publicada por El País. También podés escribir “personalizar”, “neutral” o “borrar mis datos”.',
    );
  }

  if (actionValue === 'delete_data') {
    const reader = await existingReader(engine, inbound);
    if (reader) {
      const identities = reader.identities?.length
        ? reader.identities
        : [{ channel: inbound.channel, hash: inbound.channelUserId }];
      const result = await deleteReader(engine.store, reader, identities, now);
      engine.log.info('reader.deleted', { readerId: reader.profile.readerId, channel: inbound.channel, ...result });
    }
    return actionAnswer(inbound, now, 'Tus datos fueron borrados. Podés volver a usar el servicio cuando quieras.');
  }

  if (actionValue === 'consent_personalize' || actionValue === 'consent_neutral' || actionValue === 'confirm_age_personalize') {
    if (inbound.meta?.textVersion !== config.consent.textVersion) return consentGate();
    if (actionValue === 'consent_personalize') return ageGate();

    const reader = await resolveReader(engine.store, inbound.channel, inbound.channelUserId, now, config);
    const decision = actionValue === 'consent_neutral' ? 'neutral' : 'personalize';
    if (readerMode(reader) !== (decision === 'neutral' ? 'neutral' : 'personalized') || needsConsent(reader, config)) {
      await recordDecision(
        engine.store,
        reader,
        decision,
        config.consent.textVersion,
        { channel: inbound.channel, ...(inbound.locale ? { locale: inbound.locale } : {}), ageConfirmed: actionValue === 'confirm_age_personalize' },
        config,
        now,
      );
    }
    return actionAnswer(
      inbound,
      now,
      decision === 'neutral'
        ? 'Listo. Vas a usar el servicio sin personalización.'
        : 'Listo. Activaste la personalización; podés volver al modo neutral cuando quieras.',
    );
  }

  const reader = await existingReader(engine, inbound);
  if (!reader || needsConsent(reader, config)) return consentGate();
  if (actionValue === 'personalize') return ageGate();

  if (readerMode(reader) !== 'neutral') {
    await recordDecision(engine.store, reader, 'neutral', config.consent.textVersion, { channel: inbound.channel }, config, now);
  }
  return actionAnswer(inbound, now, 'Listo. Cambiaste al modo sin personalización.');
}

/** Canales asíncronos (10.1): SQS pelp-inbound → motor → evento AnswerReady para el adaptador. */
/**
 * Un canal apagado en el registro no contesta. Se memoriza un minuto: la cola puede traer
 * muchos mensajes seguidos y no tiene sentido leer el registro en cada uno. `web` nunca se apaga
 * desde acá: para eso está el kill switch del servicio.
 */
let channelCache: { at: number; enabled: Map<string, boolean> } | undefined;

export async function channelEnabled(engine: EngineDeps, channel: string, ttlMs = 60_000): Promise<boolean> {
  if (!channelCache || Date.now() - channelCache.at > ttlMs) {
    const record = await engine.store.getChannels().catch(() => undefined);
    const enabled = new Map<string, boolean>();
    for (const item of record?.items ?? []) enabled.set(item.id, item.enabled !== false);
    channelCache = { at: Date.now(), enabled };
  }
  // Sin registro, todo sigue como antes: no queremos que un canal se caiga por un dato faltante.
  return channelCache.enabled.get(channel) ?? true;
}

/** Solo para los tests. */
export function resetChannelCache(): void {
  channelCache = undefined;
}

export async function handleQueue(engine: EngineDeps, event: SQSEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let claimed: { channel: string; requestId: string } | undefined;
    try {
      const message = queuedMessage(record.body);
      // El interruptor de la pantalla de Canales era decorativo: nadie lo miraba, así que apagar
      // un canal exigía redesplegar. Para una línea pública eso no sirve.
      if (!(await channelEnabled(engine, message.inbound.channel))) {
        engine.log.warn('channel.disabled', { channel: message.inbound.channel });
        continue;
      }
      const requestId = message.inbound.meta?.messageId || message.inbound.meta?.interactionId;
      let answer: Answer | undefined;

      if (requestId) {
        const receipt = await engine.store.getInboundReceipt(message.inbound.channel, requestId);
        if (receipt?.state === 'published') continue;
        if (receipt?.state === 'processed' && receipt.answer) {
          answer = receipt.answer;
        } else {
          if (receipt || !(await engine.store.claimInbound(message.inbound.channel, requestId, engine.now()))) {
            throw new Error('Mensaje de canal ya está siendo procesado');
          }
          claimed = { channel: message.inbound.channel, requestId };
        }
      }

      if (!answer) {
        const action = await handleChannelAction(engine, message.inbound);
        answer = action ?? (await askQuestion(engine, message.inbound)).answer;
        if (requestId) {
          await engine.store.saveInboundResult(message.inbound.channel, requestId, answer);
          claimed = undefined;
        }
      }

      const { action: _untrustedAction, ...deliveryMeta } = message.ctx?.meta ?? {};
      const validatedAction = message.inbound.meta?.action;
      const meta = { ...deliveryMeta, ...(validatedAction ? { action: validatedAction } : {}) };
      await engine.events.publish('AnswerReady', message.inbound.channel, {
        answer,
        channelUserId: message.inbound.channelUserId,
        conversationId: answer.conversationId,
        ...(Object.keys(meta).length ? { meta } : {}),
      });
      if (requestId) await engine.store.markInboundPublished(message.inbound.channel, requestId);
      claimed = undefined;
    } catch (error) {
      if (claimed) await engine.store.releaseInbound(claimed.channel, claimed.requestId).catch(() => undefined);
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
