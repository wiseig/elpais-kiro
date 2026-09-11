import type { Answer, InboundMessage } from '@pelp/domain';

/** Lo que un canal entrega: texto plano, JSON (web), botones o embed (Discord). */
export type OutboundPayload =
  | { kind: 'text'; text: string }
  | { kind: 'json'; body: unknown }
  | { kind: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | { kind: 'embed'; title: string; description: string; fields: { name: string; value: string }[] };

export interface ChannelContext {
  channel: string;
  /** Id de canal en claro: vive solo en memoria del adaptador. */
  channelUserId: string;
  conversationId: string;
  meta?: Record<string, string>;
}

/**
 * Contrato de la sección 10.1. Los canales verifican, traducen y renderizan. Nada más.
 * `Req` es el tipo de request nativo del canal (evento de API Gateway, mensaje SQS…).
 */
export interface ChannelAdapter<Req = unknown> {
  channel: string;
  verify(req: Req): boolean | Promise<boolean>;
  parse(req: Req): InboundMessage[] | Promise<InboundMessage[]>;
  render(answer: Answer, ctx: ChannelContext): OutboundPayload[];
  deliver(payloads: OutboundPayload[], ctx: ChannelContext): Promise<void>;
}
