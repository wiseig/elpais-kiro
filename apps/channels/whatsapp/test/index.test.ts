import { createHmac } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Answer } from '@pelp/domain';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IDENTITY_TTL_SECONDS, WhatsAppAdapter, WhatsAppIdentityStore, inboundQueueBody, webhook } from '../src/index.js';

function event(body: string, headers: Record<string, string> = {}, isBase64Encoded = false, method = 'POST'): APIGatewayProxyEvent {
  return { body: isBase64Encoded ? Buffer.from(body).toString('base64') : body, headers, isBase64Encoded, httpMethod: method } as APIGatewayProxyEvent;
}

function webhookBody(message: object): string {
  return JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
}

const answer = {
  answerId: 'a1', conversationId: 'c1', hadCoverage: true, personalized: false, latencyMs: 10,
  blocks: [{ type: 'notice', text: 'consentimiento', code: 'consent_required' }],
} as Answer;

describe('WhatsAppAdapter', () => {
  it('verifica HMAC sobre bytes exactos, incluso body base64, y falla sin secreto', () => {
    const body = webhookBody({ from: '59899123456', type: 'text', text: { body: 'hola' } });
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    const adapter = new WhatsAppAdapter({ appSecret: 'app-secret', identitySecret: 'identity' });
    expect(adapter.verify(event(body, { 'x-hub-signature-256': signature }))).toBe(true);
    expect(adapter.verify(event(body, { 'X-Hub-Signature-256': signature }, true))).toBe(true);
    expect(adapter.verify(event(`${body} `, { 'x-hub-signature-256': signature }))).toBe(false);
    expect(new WhatsAppAdapter({ identitySecret: 'identity' }).verify(event(body, { 'x-hub-signature-256': signature }))).toBe(false);
  });

  it('hashea el teléfono y el envelope de SQS no contiene el número claro', () => {
    const phone = '59899123456';
    const [inbound] = new WhatsAppAdapter({ identitySecret: 'identity' }).parse(event(webhookBody({ from: phone, id: 'm1', timestamp: '1700000000', type: 'text', text: { body: '¿Qué pasó?' } })));
    expect(inbound?.text).toBe('¿Qué pasó?');
    expect(inbound?.channelUserId).not.toBe(phone);
    expect(inboundQueueBody(inbound!)).not.toContain(phone);
  });

  it('normaliza botones y comandos sensibles como meta.action con text vacío', () => {
    const adapter = new WhatsAppAdapter({ identitySecret: 'identity' });
    const [consent] = adapter.parse(event(webhookBody({ from: '5981', type: 'interactive', interactive: { button_reply: { id: 'consent_neutral', title: 'Usar sin personalizar' } } })));
    expect(consent).toMatchObject({ text: '', meta: { buttonId: 'consent_neutral', action: 'consent_neutral' } });
    const [deletion] = adapter.parse(event(webhookBody({ from: '5981', type: 'text', text: { body: 'Borrar mis datos' } })));
    expect(deletion).toMatchObject({ text: '', meta: { action: 'delete_data' } });
  });

  it('renderiza la puerta con link no truncado y limita botones/sugerencias', () => {
    process.env.TERMS_URL = 'https://example.test/terminos';
    const adapter = new WhatsAppAdapter({});
    const [rendered] = adapter.render(answer, { channel: 'whatsapp', channelUserId: 'h', conversationId: 'c1' });
    expect(rendered).toMatchObject({ kind: 'buttons', buttons: [expect.objectContaining({ id: 'consent_personalize' }), expect.objectContaining({ id: 'consent_neutral' })] });
    expect(rendered?.kind === 'buttons' && rendered.text.endsWith('https://example.test/terminos')).toBe(true);
    expect(rendered?.kind === 'buttons' && rendered.text.length).toBeLessThanOrEqual(1024);
    delete process.env.TERMS_URL;
  });

  it('entrega al teléfono resuelto y falla cerrado sin credenciales', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const adapter = new WhatsAppAdapter({ accessToken: 'token', phoneNumberId: 'phone-id' }, fetchImpl as unknown as typeof fetch);
    await adapter.deliver([{ kind: 'text', text: 'respuesta' }], { channel: 'whatsapp', channelUserId: '59899123456', conversationId: 'c1' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ to: '59899123456', text: { body: 'respuesta' } });
    await expect(new WhatsAppAdapter({}).deliver([{ kind: 'text', text: 'x' }], { channel: 'whatsapp', channelUserId: 'h', conversationId: 'c1' })).rejects.toThrow('sin token');
  });

  it('falla cerrado si falta el verify token del webhook GET', async () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const result = await webhook({ ...event('', {}, false, 'GET'), queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'challenge' } });
    expect(result.statusCode).toBe(500);
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
