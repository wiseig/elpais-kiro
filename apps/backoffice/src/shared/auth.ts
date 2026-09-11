/**
 * Autenticación contra el pool de Cognito de Daily Brief (grupo `admin`).
 * Flujo USER_PASSWORD_AUTH sin credenciales de AWS; refresh con REFRESH_TOKEN_AUTH.
 */
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  type InitiateAuthCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CognitoConfig } from './config';

export const AUTH_STORAGE_KEY = 'pelp.bo.auth';

/** Margen antes del vencimiento para renovar el token. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

export interface StoredAuth {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  /** Vencimiento del IdToken en epoch ms. */
  expiresAt: number;
}

export interface AuthUser {
  email: string;
  sub: string;
  groups: string[];
  isAdmin: boolean;
}

export type LoginResult = { kind: 'ok'; auth: StoredAuth } | { kind: 'challenge'; challenge: string };

export const CHALLENGE_MESSAGE =
  'Tu usuario tiene un desafío pendiente. Resolvelo una vez desde el backoffice de Daily Brief (app.dailybriefsolution.com) y volvé a ingresar.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredAuth(value: unknown): value is StoredAuth {
  return (
    isRecord(value) &&
    typeof value.idToken === 'string' &&
    typeof value.accessToken === 'string' &&
    typeof value.expiresAt === 'number' &&
    (value.refreshToken === undefined || typeof value.refreshToken === 'string')
  );
}

export function readStoredAuth(): StoredAuth | null {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredAuth(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredAuth(auth: StoredAuth): void {
  try {
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
  } catch {
    // sessionStorage no disponible: la sesión vive solo en memoria.
  }
}

export function clearStoredAuth(): void {
  try {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // ignorar
  }
}

/** Decodifica el payload de un JWT (base64url → JSON) sin verificar la firma. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function userFromIdToken(idToken: string): AuthUser | null {
  const claims = decodeJwtPayload(idToken);
  if (!claims) return null;
  const rawGroups = claims['cognito:groups'];
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string') : [];
  const email =
    typeof claims.email === 'string'
      ? claims.email
      : typeof claims['cognito:username'] === 'string'
        ? claims['cognito:username']
        : '';
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  return { email, sub, groups, isAdmin: groups.includes('admin') };
}

export function isExpiringSoon(auth: StoredAuth, marginMs = REFRESH_MARGIN_MS): boolean {
  return auth.expiresAt - Date.now() < marginMs;
}

function client(cfg: CognitoConfig): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region: cfg.region });
}

function toStoredAuth(out: InitiateAuthCommandOutput, previousRefresh?: string): StoredAuth | null {
  const result = out.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) return null;
  const claims = decodeJwtPayload(result.IdToken);
  const exp = claims && typeof claims.exp === 'number' ? claims.exp * 1000 : Date.now() + (result.ExpiresIn ?? 3600) * 1000;
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken ?? previousRefresh,
    expiresAt: exp,
  };
}

export async function loginWithPassword(cfg: CognitoConfig, email: string, password: string): Promise<LoginResult> {
  const out = await client(cfg).send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: cfg.clientId,
      AuthParameters: { USERNAME: email.trim(), PASSWORD: password },
    }),
  );
  if (out.ChallengeName) {
    return { kind: 'challenge', challenge: out.ChallengeName };
  }
  const auth = toStoredAuth(out);
  if (!auth) throw new Error('Cognito no devolvió tokens de sesión.');
  return { kind: 'ok', auth };
}

export async function refreshSession(cfg: CognitoConfig, refreshToken: string): Promise<StoredAuth> {
  const out = await client(cfg).send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: cfg.clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );
  const auth = toStoredAuth(out, refreshToken);
  if (!auth) throw new Error('No se pudo renovar la sesión.');
  return auth;
}

/** Traduce los errores más comunes de Cognito a un mensaje para el formulario. */
export function loginErrorMessage(error: unknown): string {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  switch (name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'Usuario o contraseña incorrectos.';
    case 'PasswordResetRequiredException':
    case 'UserNotConfirmedException':
      return CHALLENGE_MESSAGE;
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'Demasiados intentos. Esperá unos minutos y volvé a probar.';
    case 'InvalidParameterException':
      return `Cognito rechazó el pedido: ${message || 'parámetro inválido'}.`;
    case 'ResourceNotFoundException':
      return 'El cliente de Cognito configurado no existe. Revisá config.json.';
    default:
      return message || 'No se pudo iniciar sesión.';
  }
}
