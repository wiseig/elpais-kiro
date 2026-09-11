import { generateKeyPairSync, sign } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { Answer } from '@pelp/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqsSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = sqsSend; },
  SendMessageCommand: class { constructor(readonly input: unknown) {} },
}));

import { DiscordAdapter, inboundQueueBody, interactions } from '../src/index.js';

function event(body: string, headers: Record<string, string> = {}, isBase64Encoded = false): APIGatewayProxyEvent {
  return { body: isBase64Encoded ? Buffer.from(body).toString('base64') : body, headers, isBase64Encoded, httpMethod: 'POST' } as APIGatewayProxyEvent;
}

function signedEvent(payload: object): { event: APIGatewayProxyEvent; publicKey: string } {
  const body = JSON.stringify(payload);
  const timestamp = '1700000000';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  return { event: event(body, { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp }), publicKey: rawPublicKey };
}

const answer = {
  answerId: 'a1', conversationId: 'c1', hadCoverage: true, personalized: false, latencyMs: 10,
  blocks: [{ type: 'notice', text: 'consentimiento', code: 'consent_required' }],
} as Answer;

describe('DiscordAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISCORD_PUBLIC_KEY;
    delete process.env.PELP_IDENTITY_SECRET;
    delete process.env.INBOUND_QUEUE_URL;
  });

  it('verifica firmas Ed25519 válidas y rechaza firma, clave o body alterados', () => {
    const signed = signedEvent({ type: 1, id: 'i', token: 't' });
    const adapter = new DiscordAdapter({ publicKey: signed.publicKey, identitySecret: 'identity' });
    expect(adapter.verify(signed.event)).toBe(true);
    expect(adapter.verify({ ...signed.event, body: `${signed.event.body} ` })).toBe(false);
    expect(new DiscordAdapter({ identitySecret: 'identity' }).verify(signed.event)).toBe(false);
  });

  it('parsea /elpais, exige su nombre y no expone el id Discord', () => {
    const payload = { type: 2, id: 'i', token: 'token', application_id: 'app', member: { user: { id: 'discord-user-123' } }, data: { name: 'elpais', options: [{ name: 'pregunta', value: '¿Qué pasó hoy?' }] } };
    const parsed = new DiscordAdapter({ identitySecret: 'identity' }).parse(event(JSON.stringify(payload)));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.text).toBe('¿Qué pasó hoy?');
    expect(parsed[0]?.channelUserId).not.toContain('discord-user-123');
    expect(inboundQueueBody(parsed[0]!)).not.toContain('discord-user-123');
    expect(new DiscordAdapter({ identitySecret: 'identity' }).parse(event(JSON.stringify({ ...payload, data: { ...payload.data, name: 'otro' } })))).toEqual([]);
  });

  it('normaliza type 3 de consentimiento como meta.action y nunca como pregunta', () => {
    const payload = { type: 3, id: 'i', token: 'token', application_id: 'app', user: { id: 'u1' }, data: { custom_id: 'consent_personalize' } };
    const [inbound] = new DiscordAdapter({ identitySecret: 'identity' }).parse(event(JSON.stringify(payload)));
    expect(inbound?.text).toBe('');
    expect(inbound?.meta?.action).toBe('consent_personalize');
    expect(new DiscordAdapter({ identitySecret: 'identity' }).parse(event(JSON.stringify({ ...payload, data: { custom_id: 'unknown' } })))).toEqual([]);
  });

  it('normaliza comandos de borrado como acción explícita', () => {
    const payload = { type: 2, id: 'i', token: 'token', user: { id: 'u1' }, data: { name: 'elpais', options: [{ name: 'pregunta', value: 'Borrar mis datos' }] } };
    const [inbound] = new DiscordAdapter({ identitySecret: 'identity' }).parse(event(JSON.stringify(payload)));
    expect(inbound).toMatchObject({ text: '', meta: { action: 'delete_data' } });
  });

  it('renderiza consentimiento con botones y fuentes dentro de límites Discord', () => {
    const adapter = new DiscordAdapter({});
    expect(adapter.render(answer, { channel: 'discord', channelUserId: 'h', conversationId: 'c1' })).toEqual([
      expect.objectContaining({ kind: 'buttons', buttons: [expect.objectContaining({ id: 'consent_personalize' }), expect.objectContaining({ id: 'consent_neutral' })] }),
    ]);
    const rendered = adapter.render({ ...answer, blocks: [{ type: 'text', text: 'respuesta' }, { type: 'sources', items: [{ title: 'Nota', url: 'https://example.test', date: '2025-01-01', section: 'Política' }] }] } as Answer, { channel: 'discord', channelUserId: 'h', conversationId: 'c1' });
    expect(rendered[0]).toMatchObject({ kind: 'embed', description: 'respuesta', fields: [{ name: 'Nota', value: 'Política · 2025-01-01 · https://example.test' }] });
  });

  it('falla cerrado sin secretos y difiere comandos de forma efímera', async () => {
    const unsigned = event('{}');
    expect(await interactions(unsigned)).toMatchObject({ statusCode: 500 });

    const payload = { type: 2, id: 'i', token: 'token', application_id: 'app', user: { id: 'u1' }, data: { name: 'elpais', options: [{ name: 'pregunta', value: 'pregunta' }] } };
    const signed = signedEvent(payload);
    process.env.DISCORD_PUBLIC_KEY = signed.publicKey;
    process.env.PELP_IDENTITY_SECRET = 'identity';
    process.env.INBOUND_QUEUE_URL = 'https://sqs.test/queue';
    const response = await interactions(signed.event);
    expect(JSON.parse(response.body)).toEqual({ type: 5, data: { flags: 64 } });
    expect(sqsSend).toHaveBeenCalledOnce();
  });

  it('acuse type 3 actualizando el mensaje efímero original', async () => {
    const payload = { type: 3, id: 'i', token: 'token', application_id: 'app', user: { id: 'u1' }, data: { custom_id: 'consent_neutral' } };
    const signed = signedEvent(payload);
    process.env.DISCORD_PUBLIC_KEY = signed.publicKey;
    process.env.PELP_IDENTITY_SECRET = 'identity';
    process.env.INBOUND_QUEUE_URL = 'https://sqs.test/queue';
    const response = await interactions(signed.event);
    expect(JSON.parse(response.body)).toEqual({ type: 6 });
    expect(sqsSend).toHaveBeenCalledOnce();
  });
});
