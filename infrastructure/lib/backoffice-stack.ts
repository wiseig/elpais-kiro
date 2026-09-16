import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { PelpEnv } from '../config/env';
import type { DataStack } from './data-stack';
import { METRICS_NAMESPACE } from './engine-stack';
import type { JobsStack } from './jobs-stack';
import { pelpFunction } from './lambda';
import { SpaHosting } from './spa-hosting';

export interface BackofficeStackProps extends StackProps {
  pelp: PelpEnv;
  data: DataStack;
  jobs: JobsStack;
}

/** Grupo que habilita el backoffice. El authorizer de API Gateway solo comprueba el pool; el
 *  grupo lo exige la Lambda en `context.ts`. */
export const ADMIN_GROUP = 'admin';

/** pelp-backoffice: admin-api (JWT del pool propio, grupo admin) y la SPA. */
export class BackofficeStack extends Stack {
  readonly api: apigateway.RestApi;
  readonly hosting: SpaHosting;

  constructor(scope: Construct, id: string, props: BackofficeStackProps) {
    super(scope, id, props);
    const { pelp, data, jobs } = props;

    const adminApi = pelpFunction(this, 'AdminApi', {
      functionName: `pelp-admin-api${pelp.suffix}`,
      entry: 'apps/admin-api/src/handler.ts',
      description: 'Rutas /admin del backoffice.',
      timeout: Duration.seconds(29),
      memorySize: 1024,
      environment: {
        PELP_ENV: pelp.envName,
        SERVICE_NAME: 'pelp-admin',
        METRICS_NAMESPACE,
        TABLE_NAME: data.table.tableName,
        CORPUS_BUCKET: data.corpusBucket.bucketName,
        KNOWLEDGE_BASE_ID: data.knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: data.dataSource.attrDataSourceId,
        GUARDRAIL_ID: data.guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: data.guardrailVersion.attrVersion,
        NEWSROOM_TOPIC_ARN: data.newsroomTopic.topicArn,
        ALERTS_TOPIC_ARN: data.alertsTopic.topicArn,
        /* Sufijo de los nombres de alarma: el panel de Alertas arma `pelp-<alarma><sufijo>`. */
        ALARM_SUFFIX: pelp.suffix,
        ALLOWED_ORIGIN: pelp.allowedOrigin,
        JOB_SYNC_FUNCTION: jobs.functions.syncFeed?.functionName ?? '',
        JOB_BACKFILL_FUNCTION: jobs.functions.backfill?.functionName ?? '',
        JOB_EVALS_FUNCTION: jobs.functions.evals?.functionName ?? '',
        JOB_BIAS_FUNCTION: jobs.functions.biasReport?.functionName ?? '',
        JOB_PROFILER_FUNCTION: jobs.functions.profiler?.functionName ?? '',
        /* Mapas por clave de trabajo: el panel de trabajos lee y edita estas reglas. */
        JOB_RULES: JSON.stringify(Object.fromEntries(Object.entries(jobs.rules).map(([key, rule]) => [key, rule.ruleName]))),
        JOB_FUNCTIONS: JSON.stringify({
          'sync-feed': jobs.functions.syncFeed?.functionName ?? '',
          'ingestion-status': jobs.functions.ingestionStatus?.functionName ?? '',
          'reconcile-api': jobs.functions.reconcileApi?.functionName ?? '',
          'prune-corpus': jobs.functions.pruneCorpus?.functionName ?? '',
          profiler: jobs.functions.profiler?.functionName ?? '',
          evals: jobs.functions.evals?.functionName ?? '',
          'bias-report': jobs.functions.biasReport?.functionName ?? '',
          costs: jobs.functions.costs?.functionName ?? '',
        }),
      },
    });
    data.table.grantReadWriteData(adminApi);
    data.corpusBucket.grantReadWrite(adminApi);
    data.newsroomTopic.grantPublish(adminApi);
    adminApi.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs'], resources: [data.knowledgeBaseArn] }));
    for (const fn of Object.values(jobs.functions)) fn.grantInvoke(adminApi);
    // El panel de trabajos lee los horarios y puede cambiarlos o pausarlos.
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:DescribeRule', 'events:PutRule', 'events:EnableRule', 'events:DisableRule'],
        resources: [`arn:aws:events:${this.region}:${this.account}:rule/pelp-*`],
      }),
    );

    // El panel de alertas lee las alarmas, cambia sus umbrales y silencia el envío por correo.
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:DescribeAlarmHistory'],
        resources: ['*'],
      }),
    );
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricAlarm', 'cloudwatch:EnableAlarmActions', 'cloudwatch:DisableAlarmActions'],
        resources: [`arn:aws:cloudwatch:${this.region}:${this.account}:alarm:pelp-*`],
      }),
    );

    // Pool propio: el backoffice de Daily Brief es de solo lectura para nosotros, así que las
    // cuentas de esta herramienta viven acá y se administran desde la pantalla de Usuarios.
    const userPool = new cognito.UserPool(this, 'AdminPool', {
      userPoolName: `pelp-backoffice${pelp.suffix}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userInvitation: {
        emailSubject: 'Tu acceso al backoffice de Preguntale a El País',
        emailBody:
          'Hola: te dieron acceso al backoffice de Preguntale a El País.<br><br>Usuario: <strong>{username}</strong><br>' +
          'Contraseña temporal: <strong>{####}</strong><br><br>La primera vez que entres te va a pedir una nueva.',
      },
      removalPolicy: pelp.removalPolicyRetain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: 'Acceso completo al backoffice de Preguntale a El País.',
    });
    const userPoolClient = userPool.addClient('Backoffice', {
      userPoolClientName: `pelp-backoffice${pelp.suffix}`,
      // El front habla directo con Cognito con usuario y contraseña; no hay secreto de cliente.
      authFlows: { userPassword: true, userSrp: false },
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(7),
      preventUserExistenceErrors: true,
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      authorizerName: `pelp-admin-cognito${pelp.suffix}`,
      cognitoUserPools: [userPool],
      resultsCacheTtl: Duration.minutes(5),
    });

    // Alta, baja y reseteo de cuentas del backoffice, solo sobre este pool.
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:ListUsersInGroup',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminResetUserPassword',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    adminApi.addEnvironment('USER_POOL_ID', userPool.userPoolId);
    adminApi.addEnvironment('ADMIN_GROUP', ADMIN_GROUP);

    // Listas de correo: quién recibe el resumen de la redacción y quién las alarmas.
    adminApi.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:ListSubscriptionsByTopic', 'sns:Subscribe', 'sns:Unsubscribe', 'sns:GetTopicAttributes'],
        resources: [data.newsroomTopic.topicArn, data.alertsTopic.topicArn],
      }),
    );

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `pelp-admin-api${pelp.suffix}`,
      description: 'API del backoffice (/admin).',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: { stageName: pelp.envName, throttlingRateLimit: 20, throttlingBurstLimit: 50, metricsEnabled: true },
      defaultCorsPreflightOptions: {
        allowOrigins: pelp.allowedOrigin === '*' ? apigateway.Cors.ALL_ORIGINS : [pelp.allowedOrigin],
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        maxAge: Duration.hours(1),
      },
    });
    const admin = this.api.root.addResource('admin');
    admin.addProxy({
      defaultIntegration: new apigateway.LambdaIntegration(adminApi, { proxy: true, timeout: Duration.seconds(29) }),
      anyMethod: true,
      defaultMethodOptions: { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
    });

    // El stage sirve una foto del API: cambiar el authorizer no basta, hay que volver a
    // desplegar. CDK no lo nota solo (el hash del Deployment no mira al authorizer), así que
    // metemos el pool en ese hash. Sin esto, un cambio de pool deja a todos afuera con 401.
    this.api.latestDeployment?.addToLogicalId({ authorizerPool: userPool.userPoolArn });

    new wafv2.CfnWebACLAssociation(this, 'AdminWaf', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`,
      webAclArn: data.webAclAdmin.attrArn,
    });

    this.hosting = new SpaHosting(this, 'Backoffice', {
      distDir: 'apps/backoffice/dist',
      configJson: {
        apiBaseUrl: '',
        env: pelp.envName,
        cognito: { userPoolId: userPool.userPoolId, clientId: userPoolClient.userPoolClientId, region: this.region },
      },
      apiRoutes: [{ pathPattern: '/admin/*', api: this.api }],
      webAclArn: data.webAclCloudFrontAdmin.attrArn,
      comment: `Preguntale a El País — backoffice (${pelp.envName})`,
    });

    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'AdminApiUrl', { value: this.api.url });
    new CfnOutput(this, 'BackofficeUrl', { value: `https://${this.hosting.distribution.distributionDomainName}` });
  }
}
