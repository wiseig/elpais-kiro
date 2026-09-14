/**
 * Autenticación contra el pool de Cognito propio del backoffice (grupo `admin`).
 * Flujo USER_PASSWORD_AUTH sin credenciales de AWS; refresh con REFRESH_TOKEN_AUTH.
 */
import {
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
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

export type LoginResult =
  | { kind: 'ok'; auth: StoredAuth }
  | { kind: 'challenge'; challenge: string; session?: string; email: string };

export const NEW_PASSWORD_CHALLENGE = 'NEW_PASSWORD_REQUIRED';
export const PASSWORD_POLICY_MESSAGE = 'Mínimo 8 caracteres, con mayúscula, minúscula, número y símbolo.';

export const CHALLENGE_MESSAGE =
  'Tu usuario tiene un desafío pendiente que no se puede resolver desde acá. Pedí un reseteo de contraseña en la pantalla de Usuarios y volvé a entrar con el código que te llega por mail.';

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
    return { kind: 'challenge', challenge: out.ChallengeName, ...(out.Session ? { session: out.Session } : {}), email: email.trim() };
  }
  const auth = toStoredAuth(out);
  if (!auth) throw new Error('Cognito no devolvió tokens de sesión.');
  return { kind: 'ok', auth };
}

/** Primer ingreso con clave temporal: el usuario elige su contraseña definitiva (NEW_PASSWORD_REQUIRED). */
export async function completeNewPassword(cfg: CognitoConfig, email: string, session: string, newPassword: string): Promise<StoredAuth> {
  const out = await client(cfg).send(
    new RespondToAuthChallengeCommand({
      ClientId: cfg.clientId,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: email.trim(), NEW_PASSWORD: newPassword },
    }),
  );
  if (out.ChallengeName) throw new Error(`Cognito pide otro desafío (${out.ChallengeName}). ${CHALLENGE_MESSAGE}`);
  const auth = toStoredAuth(out);
  if (!auth) throw new Error('Cognito no devolvió tokens de sesión.');
  return auth;
}

/**
 * Cambio de contraseña del propio usuario (Cognito `ChangePassword`): pide la actual y no
 * toca la sesión, así que el lector sigue trabajando sin volver a entrar.
 */
export async function changePassword(cfg: CognitoConfig, accessToken: string, previous: string, proposed: string): Promise<void> {
  await client(cfg).send(
    new ChangePasswordCommand({ AccessToken: accessToken, PreviousPassword: previous, ProposedPassword: proposed }),
  );
}

/**
 * Recuperación sin sesión (Cognito `ForgotPassword`): manda un código al mail verificado del
 * usuario. Devuelve el destino enmascarado que arma Cognito, para mostrarlo en el formulario.
 */
export async function startPasswordReset(cfg: CognitoConfig, email: string): Promise<{ destination?: string }> {
  const out = await client(cfg).send(new ForgotPasswordCommand({ ClientId: cfg.clientId, Username: email.trim() }));
  const destination = out.CodeDeliveryDetails?.Destination;
  return destination ? { destination } : {};
}

/** Cierra la recuperación con el código del mail y la contraseña nueva. */
export async function confirmPasswordReset(cfg: CognitoConfig, email: string, code: string, newPassword: string): Promise<void> {
  await client(cfg).send(
    new ConfirmForgotPasswordCommand({
      ClientId: cfg.clientId,
      Username: email.trim(),
      ConfirmationCode: code.trim(),
      Password: newPassword,
    }),
  );
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

/** Requisitos del pool, chequeados antes de mandar el pedido para dar un mensaje concreto. */
export function passwordPolicyProblem(password: string): string | null {
  if (password.length < 8) return 'Tiene que tener al menos 8 caracteres.';
  if (!/[A-ZÁÉÍÓÚÑ]/.test(password)) return 'Falta una mayúscula.';
  if (!/[a-záéíóúñ]/.test(password)) return 'Falta una minúscula.';
  if (!/\d/.test(password)) return 'Falta un número.';
  if (!/[^\w\s]|_/.test(password)) return 'Falta un símbolo.';
  return null;
}

/** Errores de la recuperación por código. */
export function resetPasswordErrorMessage(error: unknown): string {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  switch (name) {
    // Un usuario inexistente da el mismo mensaje que un código equivocado: no se delata quién existe.
    case 'CodeMismatchException':
    case 'UserNotFoundException':
      return 'El código no coincide. Revisá el mail y volvé a escribirlo.';
    case 'ExpiredCodeException':
      return 'El código venció. Pedí uno nuevo.';
    case 'InvalidPasswordException':
      return `La contraseña nueva no cumple la política. ${PASSWORD_POLICY_MESSAGE}`;
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return 'Demasiados intentos. Esperá unos minutos y volvé a probar.';
    case 'InvalidParameterException':
      return 'Tu usuario no tiene un mail verificado en Cognito, así que no se puede mandar el código. Pedile a alguien con acceso a la cuenta de AWS que lo verifique.';
    case 'NotAuthorizedException':
      return 'Cognito no permite recuperar esta cuenta en su estado actual. Pedile a alguien con acceso a la cuenta de AWS que te asigne una contraseña.';
    default:
      return loginErrorMessage(error);
  }
}

/** Errores del cambio de contraseña: el "no autorizado" de acá es la contraseña actual. */
export function changePasswordErrorMessage(error: unknown): string {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  if (name === 'NotAuthorizedException') return 'La contraseña actual no es correcta.';
  if (name === 'InvalidPasswordException') return `La contraseña nueva no cumple la política. ${PASSWORD_POLICY_MESSAGE}`;
  if (name === 'LimitExceededException' || name === 'TooManyRequestsException') {
    return 'Demasiados intentos. Esperá unos minutos y volvé a probar.';
  }
  return loginErrorMessage(error);
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
    case 'InvalidPasswordException':
      return `La contraseña no cumple la política. ${PASSWORD_POLICY_MESSAGE}`;
    case 'ExpiredCodeException':
    case 'CodeMismatchException':
      return 'La sesión del desafío venció. Volvé a ingresar con la clave temporal.';
    case 'InvalidParameterException':
      return `Cognito rechazó el pedido: ${message || 'parámetro inválido'}.`;
    case 'ResourceNotFoundException':
      return 'El cliente de Cognito configurado no existe. Revisá config.json.';
    default:
      return message || 'No se pudo iniciar sesión.';
  }
}
