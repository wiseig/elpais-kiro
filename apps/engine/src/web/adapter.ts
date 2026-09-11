import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { Answer, InboundMessage } from '@pelp/domain';
import { TENANT_ID } from '@pelp/domain';
import { hashChannelIdentity, ipPrefixHash, uaHash } from '@pelp/domain/node';
import type { ChannelAdapter, ChannelContext, OutboundPayload } from '@pelp/channel-sdk';
import { bearerToken, verifySession } from './session';

export interface WebRequest {
  event: APIGatewayProxyEvent;
  body: { question?: unknown; conversationId?: unknown };
  now: Date;
}

export function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

export function requestEvidence(event: APIGatewayProxyEvent, secret: string): { uaHash?: string; ipPrefixHash?: string; locale?: string } {
  const ua = uaHash(secret, header(event, 'user-agent'));
  const ip = ipPrefixHash(secret, event.requestContext?.identity?.sourceIp);
  const locale = header(event, 'accept-language')?.split(',')[0]?.trim();
  return { ...(ua ? { uaHash: ua } : {}), ...(ip ? { ipPrefixHash: ip } : {}), ...(locale ? { locale } : {}) };
}

/**
 * Adaptador del canal web (10.1, 10.2). Verifica el token de sesión, hashea la identidad
 * antes de que el motor la vea y devuelve el Answer como JSON en la respuesta síncrona.
 */
export class WebAdapter implements ChannelAdapter<WebRequest> {
  readonly channel = 'web';

  constructor(private readonly secret: string) {}

  verify(req: WebRequest): boolean {
    return Boolean(verifySession(this.secret, bearerToken(req.event.headers)));
  }

  sessionId(req: WebRequest): string | undefined {
    return verifySession(this.secret, bearerToken(req.event.headers))?.sid;
  }

  identityHash(sid: string): string {
    return hashChannelIdentity(this.secret, this.channel, sid);
  }

  parse(req: WebRequest): InboundMessage[] {
    const sid = this.sessionId(req);
    if (!sid) return [];
    const text = typeof req.body.question === 'string' ? req.body.question : '';
    const conversationId = typeof req.body.conversationId === 'string' && req.body.conversationId ? req.body.conversationId : undefined;
    const evidence = requestEvidence(req.event, this.secret);
    return [
      {
        tenantId: TENANT_ID,
        channel: this.channel,
        channelUserId: this.identityHash(sid),
        ...(conversationId ? { conversationId } : {}),
        text,
        ...(evidence.locale ? { locale: evidence.locale } : {}),
        receivedAt: req.now.toISOString(),
        meta: { ...(evidence.uaHash ? { uaHash: evidence.uaHash } : {}), ...(evidence.ipPrefixHash ? { ipPrefixHash: evidence.ipPrefixHash } : {}) },
      },
    ];
  }

  render(answer: Answer, _ctx: ChannelContext): OutboundPayload[] {
    return [{ kind: 'json', body: answer }];
  }

  async deliver(_payloads: OutboundPayload[], _ctx: ChannelContext): Promise<void> {
    // La entrega web es la propia respuesta HTTP.
  }
}
