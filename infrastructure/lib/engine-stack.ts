import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { PelpEnv } from '../config/env';
import type { DataStack } from './data-stack';
import { pelpFunction } from './lambda';
import { SpaHosting } from './spa-hosting';

export interface EngineStackProps extends StackProps {
  pelp: PelpEnv;
  data: DataStack;
}

export const METRICS_NAMESPACE = 'PreguntaleElPais';

/** Permisos mínimos de Bedrock para el motor (sección 15): modelos Anthropic, la KB y el guardrail. */
export function bedrockModelPolicy(stack: Stack): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: [
      `arn:aws:bedrock:*::foundation-model/anthropic.*`,
      `arn:aws:bedrock:*::foundation-model/amazon.nova-*`,
      `arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.*`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/global.anthropic.*`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.amazon.nova-*`,
      `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/global.amazon.nova-*`,
    ],
  });
}

/** pelp-engine: Lambda del motor, API pública REST (WAF), cola de canales y hosting del chat web. */
export class EngineStack extends Stack {
  readonly api: apigateway.RestApi;
  readonly chatWeb: SpaHosting;

  constructor(scope: Construct, id: string, props: EngineStackProps) {
    super(scope, id, props);
    const { pelp, data } = props;

    const engine = pelpFunction(this, 'Engine', {
      functionName: `pelp-engine${pelp.suffix}`,
      entry: 'apps/engine/src/handler.ts',
      description: 'Motor de respuestas: guardrails, recuperación, canónica, adaptación y rutas /v1.',
      timeout: Duration.seconds(60),
      memorySize: 1536,
      environment: {
        PELP_ENV: pelp.envName,
        SERVICE_NAME: 'pelp-engine',
        METRICS_NAMESPACE,
        TABLE_NAME: data.table.tableName,
        IDENTITY_SECRET_ARN: data.identitySecret.secretArn,
        KNOWLEDGE_BASE_ID: data.knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: data.dataSource.attrDataSourceId,
        GUARDRAIL_ID: data.guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: data.guardrailVersion.attrVersion,
        EVENT_BUS_NAME: data.eventBus.eventBusName,
        ALLOWED_ORIGIN: pelp.allowedOrigin,
        TERMS_URL: pelp.termsUrl,
      },
    });
    data.table.grantReadWriteData(engine);
    data.identitySecret.grantRead(engine);
    data.eventBus.grantPutEventsTo(engine);
    engine.addToRolePolicy(bedrockModelPolicy(this));
    engine.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [data.knowledgeBaseArn] }));
    engine.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [data.guardrail.attrGuardrailArn] }));
    engine.addEventSource(new SqsEventSource(data.inboundQueue, { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 5 }));

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `pelp-api${pelp.suffix}`,
      description: 'API pública de Preguntale a El País (/v1).',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: pelp.envName,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: pelp.allowedOrigin === '*' ? apigateway.Cors.ALL_ORIGINS : [pelp.allowedOrigin],
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        maxAge: Duration.hours(1),
      },
    });
    const integration = new apigateway.LambdaIntegration(engine, { proxy: true, timeout: Duration.seconds(29) });
    const v1 = this.api.root.addResource('v1');
    v1.addProxy({ defaultIntegration: integration, anyMethod: true });

    new wafv2.CfnWebACLAssociation(this, 'ApiWaf', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`,
      webAclArn: data.webAclRegional.attrArn,
    });

    this.chatWeb = new SpaHosting(this, 'ChatWeb', {
      distDir: 'apps/chat-web/dist',
      configJson: { apiBaseUrl: '', env: pelp.envName },
      apiRoutes: [{ pathPattern: '/v1/*', api: this.api }],
      webAclArn: data.webAclCloudFront.attrArn,
      comment: `Preguntale a El País — chat web (${pelp.envName})`,
    });

    /* -------------------------------- Alarmas -------------------------------- */
    const alarmAction = new cwactions.SnsAction(data.alertsTopic);
    const alarms: cloudwatch.Alarm[] = [];
    alarms.push(
      new cloudwatch.Alarm(this, 'EngineErrors', {
        alarmName: `pelp-engine-errors${pelp.suffix}`,
        metric: engine.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarms.push(
      new cloudwatch.Alarm(this, 'Api5xx', {
        alarmName: `pelp-api-5xx${pelp.suffix}`,
        metric: new cloudwatch.MathExpression({
          expression: 'IF(count > 0, errors / count * 100, 0)',
          usingMetrics: {
            errors: this.api.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' }),
            count: this.api.metricCount({ period: Duration.minutes(5), statistic: 'Sum' }),
          },
          label: '% 5xx',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarms.push(
      new cloudwatch.Alarm(this, 'LatencyP95', {
        alarmName: `pelp-api-latency-p95${pelp.suffix}`,
        metric: this.api.metricLatency({ period: Duration.minutes(5), statistic: 'p95' }),
        threshold: 8000,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    const dims = { Service: 'pelp-engine', Env: pelp.envName };
    alarms.push(
      new cloudwatch.Alarm(this, 'GroundingFailures', {
        alarmName: `pelp-grounding-failures${pelp.suffix}`,
        metric: new cloudwatch.MathExpression({
          expression: 'IF(questions > 0, failed / questions * 100, 0)',
          usingMetrics: {
            failed: new cloudwatch.Metric({ namespace: METRICS_NAMESPACE, metricName: 'GroundingFailed', dimensionsMap: dims, statistic: 'Sum', period: Duration.hours(1) }),
            questions: new cloudwatch.Metric({ namespace: METRICS_NAMESPACE, metricName: 'Coverage', dimensionsMap: dims, statistic: 'SampleCount', period: Duration.hours(1) }),
          },
          label: '% fallos de grounding',
          period: Duration.hours(1),
        }),
        threshold: 10,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alarms.push(
      new cloudwatch.Alarm(this, 'InboundQueueAge', {
        alarmName: `pelp-inbound-age${pelp.suffix}`,
        metric: data.inboundQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 300,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    for (const alarm of alarms) alarm.addAlarmAction(alarmAction);

    new CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new CfnOutput(this, 'EngineFunctionName', { value: engine.functionName });
    new CfnOutput(this, 'ChatWebUrl', { value: `https://${this.chatWeb.distribution.distributionDomainName}` });
  }
}
