import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { JobRun, JobSummary } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { fmtDateTime } from '../../shared/format';
import { Card } from '../../shared/components/Card';
import { Chip } from '../../shared/components/Chip';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Empty } from '../../shared/components/Empty';
import { Field } from '../../shared/components/Field';
import { Modal } from '../../shared/components/Modal';
import { Notice, useNotice } from '../../shared/components/Notice';
import { PageHeader } from '../../shared/components/PageHeader';
import { Spinner } from '../../shared/components/Spinner';
import { Table, type Column } from '../../shared/components/Table';

/** Uruguay no tiene horario de verano: el desfase con UTC es fijo. */
const UTC_OFFSET_HOURS = -3;

function toLocal(utcHour: number, utcMinute: number): string {
  const hour = (utcHour + UTC_OFFSET_HOURS + 24) % 24;
  return `${String(hour).padStart(2, '0')}:${String(utcMinute).padStart(2, '0')}`;
}

function toUtc(local: string): { utcHour: number; utcMinute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(local.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { utcHour: (hour - UTC_OFFSET_HOURS + 24) % 24, utcMinute: minute };
}

/** El horario en palabras, siempre en hora de Montevideo. */
function describeSchedule(job: JobSummary): string {
  const { schedule } = job;
  if (schedule.kind === 'daily' && schedule.utcHour !== undefined && schedule.utcMinute !== undefined) {
    return `Todos los días a las ${toLocal(schedule.utcHour, schedule.utcMinute)}`;
  }
  if (schedule.kind === 'rate' && schedule.everyMinutes) {
    const minutes = schedule.everyMinutes;
    if (minutes % 60 === 0) return `Cada ${minutes / 60} ${minutes === 60 ? 'hora' : 'horas'}`;
    return `Cada ${minutes} minutos`;
  }
  return schedule.expression || 'Sin horario propio';
}

const RUN_TONE: Record<JobRun['status'], 'success' | 'danger' | 'warning'> = {
  ok: 'success',
  failed: 'danger',
  running: 'warning',
  warning: 'warning',
};

const RUN_LABEL: Record<JobRun['status'], string> = {
  ok: 'ok',
  failed: 'falló',
  running: 'corriendo',
  warning: 'con avisos',
};

/** Últimas corridas del trabajo, con lo que dejó cada una. Se pide al desplegar la fila. */
function JobRunsView({ job }: { job: JobSummary }) {
  const api = useApi();
  const runs = useAsync(() => api.jobRuns(job.key), [api, job.key]);

  if (runs.loading && !runs.data) return <Spinner />;
  if (runs.error) return <ErrorBox error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return null;

  const { runs: items, link, note } = runs.data;

  return (
    <div className="detail detail--inline">
      {items.length === 0 ? (
        <Empty text={note ?? 'Todavía no hay corridas registradas.'} />
      ) : (
        <ol className="runs">
          {items.map((run, index) => (
            <li key={`${run.at}-${index}`} className="runs__item">
              <div className="runs__head">
                <Chip tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Chip>
                <strong>{run.headline}</strong>
                <span className="muted small">{fmtDateTime(run.at)}</span>
              </div>
              {run.error && <p className="runs__error">{run.error}</p>}
              {run.details.length > 0 && (
                <dl className="kv runs__kv">
                  {run.details.map((detail, position) => (
                    <Fragment key={`${detail.label}-${position}`}>
                      <dt>{detail.label}</dt>
                      <dd>{detail.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ol>
      )}
      {link && (
        <p className="small">
          <Link to={link.to}>{link.label} →</Link>
        </p>
      )}
    </div>
  );
}

function StatusChip({ job }: { job: JobSummary }) {
  if (!job.lastStatus) return <span className="muted">Sin registro</span>;
  const tone = job.lastStatus === 'ok' ? 'success' : job.lastStatus === 'failed' ? 'danger' : 'warning';
  const label = job.lastStatus === 'ok' ? 'ok' : job.lastStatus === 'failed' ? 'falló' : 'corriendo';
  return <Chip tone={tone}>{label}</Chip>;
}

function ScheduleDialog({ job, onClose, onSaved }: { job: JobSummary; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const notice = useNotice();
  const [busy, setBusy] = useState(false);
  const daily = job.schedule.kind === 'daily';
  const [time, setTime] = useState(
    daily && job.schedule.utcHour !== undefined && job.schedule.utcMinute !== undefined
      ? toLocal(job.schedule.utcHour, job.schedule.utcMinute)
      : '01:00',
  );
  const [minutes, setMinutes] = useState(String(job.schedule.everyMinutes ?? 60));

  const save = async () => {
    setBusy(true);
    try {
      if (daily) {
        const utc = toUtc(time);
        if (!utc) {
          notice.show('error', 'La hora tiene que tener el formato HH:MM.');
          return;
        }
        await api.updateJob(job.key, utc);
      } else {
        await api.updateJob(job.key, { everyMinutes: Number(minutes) });
      }
      onSaved();
      onClose();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Horario de ${job.label.toLocaleLowerCase('es')}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar horario'}
          </button>
        </>
      }
    >
      <Notice notice={notice.notice} onClose={notice.clear} />
      <p className="muted small">{job.description}</p>
      {daily ? (
        <Field label="Hora de Montevideo" hint="Se guarda en UTC, que es lo que entiende el programador de AWS.">
          <input className="input" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </Field>
      ) : (
        <Field label="Cada cuántos minutos" hint="Entre 5 minutos y 24 horas.">
          <input
            className="input input--number"
            type="number"
            min={5}
            max={1440}
            step={5}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </Field>
      )}
      <div className="notice notice--warning">
        El cambio se aplica en AWS enseguida. Si más adelante se vuelve a desplegar la infraestructura, gana el
        horario que está escrito en el código.
      </div>
    </Modal>
  );
}

export default function TrabajosPage() {
  const api = useApi();
  const list = useAsync(() => api.jobs(), [api]);
  const notice = useNotice();
  const [editing, setEditing] = useState<JobSummary | null>(null);
  const [pausing, setPausing] = useState<JobSummary | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const run = async (job: JobSummary) => {
    setBusyKey(job.key);
    try {
      await api.runJob(job.key);
      notice.show('success', `${job.label} quedó disparado. El resultado aparece en unos segundos.`);
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  };

  const togglePause = async (job: JobSummary) => {
    setBusyKey(job.key);
    try {
      await api.updateJob(job.key, { enabled: !job.enabled });
      notice.show('success', job.enabled ? `${job.label} quedó pausado.` : `${job.label} volvió a estar activo.`);
      list.reload();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusyKey(null);
      setPausing(null);
    }
  };

  const columns: Column<JobSummary>[] = [
    {
      key: 'job',
      header: 'Trabajo',
      render: (row) => (
        <span className="cell-text">
          <strong>{row.label}</strong>
          {!row.enabled && row.configurable && <Chip tone="warning">pausado</Chip>}
          <span className="muted small">{row.description}</span>
        </span>
      ),
    },
    { key: 'schedule', header: 'Cuándo', nowrap: true, render: (row) => describeSchedule(row) },
    {
      key: 'last',
      header: 'Última corrida',
      render: (row) => (
        <span className="cell-text">
          {row.lastRunAt ? fmtDateTime(row.lastRunAt) : <span className="muted">Sin registro</span>}
          <StatusChip job={row} />
          {row.lastDetail && <span className="muted small">{row.lastDetail}</span>}
        </span>
      ),
    },
    { key: 'next', header: 'Próxima', nowrap: true, render: (row) => (row.nextRunAt ? fmtDateTime(row.nextRunAt) : <span className="muted">—</span>) },
    {
      key: 'actions',
      header: 'Acciones',
      align: 'right',
      render: (row) => (
        <div className="btn-row btn-row--end">
          {row.runnable && (
            <button type="button" className="btn btn--small" disabled={busyKey === row.key} onClick={() => void run(row)}>
              Ejecutar ahora
            </button>
          )}
          {row.configurable && (
            <>
              <button type="button" className="btn btn--small" onClick={() => setEditing(row)}>
                Horario
              </button>
              <button
                type="button"
                className={row.enabled ? 'btn btn--small btn--danger-outline' : 'btn btn--small'}
                disabled={busyKey === row.key}
                onClick={() => (row.enabled ? setPausing(row) : void togglePause(row))}
              >
                {row.enabled ? 'Pausar' : 'Activar'}
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Trabajos programados"
        description="Todo lo que corre solo: cuándo toca cada uno, cómo salió la última vez y cuándo vuelve. Clic en una fila para ver qué dejó cada corrida. Desde acá se cambian los horarios, se pausan o se disparan a mano."
        onRefresh={list.reload}
        refreshing={list.loading}
      />

      <Notice notice={notice.notice} onClose={notice.clear} />

      <Card title="Agenda">
        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.loading && !list.data && <Spinner />}
        {list.data && (
          <Table
            columns={columns}
            rows={list.data.jobs}
            rowKey={(row) => row.key}
            expandable={(row) => <JobRunsView job={row} />}
            emptyText="No hay trabajos programados."
          />
        )}
      </Card>

      {editing && <ScheduleDialog job={editing} onClose={() => setEditing(null)} onSaved={list.reload} />}
      {pausing && (
        <ConfirmDialog
          open
          title={`Pausar ${pausing.label.toLocaleLowerCase('es')}`}
          message={
            <p>
              Mientras esté pausado no va a correr solo. El corpus, las evaluaciones o los costos pueden quedar
              desactualizados hasta que lo actives de nuevo.
            </p>
          }
          confirmLabel="Pausar"
          danger
          busy={busyKey === pausing.key}
          onCancel={() => setPausing(null)}
          onConfirm={() => void togglePause(pausing)}
        />
      )}
    </div>
  );
}
