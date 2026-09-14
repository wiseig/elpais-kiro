import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { SNSEvent } from 'aws-lambda';
import { montevideoDateTime } from '@pelp/domain';
import { logger } from '@pelp/engine/core';

/**
 * Las alarmas de CloudWatch mandan un correo en inglés, con jerga de la consola y la hora en UTC:
 * "at Monday 14 September, 2026 12:43:46 UTC" cuando en Montevideo eran las 09:43. Esta Lambda se
 * mete en el medio —las alarmas publican en el tema interno, ella escribe en el que lee la gente—
 * y lo traduce. No cambia a qué se suscribe nadie.
 */
interface AlarmMessage {
  AlarmName?: string;
  AlarmDescription?: string | null;
  NewStateValue?: string;
  OldStateValue?: string;
  NewStateReason?: string;
  StateChangeTime?: string;
}

const ESTADOS: Record<string, string> = {
  ALARM: 'saltó',
  OK: 'volvió a la normalidad',
  INSUFFICIENT_DATA: 'se quedó sin datos',
};

let client: SNSClient | undefined;

export function buildMail(alarm: AlarmMessage, fallback: string): { subject: string; body: string } {
  const name = alarm.AlarmName ?? 'alarma sin nombre';
  const state = alarm.NewStateValue ?? '';
  const verbo = ESTADOS[state] ?? `pasó a ${state || 'un estado desconocido'}`;
  const cuando = alarm.StateChangeTime ? new Date(alarm.StateChangeTime) : undefined;
  const lineas = [
    `La alarma «${name}» ${verbo}.`,
    '',
    cuando && !Number.isNaN(cuando.getTime()) ? `Cuándo: ${montevideoDateTime(cuando)} (hora de Montevideo)` : undefined,
    alarm.OldStateValue ? `Estado: ${state} (antes ${alarm.OldStateValue})` : undefined,
    alarm.AlarmDescription ? `Qué vigila: ${alarm.AlarmDescription}` : undefined,
    alarm.NewStateReason ? `Motivo: ${alarm.NewStateReason}` : undefined,
    '',
    'El detalle y el umbral de cada alarma están en el backoffice, en Alertas.',
  ].filter((line): line is string => line !== undefined);
  // Si el mensaje no era una alarma, se reenvía tal cual antes que perderlo.
  if (!alarm.AlarmName) return { subject: 'Preguntale a El País — aviso', body: fallback };
  return { subject: `Preguntale a El País — ${name} ${state === 'OK' ? 'se normalizó' : 'en alarma'}`, body: lineas.join('\n') };
}

export async function handler(event: SNSEvent): Promise<void> {
  const topicArn = process.env.ALERTS_TOPIC_ARN;
  if (!topicArn) {
    logger.error('alertmail.no_topic');
    return;
  }
  client ??= new SNSClient({ region: process.env.AWS_REGION });
  for (const record of event.Records) {
    const raw = record.Sns.Message;
    let alarm: AlarmMessage = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') alarm = parsed as AlarmMessage;
    } catch {
      // No era JSON: se reenvía el texto tal cual.
    }
    const { subject, body } = buildMail(alarm, raw);
    await client.send(new PublishCommand({ TopicArn: topicArn, Subject: subject.slice(0, 100), Message: body }));
    logger.info('alertmail.sent', { alarm: alarm.AlarmName ?? 'sin-nombre', state: alarm.NewStateValue ?? '' });
  }
}
