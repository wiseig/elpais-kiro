import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getSecretJson } from '@pelp/engine/core';
import type { Article, DailyBriefArticle } from './corpus';
import { articleFromDailyBrief } from './corpus';

/**
 * Cliente de solo lectura de la API de Daily Brief (sección 5.1, 20).
 * Usuario de servicio en Secrets Manager: {"email", "password", "clientId"?}.
 */
export interface DailyBriefCredentials {
  email: string;
  password: string;
  clientId?: string;
}

export interface DailyBriefFetchFailure {
  articleId: string;
  error: string;
}

export class DailyBriefFetchError extends Error {
  constructor(readonly failures: DailyBriefFetchFailure[]) {
    super(`Falló el fetch de ${failures.length} nota(s) de Daily Brief: ${failures.map(({ articleId }) => articleId).join(', ')}`);
    this.name = 'DailyBriefFetchError';
  }
}

const API_URL = (process.env.DAILYBRIEF_API_URL ?? 'https://api.dailybriefsolution.com').replace(/\/$/, '');
const BACKOFFICE_URL = (process.env.DAILYBRIEF_BACKOFFICE_URL ?? 'https://app.dailybriefsolution.com').replace(/\/$/, '');
const USER_POOL_ID = process.env.DAILYBRIEF_USER_POOL_ID ?? 'us-east-1_PbNEhPTSl';

export class DailyBriefClient {
  private token?: string;

  constructor(
    private readonly credentials: DailyBriefCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static async fromSecret(): Promise<DailyBriefClient> {
    const arn = process.env.DAILYBRIEF_SECRET_ARN;
    if (!arn) throw new Error('Falta DAILYBRIEF_SECRET_ARN');
    const secret = await getSecretJson<Partial<DailyBriefCredentials>>(arn);
    if (!secret.email || !secret.password || secret.password.includes('PLACEHOLDER')) {
      throw new Error('El secreto del usuario de servicio de Daily Brief no está cargado (ver docs/runbook.md).');
    }
    return new DailyBriefClient({ email: secret.email, password: secret.password, ...(secret.clientId ? { clientId: secret.clientId } : {}) });
  }

  private async clientId(): Promise<string> {
    if (this.credentials.clientId) return this.credentials.clientId;
    const response = await this.fetchImpl(`${BACKOFFICE_URL}/config.json`);
    if (!response.ok) throw new Error(`config.json ${response.status}`);
    const config = (await response.json()) as { userPoolClientId?: string; userPoolId?: string };
    if (config.userPoolId && config.userPoolId !== USER_POOL_ID) {
      console.warn(JSON.stringify({ level: 'warn', message: 'dailybrief.pool_mismatch', expected: USER_POOL_ID, found: config.userPoolId }));
    }
    if (!config.userPoolClientId) throw new Error('config.json sin userPoolClientId');
    return config.userPoolClientId;
  }

  async login(): Promise<string> {
    if (this.token) return this.token;
    const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
    const output = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: await this.clientId(),
        AuthParameters: { USERNAME: this.credentials.email, PASSWORD: this.credentials.password },
      }),
    );
    if (output.ChallengeName) throw new Error(`Cognito pide ${output.ChallengeName} para el usuario de servicio; resolverlo una vez desde el backoffice de Daily Brief`);
    const access = output.AuthenticationResult?.AccessToken;
    const id = output.AuthenticationResult?.IdToken;
    for (const candidate of [access, id]) {
      if (!candidate) continue;
      const probe = await this.fetchImpl(`${API_URL}/v1/articles?date=${todayMontevideo()}`, { headers: { Authorization: `Bearer ${candidate}` } });
      if (probe.ok) {
        this.token = candidate;
        return candidate;
      }
    }
    throw new Error('La API de Daily Brief rechazó el token: el usuario de servicio debe estar en el grupo admin');
  }

  private async getJson<T>(path: string): Promise<T> {
    const token = await this.login();
    const response = await this.fetchImpl(`${API_URL}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return (await response.json()) as T;
  }

  /** Listado liviano del día (hasta 500, sin cuerpo). */
  async listByDate(day: string): Promise<DailyBriefArticle[]> {
    const output = await this.getJson<{ items?: DailyBriefArticle[] }>(`/v1/articles?date=${day}`);
    return output.items ?? [];
  }

  async getArticle(articleId: string): Promise<DailyBriefArticle> {
    return this.getJson<DailyBriefArticle>(`/v1/articles/${encodeURIComponent(articleId)}`);
  }

  /** Trae cuerpos con concurrencia acotada y nunca oculta fallos o respuestas inválidas. */
  async fetchFull(items: DailyBriefArticle[], day: string, origin: 'dailybrief-api' | 'backfill', concurrency = 5): Promise<Article[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('La concurrencia de Daily Brief debe ser un entero positivo');
    const out: Article[] = [];
    const failures: DailyBriefFetchFailure[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        if (!item) continue;
        try {
          const full = await this.getArticle(item.articleId);
          const article = articleFromDailyBrief(full, day, origin);
          if (!article) throw new Error('respuesta sin título, link o cuerpo');
          out.push(article);
        } catch (error) {
          const failure = { articleId: item.articleId, error: String(error) };
          failures.push(failure);
          console.error(JSON.stringify({ level: 'error', message: 'dailybrief.fetch_failed', ...failure }));
        }
      }
    });
    await Promise.all(workers);
    if (failures.length > 0) throw new DailyBriefFetchError(failures);
    return out;
  }
}

export function todayMontevideo(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function strictDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Fecha inválida: ${value}`);
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year!, month! - 1, day!);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`Fecha inválida: ${value}`);
  }
  return timestamp;
}

export function datesBetween(from: string, to: string): string[] {
  const start = strictDay(from);
  const end = strictDay(to);
  if (end < start) return [];
  const count = Math.floor((end - start) / 86_400_000) + 1;
  if (count > 400) throw new Error(`El rango de backfill excede el máximo de 400 días (${count})`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}
