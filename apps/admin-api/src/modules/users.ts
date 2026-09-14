import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminListGroupsForUserCommand,
  AdminResetUserPasswordCommand,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AdminUser, UsersResponse } from '@pelp/domain/api';
import { HttpError, audit, type AdminContext } from '../context';

/** Pool propio del backoffice. Sin él la pantalla de usuarios no tiene contra qué trabajar. */
function pool(ctx: AdminContext): string {
  const id = ctx.env.USER_POOL_ID;
  if (!id) throw new HttpError(501, 'No hay un pool de usuarios configurado (USER_POOL_ID).', 'not_configured');
  return id;
}

function adminGroup(ctx: AdminContext): string {
  return ctx.env.ADMIN_GROUP || 'admin';
}

function attribute(user: UserType, name: string): string | undefined {
  return user.Attributes?.find((item) => item.Name === name)?.Value;
}

/** El correo es el identificador que ve la redacción; el username puede ser un UUID. */
function emailOf(user: UserType): string {
  return attribute(user, 'email') ?? user.Username ?? '';
}

const STATUS_TEXT: Record<string, AdminUser['status']> = {
  CONFIRMED: 'activo',
  FORCE_CHANGE_PASSWORD: 'invitado',
  RESET_REQUIRED: 'debe_resetear',
  UNCONFIRMED: 'sin_confirmar',
};

function toAdminUser(user: UserType, groups: string[]): AdminUser {
  return {
    username: user.Username ?? '',
    email: emailOf(user),
    status: STATUS_TEXT[user.UserStatus ?? ''] ?? 'otro',
    rawStatus: user.UserStatus ?? '',
    enabled: user.Enabled !== false,
    groups,
    ...(user.UserCreateDate ? { createdAt: user.UserCreateDate.toISOString() } : {}),
    ...(user.UserLastModifiedDate ? { updatedAt: user.UserLastModifiedDate.toISOString() } : {}),
  };
}

export async function listUsers(ctx: AdminContext): Promise<UsersResponse> {
  const UserPoolId = pool(ctx);
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.cognito.send(new ListUsersCommand({ UserPoolId, Limit: 60, ...(token ? { PaginationToken: token } : {}) }));
    users.push(...(page.Users ?? []));
    token = page.PaginationToken;
  } while (token && users.length < 300);

  const items = await Promise.all(
    users.map(async (user) => {
      const groups = await ctx.cognito
        .send(new AdminListGroupsForUserCommand({ UserPoolId, Username: user.Username ?? '' }))
        .then((result) => (result.Groups ?? []).map((group) => group.GroupName ?? '').filter(Boolean))
        .catch(() => [] as string[]);
      return toAdminUser(user, groups);
    }),
  );
  items.sort((a, b) => a.email.localeCompare(b.email, 'es'));
  return { items, adminGroup: adminGroup(ctx), actor: ctx.actor };
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Poné una dirección de correo válida.', 'invalid_email');
  return email;
}

/** Alta: Cognito manda la invitación con una contraseña temporal que nadie más ve. */
export async function createUser(ctx: AdminContext, body: { email?: unknown }): Promise<UsersResponse> {
  const UserPoolId = pool(ctx);
  const email = normalizeEmail(body.email);
  try {
    const created = await ctx.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    await ctx.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId, Username: created.User?.Username ?? email, GroupName: adminGroup(ctx) }));
  } catch (error) {
    if (error instanceof Error && error.name === 'UsernameExistsException') {
      throw new HttpError(409, 'Ya hay una cuenta con ese correo.', 'already_exists');
    }
    throw error;
  }
  await audit(ctx, 'users.create', email);
  return listUsers(ctx);
}

/** Reenvía la invitación a quien todavía no entró por primera vez. */
export async function resendInvite(ctx: AdminContext, username: string): Promise<UsersResponse> {
  const UserPoolId = pool(ctx);
  await ctx.cognito.send(
    new AdminCreateUserCommand({ UserPoolId, Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }),
  );
  await audit(ctx, 'users.resend_invite', username);
  return listUsers(ctx);
}

/** Reseteo: Cognito manda un código al correo y la persona elige contraseña nueva. */
export async function resetPassword(ctx: AdminContext, username: string): Promise<UsersResponse> {
  const UserPoolId = pool(ctx);
  await ctx.cognito.send(new AdminResetUserPasswordCommand({ UserPoolId, Username: username }));
  await audit(ctx, 'users.reset_password', username);
  return listUsers(ctx);
}

function guardSelf(ctx: AdminContext, username: string, action: string): void {
  if (username.toLowerCase() === ctx.actor.toLowerCase()) {
    throw new HttpError(400, `No podés ${action} tu propia cuenta.`, 'self_target');
  }
}

export async function setUserEnabled(ctx: AdminContext, username: string, enabled: boolean): Promise<UsersResponse> {
  const UserPoolId = pool(ctx);
  if (!enabled) guardSelf(ctx, username, 'deshabilitar');
  await ctx.cognito.send(
    enabled ? new AdminEnableUserCommand({ UserPoolId, Username: username }) : new AdminDisableUserCommand({ UserPoolId, Username: username }),
  );
  await audit(ctx, enabled ? 'users.enable' : 'users.disable', username);
  return listUsers(ctx);
}

export async function deleteUser(ctx: AdminContext, username: string, reason?: string): Promise<UsersResponse> {
  const UserPoolId = pool(ctx);
  guardSelf(ctx, username, 'borrar');
  await ctx.cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: username }));
  await audit(ctx, 'users.delete', username, reason ? { reason } : undefined);
  return listUsers(ctx);
}
