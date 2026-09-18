import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
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
 * pelp-channels (fase 3): canales que encolan en pelp-inbound y entregan al recibir AnswerReady.
 * Agregar un canal no toca pelp-engine.
 *
 * WhatsApp va por AWS End User Messaging Social: AWS recibe el webhook de Meta y lo publica en
 * `whatsappInboundTopic`; el envío es una llamada al SDK con IAM. No hay webhook público ni
 * secretos de Meta. Discord sigue con su webhook firmado en la API.
 *
 * Después de vincular la cuenta de WhatsApp desde la consola (Embedded Signup), hay que apuntar
 * sus eventos al tema: `aws socialmessaging put-whatsapp-business-account-event-destinations`
 * con el ARN que sale en `WhatsAppInboundTopicArn`, y cargar el id del número de origen en
 * `PELP_WHATSAPP_ORIGINATION_PHONE_NUMBER_ID` para volver a desplegar este stack.
 */
export class ChannelsStack extends Stack {
  readonly api: apigateway.RestApi;
  readonly whatsappInboundTopic: sns.Topic;

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

    // Donde End User Messaging publica lo que llega a la cuenta de WhatsApp. Solo el servicio
    // publica; solo la Lambda de entrada consume.
    this.whatsappInboundTopic = new sns.Topic(this, 'WhatsAppInbound', { topicName: `pelp-whatsapp-inbound${pelp.suffix}` });
    this.whatsappInboundTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowEndUserMessagingPublish',
      principals: [new iam.ServicePrincipal('social-messaging.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.whatsappInboundTopic.topicArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));

    const whatsappEnv = { ...common, WHATSAPP_ORIGINATION_PHONE_NUMBER_ID: pelp.whatsappOriginationPhoneNumberId ?? '' };
    const whatsappInbound = pelpFunction(this, 'WhatsAppWebhook', {
      functionName: `pelp-channel-whatsapp${pelp.suffix}`,
      entry: 'apps/channels/whatsapp/src/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(15),
      memorySize: 512,
      environment: whatsappEnv,
    });
    this.whatsappInboundTopic.addSubscription(new subscriptions.LambdaSubscription(whatsappInbound));
    const whatsappDeliver = pelpFunction(this, 'WhatsAppDeliver', {
      functionName: `pelp-channel-whatsapp-deliver${pelp.suffix}`,
      entry: 'apps/channels/whatsapp/src/index.ts',
      handler: 'deliverHandler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: whatsappEnv,
    });
    // Enviar no expone recursos por ARN: es la acción sobre la cuenta vinculada.
    whatsappDeliver.addToRolePolicy(new iam.PolicyStatement({ actions: ['social-messaging:SendWhatsAppMessage'], resources: ['*'] }));
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

    for (const fn of [whatsappInbound, whatsappDeliver]) {
      data.inboundQueue.grantSendMessages(fn);
      data.table.grantReadWriteData(fn);
      data.identitySecret.grantRead(fn);
    }
    for (const fn of [discordInteractions, discordDeliver]) {
      data.inboundQueue.grantSendMessages(fn);
      data.table.grantReadWriteData(fn);
      data.identitySecret.grantRead(fn);
      data.discordSecret.grantRead(fn);
    }

    this.api = new apigateway.RestApi(this, 'ChannelsApi', {
      restApiName: `pelp-channels-api${pelp.suffix}`,
      description: 'Webhooks de canales (Discord). WhatsApp entra por SNS.',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: { stageName: pelp.envName, throttlingRateLimit: 50, throttlingBurstLimit: 100, metricsEnabled: true },
    });
    const channels = this.api.root.addResource('channels');
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

    new CfnOutput(this, 'WhatsAppInboundTopicArn', { value: this.whatsappInboundTopic.topicArn, description: 'Destino de eventos para la cuenta de WhatsApp en End User Messaging.' });
    new CfnOutput(this, 'DiscordInteractionsUrl', { value: `${this.api.url}channels/discord` });
  }
}
