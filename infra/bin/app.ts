#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PreguntaleElPaisStack } from '../lib/preguntale-el-pais-stack';

const app = new cdk.App();

new PreguntaleElPaisStack(app, 'PreguntaleElPaisStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Prototipo Preguntale a El Pais: API RAG con Bedrock Knowledge Bases',
});
