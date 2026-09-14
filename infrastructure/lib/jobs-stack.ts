import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import type { PelpEnv } from '../config/env';
import type { DataStack } from './data-stack';
import { METRICS_NAMESPACE, bedrockModelPolicy } from './engine-stack';
import { pelpFunction } from './lambda';

export interface JobsStackProps extends StackProps {
  pelp: PelpEnv;
  data: DataStack;
  /** Nombre de la API pública para el dashboard (sin dependencia de CloudFormation). */
  apiName: string;
}

/**
 * pelp-jobs: sync-feed (60 min), reconcile-api (01:00), prune-corpus (01:30), ingestion-status (15 min), profiler,
 * evals, bias-report, costs (nocturnos), backfill (manual). Alarmas y dashboard (sección 15).
 * Horarios en UTC: Uruguay es UTC-3 sin horario de verano.
 */
export class JobsStack extends Stack {
  readonly functions: Record<string, NodejsFunction>;
  /** Reglas programadas por clave de trabajo: el backoffice las lee y las edita. */
  readonly rules: Record<string, events.Rule> = {};

  constructor(scope: Construct, id: string, props: JobsStackProps) {
    super(scope, id, props);
    const { pelp, data } = props;

    const environment = {
      PELP_ENV: pelp.envName,
      SERVICE_NAME: 'pelp-jobs',
      METRICS_NAMESPACE,
      TABLE_NAME: data.table.tableName,
      CORPUS_BUCKET: data.corpusBucket.bucketName,
      KNOWLEDGE_BASE_ID: data.knowledgeBase.attrKnowledgeBaseId,
      DATA_SOURCE_ID: data.dataSource.attrDataSourceId,
      GUARDRAIL_ID: data.guardrail.attrGuardrailId,
      GUARDRAIL_VERSION: data.guardrailVersion.attrVersion,
      FEED_SECRET_ARN: data.feedSecret.secretArn,
      DAILYBRIEF_SECRET_ARN: data.dailyBriefSecret.secretArn,
      EVENT_BUS_NAME: data.eventBus.eventBusName,
    };

    const make = (name: string, entry: string, timeoutMinutes: number, description: string, memorySize = 1024) =>
      pelpFunction(this, `Job${name.replace(/(^|-)(\w)/g, (_m, _p, c: string) => c.toUpperCase())}`, {
        functionName: `pelp-job-${name}${pelp.suffix}`,
        entry,
        description,
        timeout: Duration.minutes(timeoutMinutes),
        memorySize,
        environment,
      });

    this.functions = {
      syncFeed: make('sync-feed', 'apps/jobs/src/sync-feed.ts', 5, 'Sync horario del feed de El País → S3 → ingestión incremental.'),
      reconcileApi: make('reconcile-api', 'apps/jobs/src/reconcile-api.ts', 10, 'Reconciliación diaria contra la API de Daily Brief.'),
      backfill: make('backfill', 'apps/jobs/src/backfill.ts', 15, 'Carga histórica manual por rango de fechas.'),
      pruneCorpus: make('prune-corpus', 'apps/jobs/src/prune-corpus.ts', 10, 'Purga diaria de notas fuera de la ventana de retención.'),
      ingestionStatus: make('ingestion-status', 'apps/jobs/src/ingestion-status.ts', 2, 'Seguimiento del job de ingestión de la Knowledge Base.', 512),
      profiler: make('profiler', 'apps/jobs/src/profiler.ts', 15, 'Perfiles de lectores (nocturno y por evento ProfileDue).'),
      evals: make('evals', 'apps/jobs/src/evals.ts', 15, 'Evaluación del set dorado.'),
      biasReport: make('bias-report', 'apps/jobs/src/bias-report.ts', 15, 'Reporte de sesgo con auto-bajada de intensidad.'),
      costs: make('costs', 'apps/jobs/src/costs.ts', 2, 'Consolidación diaria de costos y presupuesto.', 512),
    };

    for (const fn of Object.values(this.functions)) {
      data.table.grantReadWriteData(fn);
      data.eventBus.grantPutEventsTo(fn);
      fn.addToRolePolicy(bedrockModelPolicy(this));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [data.knowledgeBaseArn] }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [data.guardrail.attrGuardrailArn] }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs'], resources: [data.knowledgeBaseArn] }));
    }
    for (const fn of [this.functions.syncFeed, this.functions.reconcileApi, this.functions.backfill, this.functions.ingestionStatus, this.functions.pruneCorpus]) {
      if (!fn) continue;
      data.corpusBucket.grantReadWrite(fn);
      data.feedSecret.grantRead(fn);
      data.dailyBriefSecret.grantRead(fn);
    }

    /* ------------------------------- Schedules ------------------------------- */
    const enabled = !pelp.devShutdown;
    const schedule = (
      id: string,
      fn: NodejsFunction | undefined,
      expression: events.Schedule,
      description: string,
      payload?: Record<string, unknown>,
      key?: string,
    ) => {
      if (!fn) return;
      const rule = new events.Rule(this, id, {
        ruleName: `pelp-${id.toLowerCase()}${pelp.suffix}`,
        description,
        schedule: expression,
        enabled,
        targets: [new targets.LambdaFunction(fn, { retryAttempts: 2, ...(payload ? { event: events.RuleTargetInput.fromObject(payload) } : {}) })],
      });
      if (key) this.rules[key] = rule;
    };
    schedule('SyncFeedHourly', this.functions.syncFeed, events.Schedule.rate(Duration.minutes(60)), 'sync-feed cada 60 minutos (5.3)', { trigger: 'scheduled' }, 'sync-feed');
    schedule('IngestionStatus', this.functions.ingestionStatus, events.Schedule.rate(Duration.minutes(15)), 'estado de ingestión cada 15 minutos', undefined, 'ingestion-status');
    schedule('ReconcileDaily', this.functions.reconcileApi, events.Schedule.cron({ minute: '0', hour: '4' }), 'reconcile-api 01:00 Montevideo (04:00 UTC)', undefined, 'reconcile-api');
    schedule('PruneDaily', this.functions.pruneCorpus, events.Schedule.cron({ minute: '30', hour: '4' }), 'purga de notas viejas 01:30 Montevideo (ADR 0007)', undefined, 'prune-corpus');
    schedule('ProfilerNightly', this.functions.profiler, events.Schedule.cron({ minute: '0', hour: '5' }), 'profiler 02:00 Montevideo', undefined, 'profiler');
    schedule('EvalsNightly', this.functions.evals, events.Schedule.cron({ minute: '0', hour: '6' }), 'evaluación nocturna 03:00 Montevideo', { trigger: 'nightly' }, 'evals');
    schedule('BiasNightly', this.functions.biasReport, events.Schedule.cron({ minute: '30', hour: '6' }), 'reporte de sesgo 03:30 Montevideo', undefined, 'bias-report');
    schedule('CostsNightly', this.functions.costs, events.Schedule.cron({ minute: '55', hour: '2' }), 'consolidación de costos 23:55 Montevideo', undefined, 'costs');

    if (this.functions.profiler) {
      new events.Rule(this, 'ProfileDue', {
        ruleName: `pelp-profile-due${pelp.suffix}`,
        eventBus: data.eventBus,
        eventPattern: { source: ['pelp.engine'], detailType: ['ProfileDue'] },
        targets: [new targets.LambdaFunction(this.functions.profiler)],
      });
    }

    /* -------------------------------- Alarmas -------------------------------- */
    const alarmAction = new cwactions.SnsAction(data.alarmsTopic);
    const jobsDims = { Service: 'pelp-jobs', Env: pelp.envName };
    const engineDims = { Service: 'pelp-engine', Env: pelp.envName };
    const metric = (name: string, dims: Record<string, string>, statistic: string, period: Duration) =>
      new cloudwatch.Metric({ namespace: METRICS_NAMESPACE, metricName: name, dimensionsMap: dims, statistic, period });
    const alarms = [
      new cloudwatch.Alarm(this, 'SyncFailed3x', {
        alarmName: `pelp-sync-failed-3x${pelp.suffix}`,
        metric: metric('SyncFailed', jobsDims, 'Sum', Duration.hours(1)),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'Budget80', {
        alarmName: `pelp-budget-80${pelp.suffix}`,
        metric: metric('BudgetPercent', engineDims, 'Maximum', Duration.minutes(15)),
        threshold: 80,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'Budget100', {
        alarmName: `pelp-budget-100${pelp.suffix}`,
        metric: metric('BudgetPercent', engineDims, 'Maximum', Duration.minutes(15)),
        threshold: 100,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'BiasFactDivergence', {
        alarmName: `pelp-bias-fact-divergence${pelp.suffix}`,
        metric: metric('BiasFactDivergence', jobsDims, 'Sum', Duration.hours(24)),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(alarmAction);

    /* ------------------------------- Dashboard ------------------------------- */
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: `pelp${pelp.suffix}` });
    const apiMetric = (name: string, statistic: string) =>
      new cloudwatch.Metric({ namespace: 'AWS/ApiGateway', metricName: name, dimensionsMap: { ApiName: props.apiName }, statistic, period: Duration.minutes(5) });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Preguntas (canal web)', left: [metric('Questions', { ...engineDims, Channel: 'web' }, 'Sum', Duration.hours(1))], width: 8 }),
      new cloudwatch.GraphWidget({ title: '% con cobertura', left: [metric('Coverage', engineDims, 'Average', Duration.hours(1))], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'Latencia API p95 (ms)', left: [apiMetric('Latency', 'p95')], width: 8 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Costo USD por hora', left: [metric('CostUsd', engineDims, 'Sum', Duration.hours(1))], width: 8 }),
      new cloudwatch.GraphWidget({ title: '% presupuesto del día', left: [metric('BudgetPercent', engineDims, 'Maximum', Duration.minutes(15))], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'Aciertos de caché', left: [metric('CacheHit', engineDims, 'Average', Duration.hours(1))], width: 8 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Fallos de grounding', left: [metric('GroundingFailed', engineDims, 'Sum', Duration.hours(1))], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'Sync fallido / notas del feed', left: [metric('SyncFailed', jobsDims, 'Sum', Duration.hours(1)), metric('FeedArticles', jobsDims, 'Maximum', Duration.hours(1))], width: 8 }),
      new cloudwatch.GraphWidget({ title: 'Evaluación: tasa de pasadas', left: [metric('EvalPassRate', jobsDims, 'Average', Duration.hours(24))], width: 8 }),
    );

    for (const [name, fn] of Object.entries(this.functions)) new CfnOutput(this, `${name}FunctionName`, { value: fn.functionName });
  }
}
