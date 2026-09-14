import { DescribeRuleCommand, DisableRuleCommand, EnableRuleCommand, PutRuleCommand } from '@aws-sdk/client-cloudwatch-events';
import { lastDays } from '@pelp/domain';
import type { SyncRunRecord } from '@pelp/domain';
import type { JobRun, JobRunsResponse, JobSummary, JobsResponse, UpdateJobRequest } from '@pelp/domain/api';
import { getIngestionState } from '@pelp/jobs';
import { HttpError, audit, type AdminContext } from '../context';

/** Catálogo de trabajos programados. El orden es el que ve la redacción en el panel. */
const CATALOG: { key: string; label: string; description: string; source: JobSummary['lastRunSource'] }[] = [
  { key: 'sync-feed', label: 'Sincronizar feed', description: 'Baja las notas del día de El País, guarda las nuevas o cambiadas y lanza la indexación.', source: 'sync' },
  { key: 'ingestion-status', label: 'Estado de indexación', description: 'Sigue la indexación en curso y publica la versión nueva del corpus al terminar.', source: 'ingestion' },
  { key: 'reconcile-api', label: 'Reconciliar con Daily Brief', description: 'Agrega las notas del día que el feed no trajo, consultando la API de Daily Brief.', source: 'sync' },
  { key: 'prune-corpus', label: 'Purgar notas viejas', description: 'Borra del bucket, del índice y de la búsqueda lo publicado fuera de la ventana de retención.', source: 'sync' },
  { key: 'profiler', label: 'Perfilar lectores', description: 'Construye los perfiles de quienes eligieron personalizar. También corre cada cinco preguntas.', source: 'none' },
  { key: 'evals', label: 'Evaluar el set dorado', description: 'Corre las preguntas de control y mide cobertura, citas y fallas de sustento.', source: 'evals' },
  { key: 'bias-report', label: 'Reporte de sesgo', description: 'Audita las respuestas personalizadas y baja la intensidad sola si encuentra problemas.', source: 'bias' },
  { key: 'costs', label: 'Consolidar costos', description: 'Suma el gasto del día, calcula el porcentaje del presupuesto y proyecta el mes.', source: 'none' },
];

function mapFromEnv(ctx: AdminContext, name: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(ctx.env[name] ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** `rate(1 hour)` y `cron(30 4 * * ? *)` a algo que se pueda leer y editar. */
export function parseSchedule(expression: string): JobSummary['schedule'] {
  const rate = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/.exec(expression.trim());
  if (rate) {
    const every = Number(rate[1]);
    const unit = rate[2]?.startsWith('minute') ? 'minutes' : rate[2]?.startsWith('hour') ? 'hours' : 'days';
    return { kind: 'rate', expression, everyMinutes: unit === 'minutes' ? every : unit === 'hours' ? every * 60 : every * 1440 };
  }
  const cron = /^cron\((\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\?\s+\*\)$/.exec(expression.trim());
  if (cron) return { kind: 'daily', expression, utcMinute: Number(cron[1]), utcHour: Number(cron[2]) };
  return { kind: 'other', expression };
}

/** Próxima corrida para los dos casos que sabemos calcular; el resto queda sin estimar. */
export function nextRun(schedule: JobSummary['schedule'], now: Date, lastRunAt?: string): string | undefined {
  if (schedule.kind === 'daily') {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.utcHour, schedule.utcMinute, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  if (schedule.kind === 'rate' && lastRunAt && schedule.everyMinutes) {
    const last = Date.parse(lastRunAt);
    if (Number.isNaN(last)) return undefined;
    const step = schedule.everyMinutes * 60_000;
    const next = last + Math.max(1, Math.ceil((now.getTime() - last) / step)) * step;
    return new Date(next).toISOString();
  }
  return undefined;
}

async function lastRuns(ctx: AdminContext) {
  const [syncRuns, evalRuns, biasReports] = await Promise.all([
    ctx.store.listSyncRuns(40).catch(() => []),
    ctx.store.listEvalRuns(1).catch(() => []),
    ctx.store.listBiasReports(1).catch(() => []),
  ]);
  const ingestion = await getIngestionState(ctx.store).catch(() => undefined);
  return { syncRuns, evalRun: evalRuns[0], biasReport: biasReports[0], ingestion };
}

export async function listJobs(ctx: AdminContext): Promise<JobsResponse> {
  const rules = mapFromEnv(ctx, 'JOB_RULES');
  const functions = mapFromEnv(ctx, 'JOB_FUNCTIONS');
  const runs = await lastRuns(ctx);

  const jobs: JobSummary[] = [];
  for (const entry of CATALOG) {
    const ruleName = rules[entry.key];
    let schedule: JobSummary['schedule'] = { kind: 'other', expression: '' };
    let enabled = false;
    if (ruleName) {
      try {
        const rule = await ctx.events.send(new DescribeRuleCommand({ Name: ruleName }));
        schedule = parseSchedule(rule.ScheduleExpression ?? '');
        enabled = rule.State === 'ENABLED';
      } catch (error) {
        console.warn(JSON.stringify({ level: 'warn', message: 'jobs.describe_failed', rule: ruleName, error: String(error) }));
      }
    }

    let lastRunAt: string | undefined;
    let lastStatus: JobSummary['lastStatus'];
    let lastDetail: string | undefined;
    if (entry.source === 'sync') {
      const run = runs.syncRuns.find((item) => item.job === entry.key);
      if (run) {
        lastRunAt = run.finishedAt ?? run.startedAt;
        lastStatus = run.status === 'ok' ? 'ok' : run.status === 'failed' ? 'failed' : 'running';
        lastDetail = run.error ?? `${run.fetched} leídas · ${run.written} escritas`;
      }
    } else if (entry.source === 'evals' && runs.evalRun) {
      lastRunAt = runs.evalRun.finishedAt ?? runs.evalRun.startedAt;
      lastStatus = runs.evalRun.passed === runs.evalRun.total ? 'ok' : 'failed';
      lastDetail = `${runs.evalRun.passed}/${runs.evalRun.total} casos`;
    } else if (entry.source === 'bias' && runs.biasReport) {
      lastRunAt = runs.biasReport.at;
      lastStatus = runs.biasReport.clean ? 'ok' : 'failed';
      lastDetail = runs.biasReport.clean ? 'sin divergencias' : 'bajó la intensidad';
    } else if (entry.source === 'ingestion' && runs.ingestion?.lastCheckedAt) {
      lastRunAt = runs.ingestion.lastCheckedAt;
      lastStatus = runs.ingestion.lastStatus === 'FAILED' ? 'failed' : 'ok';
      lastDetail = runs.ingestion.lastStatus;
    }

    jobs.push({
      key: entry.key,
      label: entry.label,
      description: entry.description,
      schedule,
      enabled,
      configurable: Boolean(ruleName),
      runnable: Boolean(functions[entry.key]),
      lastRunSource: entry.source,
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(lastStatus ? { lastStatus } : {}),
      ...(lastDetail ? { lastDetail } : {}),
      ...(nextRun(schedule, ctx.now, lastRunAt) ? { nextRunAt: nextRun(schedule, ctx.now, lastRunAt) } : {}),
    });
  }
  return { jobs };
}

function expressionFrom(body: UpdateJobRequest): string | undefined {
  if (body.everyMinutes !== undefined) {
    const minutes = Math.round(body.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) {
      throw new HttpError(400, 'El intervalo tiene que estar entre 5 minutos y 24 horas.', 'bad_request');
    }
    return minutes % 60 === 0 && minutes >= 60 ? `rate(${minutes / 60} hours)` : `rate(${minutes} minutes)`;
  }
  if (body.utcHour !== undefined && body.utcMinute !== undefined) {
    const hour = Math.round(body.utcHour);
    const minute = Math.round(body.utcMinute);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new HttpError(400, 'Hora inválida.', 'bad_request');
    return `cron(${minute} ${hour} * * ? *)`;
  }
  return undefined;
}

/** Cambia horario y/o estado de una regla. Se relee antes para no borrar lo que no se toca. */
export async function updateJob(ctx: AdminContext, key: string, body: UpdateJobRequest): Promise<JobsResponse> {
  const ruleName = mapFromEnv(ctx, 'JOB_RULES')[key];
  if (!ruleName) throw new HttpError(404, 'Ese trabajo no tiene una regla programada.', 'not_found');

  const current = await ctx.events.send(new DescribeRuleCommand({ Name: ruleName }));
  const expression = expressionFrom(body) ?? current.ScheduleExpression;
  const enabled = body.enabled ?? current.State === 'ENABLED';

  await ctx.events.send(
    new PutRuleCommand({
      Name: ruleName,
      ScheduleExpression: expression,
      Description: current.Description,
      State: enabled ? 'ENABLED' : 'DISABLED',
      ...(current.EventBusName ? { EventBusName: current.EventBusName } : {}),
    }),
  );
  // PutRule ya deja el estado pedido; el enable/disable explícito cubre reglas sin horario.
  if (body.enabled === true) await ctx.events.send(new EnableRuleCommand({ Name: ruleName })).catch(() => undefined);
  if (body.enabled === false) await ctx.events.send(new DisableRuleCommand({ Name: ruleName })).catch(() => undefined);

  await audit(ctx, 'jobs.update', key, {
    before: { schedule: current.ScheduleExpression, state: current.State },
    after: { schedule: expression, state: enabled ? 'ENABLED' : 'DISABLED' },
  });
  return listJobs(ctx);
}

/** Dispara el trabajo ahora, sin esperar al horario. */
export async function runJob(ctx: AdminContext, key: string): Promise<{ started: boolean; detail?: string }> {
  const functionName = mapFromEnv(ctx, 'JOB_FUNCTIONS')[key];
  if (!functionName) throw new HttpError(404, 'Ese trabajo no se puede disparar a mano.', 'not_found');
  const { InvokeCommand } = await import('@aws-sdk/client-lambda');
  await ctx.lambda.send(
    new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ trigger: 'manual' })) }),
  );
  await audit(ctx, 'jobs.run', key);
  return { started: true };
}

/* ------------------------ Resultados de cada trabajo ----------------------- */

/** Números listos para mostrar. Sin `Intl`: el runtime de Lambda no siempre trae todos los locales. */
const int = (value: number): string => String(Math.round(value));
const pct = (value: number): string => `${Math.round(value * 100)} %`;
const score = (value: number): string => value.toFixed(2);
const usd = (value: number): string => `US$ ${value.toFixed(4)}`;

/** Dónde mirar el detalle completo de cada trabajo. */
const LINKS: Record<string, { to: string; label: string }> = {
  'sync-feed': { to: '/corpus', label: 'Ver el corpus' },
  'ingestion-status': { to: '/corpus', label: 'Ver el corpus' },
  'reconcile-api': { to: '/corpus', label: 'Ver el corpus' },
  'prune-corpus': { to: '/corpus', label: 'Ver el corpus' },
  profiler: { to: '/lectores', label: 'Ver los lectores' },
  evals: { to: '/calidad', label: 'Ver calidad' },
  'bias-report': { to: '/personalizacion', label: 'Ver personalización' },
  costs: { to: '/costos', label: 'Ver costos' },
};

function syncRuns(runs: SyncRunRecord[], job: string): JobRun[] {
  return runs
    .filter((run) => run.job === job)
    .slice(0, 10)
    .map((run) => ({
      at: run.finishedAt ?? run.startedAt,
      status: run.status === 'ok' ? ('ok' as const) : run.status === 'failed' ? ('failed' as const) : ('running' as const),
      headline: run.status === 'failed' ? 'Falló' : `${int(run.written)} escritas de ${int(run.fetched)} leídas`,
      details: [
        { label: 'Leídas', value: int(run.fetched) },
        { label: 'Escritas', value: int(run.written) },
        { label: 'Sin cambios', value: int(run.unchanged) },
        ...(run.ingestionJobId ? [{ label: 'Indexación', value: run.ingestionJobId }] : []),
        ...(run.consecutiveFailures ? [{ label: 'Fallas seguidas', value: int(run.consecutiveFailures) }] : []),
      ],
      ...(run.error ? { error: run.error } : {}),
    }));
}

export async function jobRuns(ctx: AdminContext, key: string): Promise<JobRunsResponse> {
  const entry = CATALOG.find((item) => item.key === key);
  if (!entry) throw new HttpError(404, 'Ese trabajo no existe.', 'not_found');
  const link = LINKS[key];
  const base = { key, ...(link ? { link } : {}) };

  if (entry.source === 'sync') {
    const runs = await ctx.store.listSyncRuns(60).catch(() => []);
    return { ...base, runs: syncRuns(runs, key) };
  }

  if (entry.source === 'evals') {
    const runs = await ctx.store.listEvalRuns(10).catch(() => []);
    return {
      ...base,
      runs: runs.map((run) => ({
        at: run.finishedAt || run.startedAt,
        status: run.passed === run.total ? ('ok' as const) : ('failed' as const),
        headline: `${int(run.passed)} de ${int(run.total)} casos pasaron`,
        details: [
          { label: 'Acierto de cobertura', value: pct(run.coverageAccuracy) },
          { label: 'Precisión de citas', value: pct(run.citationPrecision) },
          { label: 'Recall de citas', value: pct(run.citationRecall) },
          { label: 'Fallo de grounding', value: pct(run.groundingFailureRate) },
          { label: 'Sin cobertura', value: pct(run.noCoverageRate) },
          { label: 'Costo', value: usd(run.costUsd) },
          { label: 'Disparo', value: run.trigger === 'nightly' ? 'automático' : 'a mano' },
          ...run.results.filter((item) => !item.passed).map((item) => ({ label: `Falló ${item.caseId}`, value: item.question })),
        ],
      })),
    };
  }

  if (entry.source === 'bias') {
    const reports = await ctx.store.listBiasReports(10).catch(() => []);
    return {
      ...base,
      runs: reports.map((report) => ({
        at: report.at,
        status: report.clean ? ('ok' as const) : report.autoLowered ? ('failed' as const) : ('warning' as const),
        headline: report.clean
          ? `Sin divergencias en ${int(report.samples)} muestras`
          : report.autoLowered
            ? `Bajó la intensidad a ${score(report.loweredTo ?? 0)}`
            : `${int(report.factDivergenceTotal)} divergencias de hechos`,
        details: [
          { label: 'Muestras auditadas', value: int(report.samples) },
          { label: 'Intensidad al correr', value: score(report.intensity) },
          { label: 'Divergencias de hechos', value: int(report.factDivergenceTotal) },
          { label: 'Citas iguales', value: pct(report.citationEqualityRate) },
          { label: 'Divergencia de encuadre', value: score(report.frameDivergenceAvg) },
          { label: 'Opinión detectada', value: int(report.opinionCount) },
          { label: 'Costo', value: usd(report.costUsd) },
        ],
      })),
    };
  }

  if (entry.source === 'ingestion') {
    const state = await getIngestionState(ctx.store).catch(() => undefined);
    if (!state?.lastCheckedAt) return { ...base, runs: [], note: 'Todavía no se registró ninguna revisión de indexación.' };
    return {
      ...base,
      runs: [
        {
          at: state.lastCheckedAt,
          status: state.lastStatus === 'FAILED' ? 'failed' : state.activeJobId ? 'running' : 'ok',
          headline: state.activeJobId ? `Indexación en curso (${state.lastStatus ?? 'IN_PROGRESS'})` : `Última revisión: ${state.lastStatus ?? 'sin estado'}`,
          details: [
            { label: 'Generación pedida', value: int(state.generation) },
            { label: 'Generación publicada', value: int(state.completedGeneration) },
            ...(state.activeJobId ? [{ label: 'Trabajo activo', value: state.activeJobId }] : []),
            ...(state.dirtyAt ? [{ label: 'Cambios sin publicar desde', value: state.dirtyAt }] : []),
          ],
          ...(state.lastError ? { error: state.lastError } : {}),
        },
      ],
    };
  }

  if (key === 'costs') {
    const days = lastDays(7, ctx.now);
    const runs: JobRun[] = [];
    for (const day of days) {
      const records = await ctx.store.listCosts(day).catch(() => []);
      if (!records.length) continue;
      const total = records.reduce((sum, item) => sum + item.costUsd, 0);
      runs.push({
        at: `${day}T03:10:00.000Z`,
        status: 'ok',
        headline: `${usd(total)} el ${day}`,
        details: records
          .slice()
          .sort((a, b) => b.costUsd - a.costUsd)
          .slice(0, 6)
          .map((item) => ({ label: item.model, value: usd(item.costUsd) })),
      });
    }
    return { ...base, runs, ...(runs.length ? {} : { note: 'Todavía no hay gasto consolidado.' }) };
  }

  return {
    ...base,
    runs: [],
    note: 'Este trabajo no deja un registro propio de corridas: escribe directo sobre los perfiles de los lectores.',
  };
}
