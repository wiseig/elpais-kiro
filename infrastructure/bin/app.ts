#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { APP_TAG, assertAccountRegion, loadEnv } from '../config/env';
import { BackofficeStack } from '../lib/backoffice-stack';
import { ChannelsStack } from '../lib/channels-stack';
import { DataStack } from '../lib/data-stack';
import { EngineStack } from '../lib/engine-stack';
import { JobsStack } from '../lib/jobs-stack';

/**
 * Preguntale a El País — stacks pelp-* (spec v2, sección 15).
 * Uso: cdk synth -c env=dev | cdk deploy -c env=prod --all
 */
export function buildApp(app = new App()): { app: App; stacks: Record<string, unknown> } {
  const pelp = loadEnv(app);
  assertAccountRegion();
  const env = { account: pelp.account, region: pelp.region };
  const description = (what: string) => `Preguntale a El País (${pelp.envName}): ${what}`;

  const data = new DataStack(app, `pelp-data-${pelp.envName}`, { env, pelp, description: description('datos, corpus, Knowledge Base, guardrail, secretos') });
  const engine = new EngineStack(app, `pelp-engine-${pelp.envName}`, { env, pelp, data, description: description('motor, API pública y chat web') });
  const jobs = new JobsStack(app, `pelp-jobs-${pelp.envName}`, { env, pelp, data, apiName: `pelp-api${pelp.suffix}`, description: description('jobs, alarmas y dashboard') });
  const channels = new ChannelsStack(app, `pelp-channels-${pelp.envName}`, { env, pelp, data, description: description('adaptadores WhatsApp y Discord') });
  const backoffice = new BackofficeStack(app, `pelp-backoffice-${pelp.envName}`, { env, pelp, data, jobs, description: description('admin-api y backoffice') });

  Tags.of(app).add('app', APP_TAG);
  Tags.of(app).add('env', pelp.envName);
  return { app, stacks: { data, engine, jobs, channels, backoffice } };
}

buildApp();
