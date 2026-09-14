import { PublishCommand } from '@aws-sdk/client-sns';
import type { SendTrendingRequest, TrendingItem, TrendingResponse } from '@pelp/domain/api';
import { montevideoDateTime } from '@pelp/domain';
import { HttpError, audit, type AdminContext } from '../context';
import { collectLogs, splitControl } from './questions';

export async function trending(ctx: AdminContext, days: number, coverage: 'yes' | 'no' | 'all' = 'all'): Promise<TrendingResponse> {
  // Huecos y tendencias tienen que hablar de lo que preguntan los lectores. Las corridas de
  // control repiten el set dorado todas las noches y encabezaban el ranking.
  const { readers, control } = await splitControl(ctx, await collectLogs(ctx, { days }));
  const logs = readers.filter((log) => !log.blocked);
  const groups = new Map<string, { items: typeof logs }>();
  for (const log of logs) {
    const group = groups.get(log.qnormHash) ?? { items: [] };
    group.items.push(log);
    groups.set(log.qnormHash, group);
  }
  const bySection: Record<string, number> = {};
  for (const log of logs) for (const topic of log.topics) bySection[topic] = (bySection[topic] ?? 0) + 1;
  const all: TrendingItem[] = [...groups.entries()]
    .map(([hash, group]) => {
      const sorted = [...group.items].sort((a, b) => b.at.localeCompare(a.at));
      const covered = group.items.filter((log) => log.hadCoverage).length;
      return {
        questionNormalized: sorted[0]?.questionNormalized ?? '',
        qnormHash: hash,
        count: group.items.length,
        coverageRate: covered / group.items.length,
        lastAt: sorted[0]?.at ?? '',
        channels: [...new Set(group.items.map((log) => log.channel))],
        topics: [...new Set(group.items.flatMap((log) => log.topics))].slice(0, 5),
        sample: sorted[0]?.questionMasked ?? '',
      };
    })
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  const items = all.filter((item) => (coverage === 'yes' ? item.coverageRate > 0 : coverage === 'no' ? item.coverageRate === 0 : true)).slice(0, 100);
  const gaps = all.filter((item) => item.coverageRate < 0.5).slice(0, 50);
  return { days, items, gaps, bySection, controlExcluded: control.length };
}

/** Envía las tendencias (o solo los huecos) a la redacción por SNS → mail. */
export async function sendToNewsroom(ctx: AdminContext, body: Partial<SendTrendingRequest>): Promise<{ ok: true }> {
  const topicArn = ctx.env.NEWSROOM_TOPIC_ARN;
  if (!topicArn) throw new HttpError(501, 'No hay un destino de redacción configurado (NEWSROOM_TOPIC_ARN).', 'not_configured');
  const days = Math.min(Math.max(body.days ?? 7, 1), 30);
  const report = await trending(ctx, days);
  const list = body.onlyGaps ? report.gaps : report.items;
  const lines = list.slice(0, 40).map((item, index) => `${index + 1}. (${item.count}) ${item.sample} — cobertura ${(item.coverageRate * 100).toFixed(0)} %`);
  const message = [
    `Preguntale a El País — ${body.onlyGaps ? 'huecos editoriales' : 'preguntas más frecuentes'} de los últimos ${days} días`,
    body.note ? `\nNota: ${body.note}` : '',
    '',
    ...lines,
    '',
    `Enviado por ${ctx.actor} el ${montevideoDateTime(ctx.now)} (hora de Montevideo).`,
  ].join('\n');
  await ctx.sns.send(new PublishCommand({ TopicArn: topicArn, Subject: `Preguntale a El País: ${body.onlyGaps ? 'huecos editoriales' : 'tendencias'} (${days} días)`, Message: message }));
  await audit(ctx, 'trending.send', undefined, { after: { days, onlyGaps: Boolean(body.onlyGaps), items: list.length }, ...(body.note ? { reason: body.note } : {}) });
  return { ok: true };
}
