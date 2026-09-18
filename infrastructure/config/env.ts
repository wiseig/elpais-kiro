import type { App } from 'aws-cdk-lib';

/**
 * Entornos (sección 15): dev y prod en la misma cuenta, separados por nombre y tags.
 * Cuenta y región únicas: el despliegue falla si no coinciden (patrón de Daily Brief).
 */
export type EnvName = 'dev' | 'prod';

export const ALLOWED_ACCOUNT = '178042202224';
export const ALLOWED_REGION = 'us-east-1';
export const APP_TAG = 'pregunta-elpais';

export interface PelpEnv {
  envName: EnvName;
  account: string;
  region: string;
  /** Sufijo de nombres de recursos: "" en prod, "-dev" en dev. */
  suffix: string;
  tableName: string;
  corpusBucketName: string;
  vectorBucketName: string;
  vectorIndexName: string;
  knowledgeBaseName: string;
  guardrailName: string;
  eventBusName: string;
  inboundQueueName: string;
  alertEmail?: string;
  /**
   * Id del número de origen de WhatsApp en End User Messaging. Existe recién después de vincular
   * la cuenta desde la consola; vacío, la entrega falla cerrado con un error claro. No es secreto.
   */
  whatsappOriginationPhoneNumberId?: string;
  allowedOrigin: string;
  termsUrl: string;
  /**
   * Revisión del data source de la Knowledge Base. Subirla fuerza a CloudFormation a crear uno
   * nuevo y borrar el viejo, o sea un recorrido completo del bucket. Es la salida cuando el
   * estado incremental de Bedrock queda trabado y deja de indexar archivos nuevos (pasó en dev
   * el 13/9/2026: 76 notas quedaron sin vectores y ningún recorrido las tomaba).
   */
  corpusRevision: number;
  /**
   * Paso intermedio del cambio de revisión: mantiene viva la revisión anterior para que las
   * pilas que la importan puedan migrar. Se apaga (`-c keepPreviousDataSource=false`) en el
   * segundo despliegue, que borra la vieja y sus vectores.
   */
  keepPreviousDataSource: boolean;
  /** Apaga schedules en dev (FinOps), como en Daily Brief: -c devShutdown=true. */
  devShutdown: boolean;
  removalPolicyRetain: boolean;
}

function context(app: App, key: string): string | undefined {
  const value = app.node.tryGetContext(key) as string | undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function loadEnv(app: App): PelpEnv {
  const envName = context(app, 'env') ?? process.env.PELP_ENV ?? 'dev';
  if (envName !== 'dev' && envName !== 'prod') throw new Error(`env debe ser dev o prod (recibido: ${envName}). Usá -c env=dev|prod`);
  const suffix = envName === 'prod' ? '' : `-${envName}`;
  const devShutdown = envName === 'dev' && ((context(app, 'devShutdown') ?? process.env.DEV_SHUTDOWN ?? '').toLowerCase() === 'true');
  return {
    envName,
    account: ALLOWED_ACCOUNT,
    region: ALLOWED_REGION,
    suffix,
    tableName: `pelp-main${suffix}`,
    corpusBucketName: `pelp-corpus-${ALLOWED_ACCOUNT}${suffix}`,
    vectorBucketName: `pelp-vectors-${ALLOWED_ACCOUNT}${suffix}`,
    vectorIndexName: 'notas',
    corpusRevision: envName === 'dev' ? 2 : 1,
    keepPreviousDataSource: (context(app, 'keepPreviousDataSource') ?? 'false').toLowerCase() === 'true',
    knowledgeBaseName: `pelp-kb${suffix}`,
    guardrailName: `pelp-guardrail${suffix}`,
    eventBusName: `pelp-events${suffix}`,
    inboundQueueName: `pelp-inbound${suffix}`,
    ...(context(app, 'alertEmail') ?? process.env.PELP_ALERT_EMAIL ? { alertEmail: context(app, 'alertEmail') ?? process.env.PELP_ALERT_EMAIL } : {}),
    ...(context(app, 'whatsappOriginationPhoneNumberId') ?? process.env.PELP_WHATSAPP_ORIGINATION_PHONE_NUMBER_ID
      ? { whatsappOriginationPhoneNumberId: context(app, 'whatsappOriginationPhoneNumberId') ?? process.env.PELP_WHATSAPP_ORIGINATION_PHONE_NUMBER_ID }
      : {}),
    allowedOrigin: context(app, 'allowedOrigin') ?? '*',
    termsUrl: context(app, 'termsUrl') ?? '/terminos',
    devShutdown,
    removalPolicyRetain: envName === 'prod',
  };
}

/** Guardrail duro: si el CLI resolvió cuenta/región y no son las permitidas, fallar antes de sintetizar. */
export function assertAccountRegion(): void {
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION;
  if (account && account !== ALLOWED_ACCOUNT) throw new Error(`Cuenta AWS no permitida: ${account}. Solo ${ALLOWED_ACCOUNT}.`);
  if (region && region !== ALLOWED_REGION) throw new Error(`Región AWS no permitida: ${region}. Solo ${ALLOWED_REGION}.`);
}
