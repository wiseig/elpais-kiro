import { useEffect, useMemo, useState } from 'react';
import type { ConfigResponse, ConfigVersionSummary } from '@pelp/domain/api';
import { validateConfig, type Config, type ConfigValidation } from '@pelp/domain';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { HardMaxDialog, useConfigSaver, type ConfigSaveResult } from '../../shared/useConfigSaver';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Toggle } from '../../shared/components/Field';
import { JsonDiff } from '../../shared/components/JsonDiff';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { Modal } from '../../shared/components/Modal';
import { Table, type Column } from '../../shared/components/Table';
import { Notice, useNotice } from '../../shared/components/Notice';
import { Chip } from '../../shared/components/Chip';
import { fmtDateTime } from '../../shared/format';

type KillSwitchKey = 'service' | 'personalization';

interface KillSwitchTarget {
  key: KillSwitchKey;
  next: boolean;
}

function pretty(config: unknown): string {
  return JSON.stringify(config, null, 2);
}

function ValidationResult({ validation }: { validation: ConfigValidation }) {
  return (
    <div className="validation" aria-live="polite">
      {validation.ok ? (
        <p className="text-success">JSON válido según el esquema de configuración.</p>
      ) : (
        <>
          <p className="text-danger">
            <strong>
              {validation.errors.length} {validation.errors.length === 1 ? 'error' : 'errores'}:
            </strong>
          </p>
          <ul className="validation__list validation__list--errors">
            {validation.errors.map((error, index) => (
              <li key={`${index}-${error}`}>{error}</li>
            ))}
          </ul>
        </>
      )}
      {validation.warnings.length > 0 && (
        <>
          <p className="text-warning">
            <strong>Advertencias:</strong>
          </p>
          <ul className="validation__list validation__list--warnings">
            {validation.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function ConfiguracionPage() {
  const api = useApi();
  const current = useAsync(() => api.getConfig(), [api]);
  const versions = useAsync(() => api.configVersions(), [api]);
  const saver = useConfigSaver(api);
  const notice = useNotice();

  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<ConfigValidation | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [killTarget, setKillTarget] = useState<KillSwitchTarget | null>(null);
  const [viewing, setViewing] = useState<ConfigResponse | null>(null);
  const [viewLoading, setViewLoading] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ConfigVersionSummary | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const config = current.data;

  useEffect(() => {
    if (config && !dirty) setText(pretty(config.config));
  }, [config, dirty]);

  const currentText = useMemo(() => (config ? pretty(config.config) : ''), [config]);
  const normalizedEdit = useMemo(() => {
    try {
      return pretty(JSON.parse(text) as unknown);
    } catch {
      return text;
    }
  }, [text]);
  const hasChanges = config !== undefined && normalizedEdit !== currentText;

  const validate = (): ConfigValidation => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const result: ConfigValidation = { ok: false, errors: [`JSON inválido: ${errorMessage(error)}`], warnings: [] };
      setValidation(result);
      return result;
    }
    const result = validateConfig(parsed);
    setValidation(result);
    return result;
  };

  const applyResult = (result: ConfigSaveResult, successText: (response: ConfigResponse) => string) => {
    switch (result.status) {
      case 'saved':
        current.setData(result.response);
        setDirty(false);
        setValidation(null);
        versions.reload();
        notice.show('success', successText(result.response));
        break;
      case 'confirm':
        break;
      case 'invalid':
        setValidation({ ok: false, errors: result.errors, warnings: [] });
        notice.show('error', `El servidor rechazó la configuración: ${result.message}`);
        break;
      case 'error':
        notice.show('error', result.message);
        break;
    }
  };

  const handleSave = async (reason: string) => {
    setSaveOpen(false);
    const result = validate();
    if (!result.ok || !result.config) {
      notice.show('error', 'Corregí los errores de validación antes de guardar.');
      return;
    }
    const saved = await saver.save({ config: result.config, reason: reason || undefined });
    applyResult(saved, (response) => `Configuración guardada como versión ${response.version}.`);
  };

  const handleKillSwitch = async (target: KillSwitchTarget) => {
    setKillTarget(null);
    if (!config) return;
    const base = config.config;
    const next: Config =
      target.key === 'service'
        ? { ...base, service: { ...base.service, enabled: target.next } }
        : { ...base, personalization: { ...base.personalization, enabled: target.next } };
    const saved = await saver.save({ config: next, reason: 'kill switch' });
    applyResult(saved, (response) => {
      const what = target.key === 'service' ? 'Servicio' : 'Personalización';
      return `${what} ${target.next ? 'habilitado' : 'deshabilitado'} (versión ${response.version}).`;
    });
  };

  const handleRollback = async (reason: string) => {
    if (!rollbackTarget) return;
    setRollingBack(true);
    try {
      const response = await api.rollbackConfig({ version: rollbackTarget.version, reason: reason || undefined });
      current.setData(response);
      setDirty(false);
      setValidation(null);
      versions.reload();
      notice.show('success', `Rollback a la versión ${rollbackTarget.version} aplicado; ahora es la versión ${response.version}.`);
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setRollingBack(false);
      setRollbackTarget(null);
    }
  };

  const viewVersion = async (version: number) => {
    setViewLoading(version);
    try {
      setViewing(await api.configVersion(version));
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setViewLoading(null);
    }
  };

  const loadIntoEditor = (response: ConfigResponse) => {
    setText(pretty(response.config));
    setDirty(true);
    setValidation(null);
    setViewing(null);
    notice.show('info', `Versión ${response.version} cargada en el editor. Revisá el diff y guardá si corresponde.`);
  };

  const versionColumns: Column<ConfigVersionSummary>[] = [
    { key: 'version', header: 'Versión', render: (row) => <strong>{row.version}</strong>, width: '90px' },
    { key: 'updatedAt', header: 'Fecha', render: (row) => fmtDateTime(row.updatedAt), nowrap: true },
    { key: 'updatedBy', header: 'Autor', render: (row) => row.updatedBy },
    { key: 'reason', header: 'Motivo', render: (row) => row.reason || <span className="muted">—</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="btn-row btn-row--end">
          <button type="button" className="btn btn--small" onClick={() => void viewVersion(row.version)} disabled={viewLoading === row.version}>
            {viewLoading === row.version ? 'Cargando…' : 'Ver'}
          </button>
          <button
            type="button"
            className="btn btn--small btn--danger-outline"
            onClick={() => setRollbackTarget(row)}
            disabled={config !== undefined && row.version === config.version}
          >
            Rollback
          </button>
        </div>
      ),
    },
  ];

  const busy = saver.saving || rollingBack;

  return (
    <div className="page">
      <PageHeader
        title="Configuración"
        description="Editor del JSON global (sección 13) con validación, diff, historial y kill switches."
        onRefresh={() => {
          current.reload();
          versions.reload();
        }}
        refreshing={current.loading || versions.loading}
      />
      <Notice notice={notice.notice} onClose={notice.clear} />
      {current.error && <ErrorBox error={current.error} onRetry={current.reload} />}
      {current.loading && !config && <Spinner />}

      {config && (
        <>
          <Card
            title="Kill switches"
            description="Se guardan de inmediato con motivo «kill switch». Impactan en la Lambda en menos de 60 segundos."
            tone={!config.config.service.enabled ? 'danger' : undefined}
          >
            <div className="kill-switches">
              <div className="kill-switch">
                <Toggle
                  checked={config.config.service.enabled}
                  danger={!config.config.service.enabled}
                  disabled={busy}
                  onChange={(next) => setKillTarget({ key: 'service', next })}
                  label={
                    <>
                      <strong>Servicio habilitado</strong>
                      <span className="muted">
                        {config.config.service.enabled ? 'Respondiendo preguntas.' : `Pausado: «${config.config.service.maintenanceMessage}»`}
                      </span>
                    </>
                  }
                />
              </div>
              <div className="kill-switch">
                <Toggle
                  checked={config.config.personalization.enabled}
                  disabled={busy}
                  onChange={(next) => setKillTarget({ key: 'personalization', next })}
                  label={
                    <>
                      <strong>Personalización habilitada</strong>
                      <span className="muted">
                        Intensidad {config.config.personalization.intensity} · rollout {config.config.personalization.rolloutPercent} %
                        {config.config.personalization.autoLowered ? ' · auto-bajada activa' : ''}
                      </span>
                    </>
                  }
                />
              </div>
            </div>
          </Card>

          <Card
            title={
              <>
                Editor · versión {config.version}{' '}
                {dirty && hasChanges && <Chip tone="warning">cambios sin guardar</Chip>}
              </>
            }
            description={
              <>
                Actualizada {fmtDateTime(config.updatedAt)} por {config.updatedBy}.
              </>
            }
            actions={
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setDirty(false);
                    setText(currentText);
                    setValidation(null);
                  }}
                  disabled={!hasChanges || busy}
                >
                  Descartar cambios
                </button>
                <button type="button" className="btn" onClick={validate} disabled={busy}>
                  Validar
                </button>
                <button type="button" className="btn btn--primary" onClick={() => setSaveOpen(true)} disabled={!hasChanges || busy}>
                  {saver.saving ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            }
          >
            <label className="field">
              <span className="sr-only">JSON de configuración</span>
              <textarea
                className="input input--code"
                rows={28}
                spellCheck={false}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setDirty(true);
                }}
                aria-describedby="config-editor-hint"
              />
            </label>
            <p id="config-editor-hint" className="field__hint">
              Cambiá el JSON, validá y guardá con motivo. El campo <code>version</code> lo administra el servidor.
            </p>
            {validation && <ValidationResult validation={validation} />}
            {hasChanges && (
              <div className="diff-section">
                <h3 className="h3">Diff contra la versión actual</h3>
                <JsonDiff before={currentText} after={normalizedEdit} beforeLabel={`Versión ${config.version}`} afterLabel="Editado" />
              </div>
            )}
          </Card>
        </>
      )}

      <Card title="Historial de versiones" description="Cada guardado crea una versión. «Ver» compara contra la actual; «Rollback» la restaura como versión nueva.">
        {versions.error && <ErrorBox error={versions.error} onRetry={versions.reload} />}
        {versions.loading && !versions.data && <Spinner />}
        {versions.data && (
          <Table
            columns={versionColumns}
            rows={versions.data.items}
            rowKey={(row) => String(row.version)}
            emptyText="Todavía no hay versiones guardadas."
            dense
            maxHeight={420}
          />
        )}
      </Card>

      <ConfirmDialog
        open={saveOpen}
        title="Guardar configuración"
        message="Se crea una versión nueva y queda registrada en la auditoría."
        confirmLabel="Guardar"
        reason="optional"
        onConfirm={(reason) => void handleSave(reason)}
        onCancel={() => setSaveOpen(false)}
      />

      <ConfirmDialog
        open={killTarget !== null}
        title={
          killTarget?.key === 'service'
            ? killTarget.next
              ? 'Habilitar el servicio'
              : 'Pausar el servicio'
            : killTarget?.next
              ? 'Habilitar la personalización'
              : 'Deshabilitar la personalización'
        }
        danger={killTarget !== null && !killTarget.next}
        busy={saver.saving}
        confirmLabel={killTarget?.next ? 'Habilitar' : 'Deshabilitar'}
        message={
          killTarget?.key === 'service'
            ? killTarget.next
              ? 'El asistente vuelve a responder preguntas en todos los canales.'
              : 'El asistente deja de responder y muestra el mensaje de mantenimiento en todos los canales.'
            : killTarget?.next
              ? 'Las respuestas vuelven a adaptarse para la cohorte personalizada.'
              : 'Todas las respuestas pasan a ser canónicas hasta que se vuelva a habilitar.'
        }
        onConfirm={() => {
          if (killTarget) void handleKillSwitch(killTarget);
        }}
        onCancel={() => setKillTarget(null)}
      />

      <ConfirmDialog
        open={rollbackTarget !== null}
        title={`Rollback a la versión ${rollbackTarget?.version ?? ''}`}
        danger
        busy={rollingBack}
        confirmLabel="Aplicar rollback"
        reason="optional"
        message={
          <>
            Se restaura la configuración de la versión {rollbackTarget?.version} ({rollbackTarget ? fmtDateTime(rollbackTarget.updatedAt) : ''}, por{' '}
            {rollbackTarget?.updatedBy}) como una versión nueva. La versión actual queda en el historial.
          </>
        }
        onConfirm={(reason) => void handleRollback(reason)}
        onCancel={() => setRollbackTarget(null)}
      />

      <Modal
        open={viewing !== null}
        title={`Versión ${viewing?.version ?? ''}`}
        size="xl"
        onClose={() => setViewing(null)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setViewing(null)}>
              Cerrar
            </button>
            {viewing && (
              <button type="button" className="btn" onClick={() => loadIntoEditor(viewing)}>
                Cargar en el editor
              </button>
            )}
            {viewing && config && viewing.version !== config.version && (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setRollbackTarget({ version: viewing.version, updatedAt: viewing.updatedAt, updatedBy: viewing.updatedBy });
                  setViewing(null);
                }}
              >
                Rollback a esta versión
              </button>
            )}
          </>
        }
      >
        {viewing && (
          <>
            <p className="muted">
              Guardada {fmtDateTime(viewing.updatedAt)} por {viewing.updatedBy}. Izquierda: versión actual ({config?.version ?? '—'}); derecha:
              versión {viewing.version}. Es lo que cambiaría un rollback.
            </p>
            <JsonDiff before={currentText} after={pretty(viewing.config)} beforeLabel={`Versión ${config?.version ?? '—'}`} afterLabel={`Versión ${viewing.version}`} />
            <details className="details">
              <summary>JSON completo de la versión {viewing.version}</summary>
              <pre className="json">{pretty(viewing.config)}</pre>
            </details>
          </>
        )}
      </Modal>

      <HardMaxDialog saver={saver} onResult={(result) => applyResult(result, (response) => `Configuración guardada como versión ${response.version}.`)} />
    </div>
  );
}
