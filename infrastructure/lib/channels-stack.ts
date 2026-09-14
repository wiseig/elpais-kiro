import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { PelpEnv } from '../config/env';
import type { DataStack } from './data-stack';
import { METRICS_NAMESPACE } from './engine-stack';
import { pelpFunction } from './lambda';

export interface ChannelsStackProps extends StackProps {
  pelp: PelpEnv;
  data: DataStack;
}

/**
 * pelp-channels (fase 3): webhooks de WhatsApp y Discord que verifican firma, encolan en
 * pelp-inbound y entregan al recibir AnswerReady. Agregar un canal no toca pelp-engine.
 */
export class ChannelsStack extends Stack {
  readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ChannelsStackProps) {
    super(scope, id, props);
    const { pelp, data } = props;

    const common = {
      PELP_ENV: pelp.envName,
      SERVICE_NAME: 'pelp-channels',
      METRICS_NAMESPACE,
      TABLE_NAME: data.table.tableName,
      CHANNEL_IDENTITIES_TABLE_NAME: data.table.tableName,
      INBOUND_QUEUE_URL: data.inboundQueue.queueUrl,
      IDENTITY_SECRET_ARN: data.identitySecret.secretArn,
      TERMS_URL: pelp.termsUrl,
    };

    const whatsappWebhook = pelpFunction(this, 'WhatsAppWebhook', {
      functionName: `pelp-channel-whatsapp${pelp.suffix}`,
      entry: 'apps/channels/whatsapp/src/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(15),
      memorySize: 512,
      environment: { ...common, CHANNEL_SECRET_ARN: data.whatsappSecret.secretArn },
    });
    const whatsappDeliver = pelpFunction(this, 'WhatsAppDeliver', {
      functionName: `pelp-channel-whatsapp-deliver${pelp.suffix}`,
      entry: 'apps/channels/whatsapp/src/index.ts',
      handler: 'deliverHandler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: { ...common, CHANNEL_SECRET_ARN: data.whatsappSecret.secretArn },
    });
    const discordInteractions = pelpFunction(this, 'DiscordInteractions', {
      functionName: `pelp-channel-discord${pelp.suffix}`,
      entry: 'apps/channels/discord/src/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(10),
      memorySize: 512,
      environment: { ...common, CHANNEL_SECRET_ARN: data.discordSecret.secretArn },
    });
    const discordDeliver = pelpFunction(this, 'DiscordDeliver', {
      functionName: `pelp-channel-discord-deliver${pelp.suffix}`,
      entry: 'apps/channels/discord/src/index.ts',
      handler: 'deliverHandler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: { ...common, CHANNEL_SECRET_ARN: data.discordSecret.secretArn },
    });

    for (const fn of [whatsappWebhook, whatsappDeliver]) {
      data.inboundQueue.grantSendMessages(fn);
      data.table.grantReadWriteData(fn);
      data.identitySecret.grantRead(fn);
      data.whatsappSecret.grantRead(fn);
    }
    for (const fn of [discordInteractions, discordDeliver]) {
      data.inboundQueue.grantSendMessages(fn);
      data.table.grantReadWriteData(fn);
      data.identitySecret.grantRead(fn);
      data.discordSecret.grantRead(fn);
    }

    this.api = new apigateway.RestApi(this, 'ChannelsApi', {
      restApiName: `pelp-channels-api${pelp.suffix}`,
      description: 'Webhooks de canales (WhatsApp, Discord).',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: { stageName: pelp.envName, throttlingRateLimit: 50, throttlingBurstLimit: 100, metricsEnabled: true },
    });
    const channels = this.api.root.addResource('channels');
    const whatsapp = channels.addResource('whatsapp');
    whatsapp.addMethod('GET', new apigateway.LambdaIntegration(whatsappWebhook, { proxy: true }));
    whatsapp.addMethod('POST', new apigateway.LambdaIntegration(whatsappWebhook, { proxy: true }));
    channels.addResource('discord').addMethod('POST', new apigateway.LambdaIntegration(discordInteractions, { proxy: true }));

    new wafv2.CfnWebACLAssociation(this, 'ChannelsWaf', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`,
      webAclArn: data.webAclRegional.attrArn,
    });

    const deliverRule = (id: string, channel: string, fn: typeof whatsappDeliver) =>
      new events.Rule(this, id, {
        ruleName: `pelp-answer-ready-${channel}${pelp.suffix}`,
        eventBus: data.eventBus,
        eventPattern: { source: ['pelp.engine'], detailType: ['AnswerReady'], detail: { channel: [channel] } },
        targets: [new targets.LambdaFunction(fn, { retryAttempts: 2 })],
      });
    deliverRule('WhatsAppAnswerReady', 'whatsapp', whatsappDeliver);
    deliverRule('DiscordAnswerReady', 'discord', discordDeliver);

    new CfnOutput(this, 'WhatsAppWebhookUrl', { value: `${this.api.url}channels/whatsapp` });
    new CfnOutput(this, 'DiscordInteractionsUrl', { value: `${this.api.url}channels/discord` });
  }
}
