import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const cache = new Map<string, { value: string; at: number }>();
const TTL_MS = 10 * 60 * 1000;
let client: SecretsManagerClient | undefined;

export async function getSecretString(arnOrName: string): Promise<string> {
  const cached = cache.get(arnOrName);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  client ??= new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const output = await client.send(new GetSecretValueCommand({ SecretId: arnOrName }));
  const value = output.SecretString ?? (output.SecretBinary ? Buffer.from(output.SecretBinary).toString('utf8') : '');
  cache.set(arnOrName, { value, at: Date.now() });
  return value;
}

export async function getSecretJson<T extends Record<string, unknown>>(arnOrName: string): Promise<T> {
  const raw = await getSecretString(arnOrName);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`El secreto ${arnOrName} no contiene JSON válido`);
  }
}

/**
 * Secreto HMAC de identidades y sesiones. En Lambda viene de Secrets Manager
 * (IDENTITY_SECRET_ARN); en tests/local se acepta PELP_IDENTITY_SECRET en claro.
 */
export async function identitySecret(): Promise<string> {
  const local = process.env.PELP_IDENTITY_SECRET;
  if (local) return local;
  const arn = process.env.IDENTITY_SECRET_ARN;
  if (!arn) throw new Error('Falta IDENTITY_SECRET_ARN');
  const raw = await getSecretString(arn);
  try {
    const parsed = JSON.parse(raw) as { secret?: string };
    return parsed.secret ?? raw;
  } catch {
    return raw;
  }
}

export function resetSecretCache(): void {
  cache.clear();
}
