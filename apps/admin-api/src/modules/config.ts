import type { Config } from '@pelp/domain';
import { validateConfig } from '@pelp/domain';
import type { ConfigResponse, ConfigVersionSummary, PutConfigRequest, RollbackRequest } from '@pelp/domain/api';
import { HttpError, audit, type AdminContext } from '../context';

export async function getConfig(ctx: AdminContext): Promise<ConfigResponse> {
  await ctx.config.get();
  const record = await ctx.store.getConfigRecord();
  if (!record) throw new HttpError(404, 'Sin configuración.', 'not_found');
  // Lo guardado puede ser anterior a un bloque nuevo del esquema. El motor lo parsea y ve los
  // valores por defecto; el backoffice tiene que ver exactamente lo mismo, o edita a ciegas.
  const parsed = validateConfig(record.config);
  return {
    config: parsed.ok && parsed.config ? parsed.config : record.config,
    version: record.version,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export async function putConfig(ctx: AdminContext, body: Partial<PutConfigRequest>): Promise<ConfigResponse> {
  const validation = validateConfig(body.config);
  if (!validation.ok || !validation.config) throw new HttpError(400, 'Configuración inválida.', 'invalid_config', { errors: validation.errors });
  const next: Config = validation.config;
  if (next.personalization.intensity > next.personalization.hardMax && body.confirmAboveHardMax !== true) {
    throw new HttpError(409, `La intensidad (${next.personalization.intensity}) supera hardMax (${next.personalization.hardMax}). Confirmá explícitamente.`, 'confirm_required', { warnings: validation.warnings });
  }
  const before = await ctx.store.getConfigRecord();
  const record = await ctx.store.putConfig(next, ctx.actor, body.reason);
  ctx.config.invalidate();
  await audit(ctx, 'config.put', `v${record.version}`, { before: before?.config, after: record.config, ...(body.reason ? { reason: body.reason } : {}) });
  return { config: record.config, version: record.version, updatedAt: record.updatedAt, updatedBy: record.updatedBy };
}

export async function listVersions(ctx: AdminContext): Promise<{ items: ConfigVersionSummary[] }> {
  const versions = await ctx.store.listConfigVersions(100);
  return { items: versions.map((record) => ({ version: record.version, updatedAt: record.updatedAt, updatedBy: record.updatedBy, ...(record.reason ? { reason: record.reason } : {}) })) };
}

export async function getVersion(ctx: AdminContext, version: number): Promise<ConfigResponse> {
  const record = await ctx.store.getConfigVersion(version);
  if (!record) throw new HttpError(404, 'Versión no encontrada.', 'not_found');
  return { config: record.config, version: record.version, updatedAt: record.updatedAt, updatedBy: record.updatedBy };
}

export async function rollback(ctx: AdminContext, body: Partial<RollbackRequest>): Promise<ConfigResponse> {
  if (typeof body.version !== 'number') throw new HttpError(400, 'Falta version.', 'invalid_version');
  const target = await ctx.store.getConfigVersion(body.version);
  if (!target) throw new HttpError(404, 'Versión no encontrada.', 'not_found');
  const before = await ctx.store.getConfigRecord();
  const record = await ctx.store.putConfig(target.config, ctx.actor, body.reason ?? `rollback a v${body.version}`);
  ctx.config.invalidate();
  await audit(ctx, 'config.rollback', `v${body.version}→v${record.version}`, { before: before?.config, after: record.config, ...(body.reason ? { reason: body.reason } : {}) });
  return { config: record.config, version: record.version, updatedAt: record.updatedAt, updatedBy: record.updatedBy };
}
