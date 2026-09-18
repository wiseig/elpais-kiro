import type { SNSEvent } from 'aws-lambda';
import { GetItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { SendWhatsAppMessageCommand } from '@aws-sdk/client-socialmessaging';
import type { Answer } from '@pelp/domain';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDENTITY_TTL_SECONDS, META_API_VERSION, WhatsAppAdapter, WhatsAppIdentityStore, deliverHandler, entriesFrom, inboundQueueBody } from '../src/index.js';

/** Un evento de SNS con lo que publica End User Messaging: la entrada de Meta como texto. */
function snsEvent(message: string, source = 'aws:sns'): SNSEvent {
  return { Records: [{ EventSource: source, Sns: { Message: message } }] } as unknown as SNSEvent;
}

/** La notificación real: `webhookEntry` es la entrada del webhook de Meta serializada. */
function notification(message: object): string {
  return JSON.stringify({
    context: { MetaWaId: '1234567890', MetaPhoneNumberIds: ['phone-number-id-1'] },
    webhookEntry: JSON.stringify({ id: '1234567890', changes: [{ value: { messaging_product: 'whatsapp', messages: [message] } }] }),
    aws_account_id: '178042202224',
    message_timestamp: '2026-09-18T12:00:00Z',
  });
}

function fakeSender() {
  const calls: SendWhatsAppMessageCommand[] = [];
  return { calls, send: vi.fn(async (command: SendWhatsAppMessageCommand) => { calls.push(command); return { messageId: 'wamid.1' }; }) };
}

const answer = {
  answerId: 'a1', conversationId: 'c1', hadCoverage: true, personalized: false, latencyMs: 10,
  blocks: [{ type: 'notice', text: 'consentimiento', code: 'consent_required' }],
} as Answer;

describe('WhatsAppAdapter', () => {
  it('acepta solo eventos que vienen de SNS: la autenticidad la da la ruta, no una firma', () => {
    const adapter = new WhatsAppAdapter({ identitySecret: 'identity' });
    expect(adapter.verify(snsEvent(notification({ from: '5981', type: 'text', text: { body: 'hola' } })))).toBe(true);
    expect(adapter.verify(snsEvent('{}', 'aws:sqs'))).toBe(false);
    expect(adapter.verify({ Records: [] } as unknown as SNSEvent)).toBe(true);
  });

  it('lee la notificación de End User Messaging y también el cuerpo crudo de Meta', () => {
    const message = { from: '59899123456', id: 'm1', timestamp: '1700000000', type: 'text', text: { body: '¿Qué pasó?' } };
    expect(entriesFrom(notification(message))[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body).toBe('¿Qué pasó?');
    expect(entriesFrom(JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] }))[0]?.changes?.[0]?.value?.messages?.[0]?.from).toBe('59899123456');
    expect(entriesFrom('no es json')).toEqual([]);
    expect(entriesFrom(JSON.stringify({ webhookEntry: '{roto' }))).toEqual([]);
    expect(entriesFrom(undefined)).toEqual([]);
  });

  it('hashea el teléfono y el envelope de SQS no contiene el número claro', () => {
    const phone = '59899123456';
    const [inbound] = new WhatsAppAdapter({ identitySecret: 'identity' }).parse(snsEvent(notification({ from: phone, id: 'm1', timestamp: '1700000000', type: 'text', text: { body: '¿Qué pasó?' } })));
    expect(inbound?.text).toBe('¿Qué pasó?');
    expect(inbound?.receivedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(inbound?.channelUserId).not.toBe(phone);
    expect(inboundQueueBody(inbound!)).not.toContain(phone);
  });

  it('normaliza botones y comandos sensibles como meta.action con text vacío', () => {
    const adapter = new WhatsAppAdapter({ identitySecret: 'identity' });
    const [consent] = adapter.parse(snsEvent(notification({ from: '5981', type: 'interactive', interactive: { button_reply: { id: 'consent_neutral', title: 'Usar sin personalizar' } } })));
    expect(consent).toMatchObject({ text: '', meta: { buttonId: 'consent_neutral', action: 'consent_neutral' } });
    const [deletion] = adapter.parse(snsEvent(notification({ from: '5981', type: 'text', text: { body: 'Borrar mis datos' } })));
    expect(deletion).toMatchObject({ text: '', meta: { action: 'delete_data' } });
  });

  it('renderiza la puerta con link no truncado y limita botones/sugerencias', () => {
    process.env.TERMS_URL = 'https://example.test/terminos';
    const adapter = new WhatsAppAdapter({});
    const [rendered] = adapter.render(answer, { channel: 'whatsapp', channelUserId: 'h', conversationId: 'c1' });
    expect(rendered).toMatchObject({ kind: 'buttons', buttons: [expect.objectContaining({ id: expect.stringMatching(/^consent_personalize:/) }), expect.objectContaining({ id: expect.stringMatching(/^consent_neutral:/) })] });
    expect(rendered?.kind === 'buttons' && rendered.text.endsWith('https://example.test/terminos')).toBe(true);
    expect(rendered?.kind === 'buttons' && rendered.text.length).toBeLessThanOrEqual(1024);
    delete process.env.TERMS_URL;
  });

  it('aplica un límite duro de 1.600 caracteres aun sin cortes de oración', () => {
    const rendered = new WhatsAppAdapter({}).render({ ...answer, blocks: [{ type: 'text', text: 'x'.repeat(3201) }] } as Answer, { channel: 'whatsapp', channelUserId: 'h', conversationId: 'c1' });
    expect(rendered).toHaveLength(3);
    expect(rendered.every((payload) => payload.kind !== 'text' || payload.text.length <= 1600)).toBe(true);
  });

  it('entrega por el SDK con el cuerpo de la Cloud API, y falla cerrado sin número de origen', async () => {
    const sender = fakeSender();
    const adapter = new WhatsAppAdapter({ originationPhoneNumberId: 'phone-number-id-1' }, sender);
    await adapter.deliver([{ kind: 'text', text: 'respuesta' }], { channel: 'whatsapp', channelUserId: '59899123456', conversationId: 'c1' });
    const input = sender.calls[0]?.input;
    expect(input?.originationPhoneNumberId).toBe('phone-number-id-1');
    expect(input?.metaApiVersion).toBe(META_API_VERSION);
    expect(JSON.parse(new TextDecoder().decode(input?.message))).toMatchObject({ messaging_product: 'whatsapp', to: '59899123456', type: 'text', text: { body: 'respuesta' } });
    await expect(new WhatsAppAdapter({}, sender).deliver([{ kind: 'text' , text: 'x' }], { channel: 'whatsapp', channelUserId: 'h', conversationId: 'c1' })).rejects.toThrow('sin número de origen');
  });

  it('la entrega de AnswerReady falla cerrado sin el número de origen configurado', async () => {
    delete process.env.WHATSAPP_ORIGINATION_PHONE_NUMBER_ID;
    process.env.TABLE_NAME = 'tabla';
    await expect(deliverHandler({ detail: { answer, channelUserId: 'hash', conversationId: 'c1' } } as never)).rejects.toThrow('no configurado');
  });
});

describe('WhatsAppIdentityStore', () => {
  it('persiste hash→teléfono con TTL razonable y claves privadas del canal', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = new WhatsAppIdentityStore('identities', { send } as unknown as DynamoDBClient);
    const now = new Date('2025-01-01T00:00:00.000Z');
    await store.put('hash-id', '59899123456', now);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutItemCommand);
    expect(command.input).toMatchObject({
      TableName: 'identities',
      Item: { channelUserId: { S: 'hash-id' }, phoneNumber: { S: '59899123456' }, expiresAt: { N: String(Math.floor(now.getTime() / 1000) + DEFAULT_IDENTITY_TTL_SECONDS) } },
    });
  });

  it('resuelve solamente mappings vigentes con lectura consistente', async () => {
    const future = Math.floor(new Date('2025-02-01T00:00:00.000Z').getTime() / 1000);
    const send = vi.fn().mockResolvedValue({ Item: { phoneNumber: { S: '59899123456' }, expiresAt: { N: String(future) } } });
    const store = new WhatsAppIdentityStore('identities', { send } as unknown as DynamoDBClient);
    await expect(store.resolve('hash-id', new Date('2025-01-01T00:00:00.000Z'))).resolves.toBe('59899123456');
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetItemCommand);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ TableName: 'identities', ConsistentRead: true });
    await expect(store.resolve('hash-id', new Date('2025-03-01T00:00:00.000Z'))).resolves.toBeUndefined();
  });
});
