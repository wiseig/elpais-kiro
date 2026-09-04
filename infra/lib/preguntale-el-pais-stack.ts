import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class PreguntaleElPaisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const knowledgeBaseId = new cdk.CfnParameter(this, 'KnowledgeBaseId', {
      type: 'String',
      description: 'ID de la Bedrock Knowledge Base que indexa las notas de El Pais.',
      minLength: 1,
    });

    const modelArn = new cdk.CfnParameter(this, 'ModelArn', {
      type: 'String',
      description: 'ARN del modelo Claude compatible con RetrieveAndGenerate.',
      default: `arn:${this.partition}:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
    });

    const allowedOrigin = new cdk.CfnParameter(this, 'AllowedOrigin', {
      type: 'String',
      description: 'Origen autorizado por CORS. Para la demo puede ser *.',
      default: '*',
    });

    const askFunction = new nodejs.NodejsFunction(this, 'AskFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../../backend/ask.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBaseId.valueAsString,
        MODEL_ARN: modelArn.valueAsString,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        target: 'node20',
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        bundleAwsSDK: true,
      },
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      projectRoot: path.join(__dirname, '../..'),
    });

    const knowledgeBaseArn = cdk.Stack.of(this).formatArn({
      service: 'bedrock',
      resource: 'knowledge-base',
      resourceName: knowledgeBaseId.valueAsString,
    });

    askFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:RetrieveAndGenerate'],
        resources: [knowledgeBaseArn],
      }),
    );

    const httpApi = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'preguntale-el-pais',
      description: 'API del prototipo Preguntale a El Pais',
      corsPreflight: {
        allowOrigins: [allowedOrigin.valueAsString],
        allowHeaders: ['content-type'],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        maxAge: cdk.Duration.hours(1),
      },
    });

    httpApi.addRoutes({
      path: '/ask',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('AskIntegration', askFunction),
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'URL base para configurar VITE_API_URL.',
    });

    new cdk.CfnOutput(this, 'AskUrl', {
      value: `${httpApi.apiEndpoint}/ask`,
      description: 'Endpoint POST /ask.',
    });
  }
}
