import type { EvalCaseRecord } from '@pelp/domain';
import { ulid } from '@pelp/domain';
import type { EvalCaseInput, EvalCasesResponse, EvalRunsResponse } from '@pelp/domain/api';
import { HttpError, audit, invokeJob, type AdminContext } from '../context';

function normalizeInput(body: Partial<EvalCaseInput>): Omit<EvalCaseRecord, 'PK' | 'SK' | 'type' | 'id' | 'createdAt' | 'createdBy' | 'source'> {
  if (typeof body.question !== 'string' || !body.question.trim()) throw new HttpError(400, 'Falta la pregunta.', 'invalid_case');
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []);
  return {
    question: body.question.trim(),
    expectedUrls: list(body.expectedUrls),
    expectedCoverage: body.expectedCoverage !== false,
    mustMention: list(body.mustMention),
    mustNotMention: list(body.mustNotMention),
    tags: list(body.tags),
  };
}

export async function listCases(ctx: AdminContext): Promise<EvalCasesResponse> {
  const items = await ctx.store.listEvalCases();
  return { items: items.sort((a, b) => a.id.localeCompare(b.id)) };
}

export async function createCase(ctx: AdminContext, body: Partial<EvalCaseInput>): Promise<EvalCaseRecord> {
  const input = normalizeInput(body);
  const record = { id: `bo-${ulid(ctx.now.getTime())}`, ...input, createdAt: ctx.now.toISOString(), createdBy: ctx.actor, source: 'backoffice' as const };
  await ctx.store.putEvalCase(record);
  await audit(ctx, 'evals.case.create', record.id, { after: record });
  return { ...record, PK: '', SK: '', type: 'EvalCase' };
}

export async function updateCase(ctx: AdminContext, id: string, body: Partial<EvalCaseInput>): Promise<EvalCaseRecord> {
  const existing = (await ctx.store.listEvalCases()).find((item) => item.id === id);
  if (!existing) throw new HttpError(404, 'Caso no encontrado.', 'not_found');
  const input = normalizeInput(body);
  const record = { ...existing, ...input };
  await ctx.store.putEvalCase(record);
  await audit(ctx, 'evals.case.update', id, { before: existing, after: record });
  return record;
}

export async function deleteCase(ctx: AdminContext, id: string): Promise<{ deleted: true }> {
  await ctx.store.deleteEvalCase(id);
  await audit(ctx, 'evals.case.delete', id);
  return { deleted: true };
}

export async function runEvals(ctx: AdminContext): Promise<{ started: boolean; detail?: string }> {
  const result = await invokeJob(ctx, 'JOB_EVALS_FUNCTION', { trigger: 'manual', requestedBy: ctx.actor });
  await audit(ctx, 'evals.run', undefined, { after: result });
  return result;
}

export async function listRuns(ctx: AdminContext, limit: number): Promise<EvalRunsResponse> {
  return { items: await ctx.store.listEvalRuns(limit) };
}
