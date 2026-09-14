import { lastDays } from '@pelp/domain';
import type { IncidentRecord } from '@pelp/domain';
import type { BiasResponse, IncidentsResponse } from '@pelp/domain/api';
import type { AdminContext } from '../context';

export async function biasReports(ctx: AdminContext, days: number): Promise<BiasResponse> {
  const reports = await ctx.store.listBiasReports(days);
  return { days, reports };
}

export async function incidents(ctx: AdminContext, days: number): Promise<IncidentsResponse> {
  const items: IncidentRecord[] = [];
  for (const day of lastDays(days, ctx.now)) items.push(...(await ctx.store.listIncidents(day)));
  const top = items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
  // Los incidentes viejos no guardaban la pregunta: se busca en el log para que la fila se lea.
  const filled = await Promise.all(
    top.map(async (item) => {
      if (item.questionMasked) return item;
      const log = await ctx.store.getQuestionLog(item.msgId).catch(() => undefined);
      return log?.questionMasked ? { ...item, questionMasked: log.questionMasked } : item;
    }),
  );
  return { items: filled };
}
