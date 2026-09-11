import { TENANT_ID } from './types';

/**
 * Claves de la tabla única `pelp-main` (spec v2, sección 12).
 * PK/SK son strings. TTL en `expiresAt` (epoch segundos).
 */

export interface Key {
  PK: string;
  SK: string;
}

const T = `TENANT#${TENANT_ID}`;

export const keys = {
  tenantPrefix: T,

  reader: (readerId: string): Key => ({ PK: `${T}#READER#${readerId}`, SK: 'PROFILE' }),
  readerPk: (readerId: string): string => `${T}#READER#${readerId}`,
  profileVersion: (readerId: string, ts: string): Key => ({ PK: `${T}#READER#${readerId}`, SK: `PROFILEV#${ts}` }),
  consent: (readerId: string, ts: string): Key => ({ PK: `${T}#READER#${readerId}`, SK: `CONSENT#${ts}` }),
  conversation: (readerId: string, ts: string, convId: string): Key => ({
    PK: `${T}#READER#${readerId}`,
    SK: `CONV#${ts}#${convId}`,
  }),
  click: (readerId: string, ts: string, id: string): Key => ({ PK: `${T}#READER#${readerId}`, SK: `CLICK#${ts}#${id}` }),

  identity: (channel: string, hash: string): Key => ({ PK: `${T}#IDENT#${channel}#${hash}`, SK: 'READER' }),

  conversationPk: (convId: string): string => `${T}#CONV#${convId}`,
  message: (convId: string, ts: string, msgId: string): Key => ({ PK: `${T}#CONV#${convId}`, SK: `MSG#${ts}#${msgId}` }),

  dayPk: (day: string): string => `${T}#DAY#${day}`,
  questionLog: (day: string, ts: string, msgId: string): Key => ({ PK: `${T}#DAY#${day}`, SK: `Q#${ts}#${msgId}` }),
  block: (day: string, ts: string, id: string): Key => ({ PK: `${T}#DAY#${day}`, SK: `BLOCK#${ts}#${id}` }),
  incident: (day: string, ts: string, id: string): Key => ({ PK: `${T}#DAY#${day}`, SK: `INCIDENT#${ts}#${id}` }),

  cache: (questionHash: string, corpusVersion: string): Key => ({ PK: `${T}#CACHE#${questionHash}`, SK: `V#${corpusVersion}` }),

  corpus: (articleId: string): Key => ({ PK: `${T}#CORPUS#${articleId}`, SK: 'META' }),
  corpusDay: (day: string): Key => ({ PK: `${T}#CORPUSDAY`, SK: `D#${day}` }),
  syncRun: (ts: string): Key => ({ PK: `${T}#SYNCRUN`, SK: ts }),

  config: (): Key => ({ PK: `${T}#CONFIG`, SK: 'CURRENT' }),
  configVersion: (n: number): Key => ({ PK: `${T}#CONFIG`, SK: `V#${String(n).padStart(6, '0')}` }),
  channels: (): Key => ({ PK: `${T}#CHANNELS`, SK: 'CURRENT' }),

  rateLimit: (readerId: string, hourKey: string): Key => ({ PK: `${T}#RL#${readerId}`, SK: `H#${hourKey}` }),

  evalRun: (ts: string): Key => ({ PK: `${T}#EVAL`, SK: `RUN#${ts}` }),
  evalCase: (id: string): Key => ({ PK: `${T}#EVAL`, SK: `CASE#${id}` }),

  bias: (day: string): Key => ({ PK: `${T}#BIAS`, SK: `DAY#${day}` }),

  cost: (day: string, model: string): Key => ({ PK: `${T}#COST`, SK: `DAY#${day}#${model}` }),

  audit: (ts: string, id: string): Key => ({ PK: `${T}#AUDIT`, SK: `${ts}#${id}` }),

  /** GSI1: listar por canal ordenado por tiempo. */
  gsi1Channel: (channel: string): string => `${T}#CHANNEL#${channel}`,
  /** GSI2: historial de una pregunta normalizada (tendencias). */
  gsi2Qnorm: (questionHash: string): string => `${T}#QNORM#${questionHash}`,
} as const;

export const GSI1 = { name: 'GSI1', pk: 'GSI1PK', sk: 'GSI1SK' } as const;
export const GSI2 = { name: 'GSI2', pk: 'GSI2PK', sk: 'GSI2SK' } as const;

/** Separa `MSG#<ts>#<id>` y similares. */
export function splitSk(sk: string): { kind: string; ts: string; id: string } {
  const [kind = '', ts = '', ...rest] = sk.split('#');
  return { kind, ts, id: rest.join('#') };
}
