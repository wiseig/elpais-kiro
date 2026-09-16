import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { PelpEnv } from '../config/env';
import { pelpFunction } from './lambda';

export interface DataStackProps extends StackProps {
  pelp: PelpEnv;
}

/**
 * pelp-data: tabla única, corpus en S3, S3 Vectors + Knowledge Base, Guardrail,
 * secretos, colas, bus de eventos, tópicos y WebACLs. Nada con costo por hora (principio 2.3).
 */
export class DataStack extends Stack {
  readonly table: dynamodb.Table;
  readonly corpusBucket: s3.Bucket;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;
  readonly guardrail: bedrock.CfnGuardrail;
  readonly guardrailVersion: bedrock.CfnGuardrailVersion;
  readonly identitySecret: secretsmanager.Secret;
  readonly feedSecret: secretsmanager.Secret;
  readonly dailyBriefSecret: secretsmanager.Secret;
  readonly whatsappSecret: secretsmanager.Secret;
  readonly discordSecret: secretsmanager.Secret;
  readonly inboundQueue: sqs.Queue;
  readonly eventBus: events.EventBus;
  readonly alertsTopic: sns.Topic;
  /** Tema interno donde publican las alarmas antes de traducirse. */
  readonly alarmsTopic: sns.Topic;
  readonly newsroomTopic: sns.Topic;
  readonly webAclRegional: wafv2.CfnWebACL;
  /** ACL del backoffice: igual a la regional pero sin el tope de 8 KB en el cuerpo. */
  readonly webAclAdmin: wafv2.CfnWebACL;
  readonly webAclCloudFront: wafv2.CfnWebACL;
  /** ACL de la distribución del backoffice: sin el tope de 8 KB en el cuerpo. */
  readonly webAclCloudFrontAdmin: wafv2.CfnWebACL;
  readonly knowledgeBaseArn: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { pelp } = props;
    const retain = pelp.removalPolicyRetain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    /* ------------------------------ DynamoDB ------------------------------ */
    this.table = new dynamodb.Table(this, 'Main', {
      tableName: pelp.tableName,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: retain,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /* -------------------------------- Corpus -------------------------------- */
    this.corpusBucket = new s3.Bucket(this, 'Corpus', {
      bucketName: pelp.corpusBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: retain,
      autoDeleteObjects: !pelp.removalPolicyRetain,
    });

    /* ----------------------------- S3 Vectors + KB ----------------------------- */
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: pelp.vectorBucketName,
    });
    /**
     * S3 Vectors limita a ~1 KB la metadata filtrable por vector y descarta el documento en
     * silencio al pasarse (13/9/2026: 80 notas sin indexar). Ampliar la lista de claves no
     * filtrables obliga a recrear el índice y la Knowledge Base, así que el límite se respeta
     * del otro lado: `toMetadata` (apps/jobs) manda solo lo que la búsqueda necesita.
     */
    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: pelp.vectorBucketName,
      indexName: pelp.vectorIndexName,
      dataType: 'float32',
      dimension: 1024,
      distanceMetric: 'cosine',
      metadataConfiguration: { nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
    });
    vectorIndex.node.addDependency(vectorBucket);

    const embeddingModelArn = `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`;
    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      roleName: `pelp-kb-role${pelp.suffix}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    });
    kbRole.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embeddingModelArn] }));
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [this.corpusBucket.bucketArn, this.corpusBucket.arnForObjects('*')],
        conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
      }),
    );
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:GetIndex', 's3vectors:QueryVectors', 's3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors', 's3vectors:ListVectors'],
        resources: [vectorIndex.attrIndexArn, vectorBucket.attrVectorBucketArn],
      }),
    );

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: pelp.knowledgeBaseName,
      description: 'Notas publicadas por El País (Uruguay). Corpus en S3 con sidecars de metadata.',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: { bedrockEmbeddingModelConfiguration: { dimensions: 1024, embeddingDataType: 'FLOAT32' } },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: { indexArn: vectorIndex.attrIndexArn },
      },
    });
    this.knowledgeBase.node.addDependency(kbRole);
    this.knowledgeBase.node.addDependency(vectorIndex);
    this.knowledgeBaseArn = this.knowledgeBase.attrKnowledgeBaseArn;

    /**
     * Data source del corpus. `corpusRevision` (config/env.ts) permite crear uno nuevo y
     * abandonar el anterior cuando el estado incremental de Bedrock queda trabado y deja de
     * indexar archivos. El cambio va en dos pasos para no romper los exports entre pilas:
     * primero se despliega con `keepPreviousDataSource` en true (conviven las dos y los
     * consumidores pasan a la nueva) y después en false, que borra la vieja y sus vectores.
     */
    const corpusDataSource = (revision: number) =>
      new bedrock.CfnDataSource(this, revision > 1 ? `CorpusDataSourceV${revision}` : 'CorpusDataSource', {
        name: revision > 1 ? `pelp-corpus${pelp.suffix}-v${revision}` : `pelp-corpus${pelp.suffix}`,
        knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
        dataDeletionPolicy: 'DELETE',
        dataSourceConfiguration: {
          type: 'S3',
          s3Configuration: { bucketArn: this.corpusBucket.bucketArn, inclusionPrefixes: ['notas/'] },
        },
        vectorIngestionConfiguration: {
          chunkingConfiguration: {
            chunkingStrategy: 'FIXED_SIZE',
            fixedSizeChunkingConfiguration: { maxTokens: 300, overlapPercentage: 20 },
          },
        },
      });

    if (pelp.keepPreviousDataSource && pelp.corpusRevision > 1) {
      const previous = corpusDataSource(pelp.corpusRevision - 1);
      // El export de la revisión vieja se mantiene a mano mientras las otras pilas siguen
      // importándolo: si desaparece antes de que migren, CloudFormation cancela el cambio.
      this.exportValue(previous.attrDataSourceId, { name: `${this.stackName}:ExportsOutputFnGetAttCorpusDataSourceDataSourceId9C7C2DD0` });
    }
    this.dataSource = corpusDataSource(pelp.corpusRevision);

    /* ------------------------------- Guardrail ------------------------------- */
    this.guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: pelp.guardrailName,
      description: 'Entrada: prompt attack, PII, temas vedados. Salida: contenido y grounding contextual.',
      blockedInputMessaging: 'Sobre esto no puedo ayudarte. Podés leer la cobertura de El País en elpais.com.uy.',
      blockedOutputsMessaging: 'No puedo ofrecer una respuesta segura y respaldada por las notas de El País.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'HATE', inputStrength: 'LOW', outputStrength: 'LOW' },
          { type: 'INSULTS', inputStrength: 'LOW', outputStrength: 'LOW' },
          { type: 'SEXUAL', inputStrength: 'NONE', outputStrength: 'NONE' },
          { type: 'VIOLENCE', inputStrength: 'LOW', outputStrength: 'LOW' },
          { type: 'MISCONDUCT', inputStrength: 'LOW', outputStrength: 'LOW' },
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      contextualGroundingPolicyConfig: {
        filtersConfig: [
          { type: 'GROUNDING', threshold: 0.7 },
          { type: 'RELEVANCE', threshold: 0.5 },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'EMAIL', action: 'ANONYMIZE' },
        ],
        regexesConfig: [
          {
            name: 'cedula-uruguaya',
            description: 'Cédula de identidad uruguaya (1.234.567-8 y variantes).',
            pattern: '\\b\\d\\.?\\d{3}\\.?\\d{3}-?\\d\\b',
            action: 'ANONYMIZE',
          },
        ],
      },
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: 'apuestas',
            type: 'DENY',
            definition: 'Pedidos de consejos, pronósticos o estrategias para apostar o jugar por dinero.',
            examples: ['¿A qué le apuesto en el clásico?', 'Dame una cuota segura para hoy', '¿Cómo gano en la ruleta online?'],
          },
          {
            name: 'diagnostico-medico-personal',
            type: 'DENY',
            definition: 'Pedidos de diagnóstico, tratamiento o dosis para la situación de salud personal de quien pregunta.',
            examples: ['Tengo fiebre y dolor de cabeza, ¿qué tomo?', '¿Puedo mezclar ibuprofeno con mi remedio?', '¿Qué tengo si me duele el pecho?'],
          },
          {
            name: 'asesoria-legal-financiera-personal',
            type: 'DENY',
            definition: 'Pedidos de asesoramiento legal o financiero para el caso personal de quien pregunta.',
            examples: ['¿Conviene que ponga mis ahorros en dólares hoy?', '¿Cómo hago para no pagar la multa que me llegó?', '¿Me conviene demandar a mi empleador?'],
          },
        ],
      },
    });
    this.guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: this.guardrail.attrGuardrailId,
      description: 'v1: política editorial de Preguntale a El País',
    });

    /* -------------------------------- Secretos -------------------------------- */
    this.identitySecret = new secretsmanager.Secret(this, 'IdentitySecret', {
      secretName: `pelp/${pelp.envName}/identity-hmac`,
      description: 'HMAC de identidades de canal y firma de sesiones web. Generado; no rotar sin invalidar sesiones.',
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'secret', passwordLength: 48, excludePunctuation: true },
      removalPolicy: retain,
    });
    const placeholder = (idSuffix: string, name: string, description: string, template: Record<string, string>) =>
      new secretsmanager.Secret(this, idSuffix, {
        secretName: `pelp/${pelp.envName}/${name}`,
        description: `${description} Lo carga una persona (ver docs/runbook.md); el valor inicial es una plantilla.`,
        secretStringValue: SecretValue.unsafePlainText(JSON.stringify(template)),
        removalPolicy: retain,
      });
    this.feedSecret = placeholder('FeedSecret', 'feed', 'URL completa del feed de El País (con token).', { url: 'PLACEHOLDER' });
    this.dailyBriefSecret = placeholder('DailyBriefSecret', 'dailybrief-service-user', 'Usuario de servicio (grupo admin) de la API de Daily Brief.', {
      email: 'pelp-service@elpais.com.uy',
      password: 'PLACEHOLDER',
      clientId: '',
    });
    this.whatsappSecret = placeholder('WhatsAppSecret', 'channels/whatsapp', 'Meta Cloud API.', { appSecret: 'PLACEHOLDER', verifyToken: 'PLACEHOLDER', token: 'PLACEHOLDER', phoneNumberId: '' });
    this.discordSecret = placeholder('DiscordSecret', 'channels/discord', 'Discord interactions.', { publicKey: 'PLACEHOLDER', applicationId: '' });

    /* ------------------------- Cola, bus y tópicos ------------------------- */
    const deadLetter = new sqs.Queue(this, 'InboundDlq', { queueName: `${pelp.inboundQueueName}-dlq`, retentionPeriod: Duration.days(14), enforceSSL: true });
    this.inboundQueue = new sqs.Queue(this, 'Inbound', {
      queueName: pelp.inboundQueueName,
      visibilityTimeout: Duration.seconds(360),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetter, maxReceiveCount: 3 },
    });
    this.eventBus = new events.EventBus(this, 'Events', { eventBusName: pelp.eventBusName });
    this.alertsTopic = new sns.Topic(this, 'Alerts', { topicName: `pelp-alerts${pelp.suffix}`, displayName: 'Preguntale a El País — alarmas' });
    if (pelp.alertEmail) this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(pelp.alertEmail));

    // Las alarmas no escriben directo al tema que lee la gente: pasan por uno interno y una Lambda
    // las traduce a castellano y a hora de Montevideo. Así nadie tiene que cambiar su suscripción.
    this.alarmsTopic = new sns.Topic(this, 'AlarmsRaw', { topicName: `pelp-alarms-raw${pelp.suffix}`, displayName: 'Alarmas sin formatear' });
    const alertMail = pelpFunction(this, 'AlertMail', {
      functionName: `pelp-alert-mail${pelp.suffix}`,
      entry: 'apps/jobs/src/alert-mail.ts',
      description: 'Reescribe el aviso de CloudWatch en castellano y hora de Montevideo.',
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: { ALERTS_TOPIC_ARN: this.alertsTopic.topicArn, SERVICE_NAME: 'pelp-alert-mail', PELP_ENV: pelp.envName },
    });
    this.alertsTopic.grantPublish(alertMail);
    this.alarmsTopic.addSubscription(new subscriptions.LambdaSubscription(alertMail));
    this.newsroomTopic = new sns.Topic(this, 'Newsroom', { topicName: `pelp-newsroom${pelp.suffix}`, displayName: 'Preguntale a El País — redacción' });

    /* --------------------------------- WAF --------------------------------- */
    const managed = (name: string, priority: number, countRules: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ...(countRules.length ? { ruleActionOverrides: countRules.map((rule) => ({ name: rule, actionToUse: { count: {} } })) } : {}),
        },
      },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
    });
    const rateRule = (name: string, priority: number, limit: number, windowSec: number, uriContains?: string): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      action: { block: { customResponse: { responseCode: 429 } } },
      statement: {
        rateBasedStatement: {
          limit,
          evaluationWindowSec: windowSec,
          aggregateKeyType: 'IP',
          ...(uriContains
            ? {
                scopeDownStatement: {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'CONTAINS',
                    searchString: uriContains,
                    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                  },
                },
              }
            : {}),
        },
      },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
    });
    this.webAclRegional = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
      name: `pelp-api${pelp.suffix}`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: `pelp-api${pelp.suffix}` },
      rules: [
        managed('AWSManagedRulesCommonRuleSet', 0),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 1),
        rateRule('rate-ask-per-ip', 2, 10, 60, '/v1/ask'),
        rateRule('rate-api-per-ip', 3, 300, 60),
      ],
    });
    /**
     * El backoffice manda la configuración entera en el cuerpo del PUT, y `SizeRestrictions_BODY`
     * del conjunto común de AWS bloquea todo cuerpo de más de 8 KB. La configuración pasó los
     * 9,7 KB y el 16/9/2026 dejó de poder guardarse: medido contra la API, 8.074 bytes daban 401
     * (llegaba al autorizador) y 8.274 daban 403 (lo frenaba el WAF), con el cuerpo lleno de
     * letras, así que era el tamaño y no el contenido. API Gateway regional no deja inspeccionar
     * más de 8 KB, así que la única salida es contar esa regla en vez de bloquear.
     *
     * Va en una ACL propia y no en la de la API pública: acá detrás hay un autorizador de Cognito
     * con grupo admin y el cuerpo legítimo es un documento que va a seguir creciendo; en `/v1/ask`,
     * que es abierto, el tope de 8 KB sigue siendo una protección que queremos.
     */
    this.webAclAdmin = new wafv2.CfnWebACL(this, 'AdminWebAcl', {
      name: `pelp-admin${pelp.suffix}`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: `pelp-admin${pelp.suffix}` },
      rules: [
        managed('AWSManagedRulesCommonRuleSet', 0, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 1),
        rateRule('rate-admin-per-ip', 2, 300, 60),
      ],
    });

    /**
     * La misma excepción que `webAclAdmin`, pero del lado de CloudFront: el backoffice no habla
     * con la API directo sino a través de su distribución (`apiBaseUrl` vacío, ruta /admin/*), así
     * que el cuerpo del PUT pasa por las dos ACL y arreglar solo la regional no alcanzaba.
     *
     * Y acá el bloqueo era peor que un error: el SPA mapea 403 → 200 /index.html para que anden
     * los enlaces profundos, así que un rechazo del WAF le llegaba al navegador como un 200 con
     * HTML. El backoffice lo guardaba como si fuera la configuración y la pantalla moría (16/9/2026).
     */
    this.webAclCloudFrontAdmin = new wafv2.CfnWebACL(this, 'AdminWebWebAcl', {
      name: `pelp-web-admin${pelp.suffix}`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: `pelp-web-admin${pelp.suffix}` },
      rules: [
        managed('AWSManagedRulesCommonRuleSet', 0, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 1),
        rateRule('rate-web-admin-per-ip', 2, 600, 300),
      ],
    });

    this.webAclCloudFront = new wafv2.CfnWebACL(this, 'WebWebAcl', {
      name: `pelp-web${pelp.suffix}`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: `pelp-web${pelp.suffix}` },
      rules: [managed('AWSManagedRulesCommonRuleSet', 0), managed('AWSManagedRulesKnownBadInputsRuleSet', 1), rateRule('rate-web-per-ip', 2, 600, 300)],
    });

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'CorpusBucketName', { value: this.corpusBucket.bucketName });
    new CfnOutput(this, 'KnowledgeBaseId', { value: this.knowledgeBase.attrKnowledgeBaseId });
    new CfnOutput(this, 'DataSourceId', { value: this.dataSource.attrDataSourceId });
    new CfnOutput(this, 'GuardrailId', { value: this.guardrail.attrGuardrailId });
    new CfnOutput(this, 'GuardrailVersionNumber', { value: this.guardrailVersion.attrVersion });
    new CfnOutput(this, 'InboundQueueUrl', { value: this.inboundQueue.queueUrl });
    new CfnOutput(this, 'EventBusName', { value: this.eventBus.eventBusName });
    new CfnOutput(this, 'AlertsTopicArn', { value: this.alertsTopic.topicArn });
    new CfnOutput(this, 'AlarmsTopicArn', { value: this.alarmsTopic.topicArn });
    new CfnOutput(this, 'FeedSecretArn', { value: this.feedSecret.secretArn });
    new CfnOutput(this, 'DailyBriefSecretArn', { value: this.dailyBriefSecret.secretArn });
  }
}
