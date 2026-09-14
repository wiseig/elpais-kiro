import type { ChannelEntry } from '@pelp/domain';
import { lastDays } from '@pelp/domain';
import type { AuditResponse, BlocksResponse, ChannelsResponse, CostsResponse } from '@pelp/domain/api';
import { HttpError, audit, type AdminContext } from '../context';
import { controlQuestions, isControlQuestion } from './control';

export async function blocks(ctx: AdminContext, days: number): Promise<BlocksResponse> {
  const items = [];
  for (const day of lastDays(days, ctx.now)) items.push(...(await ctx.store.listBlocks(day)));
  // El smoke test dispara el set dorado contra la API real, y tres de esos casos existen
  // justamente para que los guardrails los frenen. Se marcan para no mezclarlos con lectores.
  const control = await controlQuestions(ctx);
  const byKind: Record<string, number> = {};
  const evalSetByKind: Record<string, number> = {};
  const marked = items.map((item) => {
    const fromEvalSet = isControlQuestion(item.sampleMasked, control);
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    if (fromEvalSet) evalSetByKind[item.kind] = (evalSetByKind[item.kind] ?? 0) + 1;
    return fromEvalSet ? { ...item, fromEvalSet } : item;
  });
  return { days, byKind, evalSetByKind, items: marked.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300) };
}

export const DEFAULT_CHANNELS: ChannelEntry[] = [
  { id: 'web', enabled: true, limits: { perUserPerHour: 30, maxMessageChars: 500 }, notes: 'Chat web (síncrono, API Gateway).' },
  { id: 'whatsapp', enabled: false, limits: { perUserPerHour: 30, maxMessageChars: 1600 }, notes: 'Meta Cloud API (fase 3).' },
  { id: 'discord', enabled: false, limits: { perUserPerHour: 30, maxMessageChars: 2000 }, notes: 'Interacciones Ed25519, comando /elpais (fase 3).' },
];

export async function getChannels(ctx: AdminContext): Promise<ChannelsResponse> {
  const record = await ctx.store.getChannels();
  return record ? { items: record.items, updatedAt: record.updatedAt } : { items: DEFAULT_CHANNELS };
}

export async function putChannels(ctx: AdminContext, body: { items?: unknown }): Promise<ChannelsResponse> {
  if (!Array.isArray(body.items)) throw new HttpError(400, 'items debe ser una lista.', 'invalid_channels');
  const items: ChannelEntry[] = body.items.map((raw) => {
    const item = raw as Partial<ChannelEntry>;
    if (!item.id || typeof item.id !== 'string') throw new HttpError(400, 'Cada canal necesita id.', 'invalid_channels');
    if (item.secretArn && !/^arn:aws:secretsmanager:/.test(item.secretArn)) throw new HttpError(400, `secretArn inválido para ${item.id}: debe ser un ARN, nunca el valor.`, 'invalid_channels');
    return {
      id: item.id,
      enabled: item.enabled === true,
      ...(item.webhookUrl ? { webhookUrl: String(item.webhookUrl) } : {}),
      ...(item.secretArn ? { secretArn: item.secretArn } : {}),
      limits: { perUserPerHour: Number(item.limits?.perUserPerHour) || 30, maxMessageChars: Number(item.limits?.maxMessageChars) || 1000 },
      ...(item.lastMessageAt ? { lastMessageAt: item.lastMessageAt } : {}),
      ...(item.notes ? { notes: String(item.notes).slice(0, 500) } : {}),
    };
  });
  const before = await ctx.store.getChannels();
  await ctx.store.putChannels({ items, updatedAt: ctx.now.toISOString(), updatedBy: ctx.actor });
  await audit(ctx, 'channels.put', undefined, { before: before?.items, after: items });
  return { items, updatedAt: ctx.now.toISOString() };
}

export async function testChannel(ctx: AdminContext, id: string): Promise<{ ok: boolean; detail?: string }> {
  const { items } = await getChannels(ctx);
  const channel = items.find((item) => item.id === id);
  if (!channel) throw new HttpError(404, 'Canal no encontrado.', 'not_found');
  await audit(ctx, 'channels.test', id);
  if (id === 'web') return { ok: true, detail: 'El canal web responde en la propia API pública.' };
  if (!channel.enabled) return { ok: false, detail: 'El canal está deshabilitado.' };
  if (!channel.webhookUrl || !channel.secretArn) return { ok: false, detail: 'Falta webhookUrl o secretArn.' };
  return { ok: true, detail: 'Configuración completa. El envío real de prueba se habilita al desplegar el adaptador (fase 3).' };
}

export async function costs(ctx: AdminContext, days: number): Promise<CostsResponse> {
  const config = await ctx.config.get();
  const byDay: CostsResponse['byDay'] = [];
  const byModel: CostsResponse['byModel'] = {};
  const byChannel: Record<string, number> = {};
  let total = 0;
  const dayList = lastDays(days, ctx.now);
  for (const day of dayList) {
    const records = await ctx.store.listCosts(day);
    const entry = { day, costUsd: 0, calls: 0, byModel: {} as Record<string, number> };
    for (const record of records) {
      entry.costUsd += record.costUsd ?? 0;
      entry.calls += record.calls ?? 0;
      entry.byModel[record.model] = (entry.byModel[record.model] ?? 0) + (record.costUsd ?? 0);
      const model = (byModel[record.model] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
      model.inputTokens += record.inputTokens ?? 0;
      model.outputTokens += record.outputTokens ?? 0;
      model.costUsd += record.costUsd ?? 0;
      model.calls += record.calls ?? 0;
      for (const [channel, usd] of Object.entries(record.byChannel ?? {})) byChannel[channel] = (byChannel[channel] ?? 0) + usd;
    }
    total += entry.costUsd;
    byDay.push(entry);
  }
  byDay.reverse();
  const activeDays = byDay.filter((entry) => entry.calls > 0).length || 1;
  const today = byDay.at(-1);
  const todayUsd = today?.costUsd ?? 0;
  return {
    days,
    byDay,
    byModel,
    byChannel,
    totalUsd: round(total),
    projectedMonthUsd: round((total / activeDays) * 30),
    dailyBudgetUsd: config.limits.dailyBudgetUsd,
    todayUsd: round(todayUsd),
    todayPercent: config.limits.dailyBudgetUsd > 0 ? round((todayUsd / config.limits.dailyBudgetUsd) * 100) : 0,
  };
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export async function auditLog(ctx: AdminContext, days: number, limit: number): Promise<AuditResponse> {
  const from = new Date(ctx.now.getTime() - days * 86_400_000).toISOString();
  const to = new Date(ctx.now.getTime() + 60_000).toISOString();
  return { items: await ctx.store.listAudit(from, to, limit) };
}
