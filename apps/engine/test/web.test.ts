import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handleHttp } from '../src/web/routes';
import { issueSession, verifySession } from '../src/web/session';
import { SECRET, buildDeps } from './fakes';

function event(method: string, path: string, body?: unknown, token?: string): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
    isBase64Encoded: false,
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/{proxy+}',
    requestContext: { stage: 'prod', identity: { sourceIp: '190.64.10.20' } } as unknown as APIGatewayProxyEvent['requestContext'],
  };
}

describe('sesión web', () => {
  it('firma y verifica tokens; rechaza alterados', () => {
    const token = issueSession(SECRET, new Date('2026-09-11T00:00:00Z'));
    const payload = verifySession(SECRET, token);
    expect(payload?.sid).toHaveLength(26);
    expect(verifySession(SECRET, `${token}x`)).toBeUndefined();
    expect(verifySession('otro', token)).toBeUndefined();
    expect(verifySession(SECRET, undefined)).toBeUndefined();
  });
});

describe('rutas /v1', () => {
  it('flujo completo: sesión → me → consentimiento → ask → neutral → feedback → borrado', async () => {
    const { deps } = buildDeps();
    const session = await handleHttp(deps, event('POST', '/prod/v1/session'));
    expect(session.statusCode).toBe(200);
    const { token } = JSON.parse(session.body) as { token: string };

    const unauth = await handleHttp(deps, event('GET', '/v1/me'));
    expect(unauth.statusCode).toBe(401);
    expect(JSON.parse(unauth.body).code).toBe('session_required');

    const me = await handleHttp(deps, event('GET', '/v1/me', undefined, token));
    expect(JSON.parse(me.body)).toMatchObject({ mode: 'undecided', needsConsent: true });

    const gated = await handleHttp(deps, event('POST', '/v1/ask', { question: '¿Qué pasó con los trabajadores del Frigorífico Tacuarembó?' }, token));
    expect(gated.statusCode).toBe(200);
    expect(JSON.parse(gated.body).blocks[0].code).toBe('consent_required');

    const text = JSON.parse((await handleHttp(deps, event('GET', '/v1/consent/text'))).body) as { textVersion: string; buttons: { personalize: string } };
    expect(text.buttons.personalize).toBe('Aceptar y personalizar');

    const consent = await handleHttp(deps, event('POST', '/v1/consent', { decision: 'neutral', textVersion: text.textVersion }, token));
    expect(consent.statusCode).toBe(200);
    expect(JSON.parse(consent.body)).toMatchObject({ mode: 'neutral', needsConsent: false });

    const ask = await handleHttp(deps, event('POST', '/v1/ask', { question: '¿Qué pasó con los trabajadores del Frigorífico Tacuarembó?' }, token));
    expect(ask.statusCode).toBe(200);
    const answer = JSON.parse(ask.body) as { answerId: string; hadCoverage: boolean; blocks: { type: string }[] };
    expect(answer.hadCoverage).toBe(true);

    const neutral = await handleHttp(deps, event('GET', `/v1/answers/${answer.answerId}/neutral`, undefined, token));
    expect(neutral.statusCode).toBe(200);
    expect(JSON.parse(neutral.body).blocks[0].type).toBe('text');

    const feedback = await handleHttp(deps, event('POST', '/v1/feedback', { answerId: answer.answerId, vote: 'down', comment: 'Faltó el sindicato' }, token));
    expect(feedback.statusCode).toBe(200);
    expect((await deps.store.getQuestionLog(answer.answerId))?.feedback?.vote).toBe('down');

    const click = await handleHttp(deps, event('POST', '/v1/events', { type: 'SourceClicked', answerId: answer.answerId, url: 'https://www.elpais.com.uy/negocios/frigorifico-tacuarembo' }, token));
    expect(click.statusCode).toBe(200);

    const suggestions = await handleHttp(deps, event('GET', '/v1/suggestions', undefined, token));
    expect(JSON.parse(suggestions.body).items.length).toBeGreaterThan(0);

    const deleted = await handleHttp(deps, event('DELETE', '/v1/me', undefined, token));
    expect(JSON.parse(deleted.body)).toEqual({ deleted: true });
    const after = await handleHttp(deps, event('GET', '/v1/me', undefined, token));
    expect(JSON.parse(after.body)).toMatchObject({ mode: 'undecided', needsConsent: true });
    expect((await deps.store.getQuestionLog(answer.answerId))?.readerId).toBeUndefined();
  });

  it('devuelve 429 y 400 con códigos para el canal web', async () => {
    const { deps } = buildDeps();
    const token = JSON.parse((await handleHttp(deps, event('POST', '/v1/session'))).body).token as string;
    const text = JSON.parse((await handleHttp(deps, event('GET', '/v1/consent/text'))).body) as { textVersion: string };
    await handleHttp(deps, event('POST', '/v1/consent', { decision: 'neutral', textVersion: text.textVersion }, token));
    const long = await handleHttp(deps, event('POST', '/v1/ask', { question: 'x'.repeat(700) }, token));
    expect(long.statusCode).toBe(400);
    expect(JSON.parse(long.body).code).toBe('too_long');
    const bad = await handleHttp(deps, event('POST', '/v1/consent', { decision: 'personalize', textVersion: text.textVersion }, token));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).code).toBe('age_required');
    const missing = await handleHttp(deps, event('GET', '/v1/nada', undefined, token));
    expect(missing.statusCode).toBe(404);
  });
});
