import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

export interface PelpFunctionProps {
  functionName: string;
  entry: string;
  handler?: string;
  environment: Record<string, string>;
  timeout?: Duration;
  memorySize?: number;
  description?: string;
}

/** Lambda TypeScript en Node 22 arm64, bundle con esbuild (ADR 0001). Logs JSON 30 días. */
export function pelpFunction(scope: Construct, id: string, props: PelpFunctionProps): NodejsFunction {
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  return new NodejsFunction(scope, id, {
    functionName: props.functionName,
    entry: path.join(REPO_ROOT, props.entry),
    handler: props.handler ?? 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize ?? 1024,
    timeout: props.timeout ?? Duration.seconds(60),
    ...(props.description ? { description: props.description } : {}),
    logGroup,
    environment: { NODE_OPTIONS: '--enable-source-maps', ...props.environment },
    projectRoot: REPO_ROOT,
    depsLockFilePath: path.join(REPO_ROOT, 'pnpm-lock.yaml'),
    bundling: {
      target: 'node22',
      format: OutputFormat.CJS,
      minify: true,
      sourceMap: true,
      sourcesContent: false,
      bundleAwsSDK: true,
      externalModules: [],
      mainFields: ['module', 'main'],
    },
  });
}
