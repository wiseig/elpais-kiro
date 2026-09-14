import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { HttpError, buildContext, intParam, json, parseBody, query, requireAdmin, type AdminContext } from './context';
import { overview } from './modules/overview';
import { getConfig, getVersion, listVersions, putConfig, rollback } from './modules/config';
import { jobRuns, listJobs, runJob, updateJob } from './modules/jobs';
import { listQuestions, markForEval, questionDetail, unmarkForEval } from './modules/questions';
import { sendToNewsroom, trending } from './modules/trending';
import { listReaders, readerDetail, readersSummary, removeReader } from './modules/readers';
import { biasReports, incidents } from './modules/personalization';
import { mailingLists, subscribe, unsubscribe } from './modules/notifications';
import { alertHistory, listAlerts, updateAlert } from './modules/alerts';
import { createUser, deleteUser, listUsers, resendInvite, resetPassword, setUserEnabled } from './modules/users';
import { createCase, deleteCase, listCases, listRuns, runEvals, updateCase } from './modules/evals';
import { backfill, corpusStatus, deleteArticle, forceSync, searchArticles } from './modules/corpus';
import { auditLog, blocks, costs, getChannels, putChannels, testChannel } from './modules/misc';

type Handler = (ctx: AdminContext, event: APIGatewayProxyEvent, params: Record<string, string>) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
  const names: string[] = [];
  const pattern = new RegExp(`^${path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    names.push(name);
    return '([^/]+)';
  })}$`);
  routes.push({ method, pattern, names, handler });
}

route('GET', '/admin/overview', (ctx) => overview(ctx));
route('GET', '/admin/config', (ctx) => getConfig(ctx));
route('PUT', '/admin/config', (ctx, event) => putConfig(ctx, parseBody(event)));
route('GET', '/admin/config/versions', (ctx) => listVersions(ctx));
route('GET', '/admin/config/versions/{n}', (ctx, _event, params) => getVersion(ctx, Number(params.n)));
route('POST', '/admin/config/rollback', (ctx, event) => rollback(ctx, parseBody(event)));
route('GET', '/admin/questions', (ctx, event) => listQuestions(ctx, query(event)));
route('GET', '/admin/questions/{id}', (ctx, _event, params) => questionDetail(ctx, params.id ?? ''));
route('POST', '/admin/questions/{id}/mark-eval', (ctx, _event, params) => markForEval(ctx, params.id ?? ''));
route('DELETE', '/admin/questions/{id}/mark-eval', (ctx, _event, params) => unmarkForEval(ctx, params.id ?? ''));
route('GET', '/admin/trending', (ctx, event) => {
  const q = query(event);
  const coverage = q.coverage === 'yes' || q.coverage === 'no' ? q.coverage : 'all';
  return trending(ctx, intParam(q.days, 7, 1, 30), coverage);
});
route('POST', '/admin/trending/send', (ctx, event) => sendToNewsroom(ctx, parseBody(event)));
route('GET', '/admin/readers/summary', (ctx, event) => readersSummary(ctx, intParam(query(event).days, 30, 1, 90)));
route('GET', '/admin/readers', (ctx, event) => {
  const q = query(event);
  return listReaders(ctx, q.channel, intParam(q.limit, 100, 1, 1000));
});
route('GET', '/admin/readers/{id}', (ctx, _event, params) => readerDetail(ctx, params.id ?? ''));
route('DELETE', '/admin/readers/{id}', (ctx, event, params) => removeReader(ctx, params.id ?? '', parseBody<{ reason: string }>(event).reason));
route('GET', '/admin/bias', (ctx, event) => biasReports(ctx, intParam(query(event).days, 30, 1, 90)));
route('GET', '/admin/personalization/incidents', (ctx, event) => incidents(ctx, intParam(query(event).days, 7, 1, 30)));
route('GET', '/admin/jobs', (ctx) => listJobs(ctx));
route('PATCH', '/admin/jobs/{key}', (ctx, event, params) => updateJob(ctx, params.key ?? '', parseBody(event)));
route('POST', '/admin/jobs/{key}/run', (ctx, _event, params) => runJob(ctx, params.key ?? ''));
route('GET', '/admin/jobs/{key}/runs', (ctx, _event, params) => jobRuns(ctx, params.key ?? ''));
route('GET', '/admin/evals/cases', (ctx) => listCases(ctx));
route('POST', '/admin/evals/cases', (ctx, event) => createCase(ctx, parseBody(event)));
route('PUT', '/admin/evals/cases/{id}', (ctx, event, params) => updateCase(ctx, params.id ?? '', parseBody(event)));
route('DELETE', '/admin/evals/cases/{id}', (ctx, _event, params) => deleteCase(ctx, params.id ?? ''));
route('POST', '/admin/evals/run', (ctx) => runEvals(ctx));
route('GET', '/admin/evals/runs', (ctx, event) => listRuns(ctx, intParam(query(event).limit, 20, 1, 100)));
route('GET', '/admin/corpus/status', (ctx) => corpusStatus(ctx));
route('POST', '/admin/corpus/sync', (ctx) => forceSync(ctx));
route('POST', '/admin/corpus/backfill', (ctx, event) => backfill(ctx, parseBody(event)));
route('GET', '/admin/corpus/articles', (ctx, event) => searchArticles(ctx, query(event).q ?? ''));
route('DELETE', '/admin/corpus/articles/{id}', (ctx, event, params) => deleteArticle(ctx, params.id ?? '', parseBody<{ reason: string }>(event).reason));
route('GET', '/admin/guardrails/blocks', (ctx, event) => blocks(ctx, intParam(query(event).days, 7, 1, 30)));
route('GET', '/admin/users', (ctx) => listUsers(ctx));
route('POST', '/admin/users', (ctx, event) => createUser(ctx, parseBody(event)));
route('POST', '/admin/users/{name}/resend', (ctx, _event, params) => resendInvite(ctx, decodeURIComponent(params.name ?? '')));
route('POST', '/admin/users/{name}/reset', (ctx, _event, params) => resetPassword(ctx, decodeURIComponent(params.name ?? '')));
route('PATCH', '/admin/users/{name}', (ctx, event, params) =>
  setUserEnabled(ctx, decodeURIComponent(params.name ?? ''), parseBody<{ enabled: boolean }>(event).enabled === true),
);
route('DELETE', '/admin/users/{name}', (ctx, event, params) =>
  deleteUser(ctx, decodeURIComponent(params.name ?? ''), parseBody<{ reason: string }>(event).reason),
);
route('GET', '/admin/alerts', (ctx) => listAlerts(ctx));
route('PATCH', '/admin/alerts/{key}', (ctx, event, params) => updateAlert(ctx, params.key ?? '', parseBody(event)));
route('GET', '/admin/alerts/{key}/history', (ctx, _event, params) => alertHistory(ctx, params.key ?? ''));
route('GET', '/admin/mailing', (ctx) => mailingLists(ctx));
route('POST', '/admin/mailing/{key}/subscriptions', (ctx, event, params) => subscribe(ctx, params.key ?? '', parseBody(event)));
route('DELETE', '/admin/mailing/{key}/subscriptions', (ctx, event, params) => unsubscribe(ctx, params.key ?? '', parseBody(event)));
route('GET', '/admin/channels', (ctx) => getChannels(ctx));
route('PUT', '/admin/channels', (ctx, event) => putChannels(ctx, parseBody(event)));
route('POST', '/admin/channels/{id}/test', (ctx, _event, params) => testChannel(ctx, params.id ?? ''));
route('GET', '/admin/costs', (ctx, event) => costs(ctx, intParam(query(event).days, 30, 1, 90)));
route('GET', '/admin/audit', (ctx, event) => {
  const q = query(event);
  return auditLog(ctx, intParam(q.days, 30, 1, 365), intParam(q.limit, 200, 1, 1000));
});

export function routePath(event: APIGatewayProxyEvent): string {
  let path = event.path || '/';
  const stage = event.requestContext?.stage;
  if (stage && path.startsWith(`/${stage}/`)) path = path.slice(stage.length + 1);
  return path.replace(/\/+$/, '') || '/';
}

export async function handleAdmin(event: APIGatewayProxyEvent, contextFactory: (actor: string) => AdminContext = buildContext): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod.toUpperCase();
  const path = routePath(event);
  if (method === 'OPTIONS') return json(204, null);
  try {
    const actor = requireAdmin(event);
    const ctx = contextFactory(actor);
    for (const candidate of routes) {
      if (candidate.method !== method) continue;
      const match = candidate.pattern.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      candidate.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1] ?? '');
      });
      const body = await candidate.handler(ctx, event, params);
      return json(200, body);
    }
    return json(404, { error: 'Ruta no encontrada.', code: 'not_found' });
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message, code: error.code, ...(error.extra ?? {}) });
    console.error(JSON.stringify({ level: 'error', message: 'admin.unhandled', path, method, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
    return json(500, { error: 'Error interno.', code: 'internal' });
  }
}

export const handler = (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => handleAdmin(event);
