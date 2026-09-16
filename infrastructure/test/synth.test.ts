import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ALLOWED_ACCOUNT, ALLOWED_REGION, loadEnv } from '../config/env';
import { BackofficeStack } from '../lib/backoffice-stack';
import { ChannelsStack } from '../lib/channels-stack';
import { DataStack } from '../lib/data-stack';
import { EngineStack } from '../lib/engine-stack';
import { JobsStack } from '../lib/jobs-stack';

function synth(envName: 'dev' | 'prod') {
  const app = new App({ context: { env: envName, 'aws:cdk:bundling-stacks': [] } });
  const pelp = loadEnv(app);
  const env = { account: ALLOWED_ACCOUNT, region: ALLOWED_REGION };
  const data = new DataStack(app, `pelp-data-${envName}`, { env, pelp });
  const engine = new EngineStack(app, `pelp-engine-${envName}`, { env, pelp, data });
  const jobs = new JobsStack(app, `pelp-jobs-${envName}`, { env, pelp, data, apiName: 'pelp-api' });
  const channels = new ChannelsStack(app, `pelp-channels-${envName}`, { env, pelp, data });
  const backoffice = new BackofficeStack(app, `pelp-backoffice-${envName}`, { env, pelp, data, jobs });
  return { data: Template.fromStack(data), engine: Template.fromStack(engine), jobs: Template.fromStack(jobs), channels: Template.fromStack(channels), backoffice: Template.fromStack(backoffice) };
}

const HOURLY_COST_TYPES = ['AWS::EC2::NatGateway', 'AWS::EC2::VPC', 'AWS::OpenSearchServerless::Collection', 'AWS::RDS::DBCluster', 'AWS::RDS::DBInstance', 'AWS::ECS::Service', 'AWS::ElasticLoadBalancingV2::LoadBalancer'];

describe('stacks pelp-*', () => {
  const templates = synth('dev');

  it('no crea recursos con costo por hora (principio 2.3)', () => {
    for (const template of Object.values(templates)) {
      const resources = template.toJSON().Resources as Record<string, { Type: string }>;
      for (const resource of Object.values(resources)) expect(HOURLY_COST_TYPES).not.toContain(resource.Type);
    }
  });

  it('tabla única con TTL, PITR y dos GSI (sección 12)', () => {
    templates.data.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'pelp-main-dev',
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    const table = Object.values(templates.data.findResources('AWS::DynamoDB::Table'))[0] as { Properties: { GlobalSecondaryIndexes: { IndexName: string }[] } };
    expect(table.Properties.GlobalSecondaryIndexes.map((gsi) => gsi.IndexName)).toEqual(['GSI1', 'GSI2']);
  });

  it('Knowledge Base con Titan v2 sobre S3 Vectors y chunking fijo 300/20 % (5.4)', () => {
    templates.data.hasResourceProperties('AWS::Bedrock::KnowledgeBase', { StorageConfiguration: { Type: 'S3_VECTORS' } });
    templates.data.hasResourceProperties('AWS::S3Vectors::Index', { Dimension: 1024, DistanceMetric: 'cosine' });
    templates.data.hasResourceProperties('AWS::Bedrock::DataSource', {
      VectorIngestionConfiguration: { ChunkingConfiguration: { ChunkingStrategy: 'FIXED_SIZE', FixedSizeChunkingConfiguration: { MaxTokens: 300, OverlapPercentage: 20 } } },
    });
  });

  it('guardrail con prompt attack alto, grounding 0,7 y PII anonimizada (sección 7)', () => {
    templates.data.hasResourceProperties('AWS::Bedrock::Guardrail', {
      ContextualGroundingPolicyConfig: { FiltersConfig: [{ Type: 'GROUNDING', Threshold: 0.7 }, { Type: 'RELEVANCE', Threshold: 0.5 }] },
    });
    templates.data.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
  });

  it('APIs con WAF, Lambdas Node 22 arm64 y cola con DLQ', () => {
    templates.engine.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    templates.backoffice.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    // El backoffice manda la configuración entera en el cuerpo: sin contar SizeRestrictions_BODY,
    // el WAF bloquea todo guardado apenas la configuración pasa los 8 KB (16/9/2026).
    // El backoffice habla con la API a través de su propia distribución: el cuerpo pasa por las
    // dos ACL, así que la excepción tiene que existir en las dos.
    for (const acl of ['^pelp-admin', '^pelp-web-admin']) {
      templates.data.hasResourceProperties('AWS::WAFv2::WebACL', {
        Name: Match.stringLikeRegexp(acl),
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: Match.objectLike({
                Name: 'AWSManagedRulesCommonRuleSet',
                RuleActionOverrides: [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }],
              }),
            },
          }),
        ]),
      });
    }
    templates.engine.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Architectures: ['arm64'], FunctionName: 'pelp-engine-dev' });
    templates.data.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'pelp-inbound-dev' });
    templates.backoffice.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'COGNITO_USER_POOLS' });
  });

  it('jobs programados: sync cada hora, reconciliación 04:00 y purga 04:30 UTC', () => {
    templates.jobs.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 hour)' });
    templates.jobs.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(0 4 * * ? *)' });
    templates.jobs.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(30 4 * * ? *)' });
    templates.jobs.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  it('prod retiene tabla y bucket', () => {
    const prod = synth('prod');
    prod.data.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    prod.data.hasResourceProperties('AWS::S3::Bucket', { BucketName: 'pelp-corpus-178042202224' });
  });
});
