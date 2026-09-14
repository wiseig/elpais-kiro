import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AlertHistoryEntry, AlertSeverity, AlertState, AlertSummary, PanelAlert } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { fmtDateTime } from '../../shared/format';
import { Card } from '../../shared/components/Card';
import { Chip, type Tone } from '../../shared/components/Chip';
import { Empty } from '../../shared/components/Empty';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Field } from '../../shared/components/Field';
import { Modal } from '../../shared/components/Modal';
import { Notice, useNotice } from '../../shared/components/Notice';
import { PageHeader } from '../../shared/components/PageHeader';
import { Spinner } from '../../shared/components/Spinner';
import { Table, type Column } from '../../shared/components/Table';

const STATE_TONE: Record<AlertState, Tone> = {
  alarma: 'danger',
  ok: 'success',
  sin_datos: 'neutral',
  desconocido: 'neutral',
};

const STATE_LABEL: Record<AlertState, string> = {
  alarma: 'saltando ahora',
  ok: 'tranquila',
  sin_datos: 'sin datos',
  desconocido: 'sin desplegar',
};

const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  critica: 'danger',
  importante: 'warning',
  aviso: 'neutral',
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critica: 'crítica',
  importante: 'importante',
  aviso: 'aviso',
};

const HISTORY_TONE: Record<AlertHistoryEntry['kind'], Tone> = {
  alarma: 'danger',
  ok: 'success',
  sin_datos: 'neutral',
  configuracion: 'primary',
};

const HISTORY_LABEL: Record<AlertHistoryEntry['kind'], string> = {
  alarma: 'saltó',
  ok: 'se normalizó',
  sin_datos: 'se quedó sin datos',
  configuracion: 'cambio de configuración',
};

/** El umbral como se escribe: «8000 ms», «1 %», «1 corrida fallida». */
function fmtThreshold(alert: AlertSummary, value = alert.threshold): string {
  const number = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  const unit = value === 1 && alert.unitOne ? alert.unitOne : alert.unit;
  return unit === '%' ? `${number} %` : `${number} ${unit}`;
}

/** «en 1 ventana de 5 min», «en 3 ventanas seguidas de 1 h», «en 2 de 3 ventanas de 1 h». */
function windowsLabel(alert: AlertSummary): string {
  const window = windowLabel(alert.periodMinutes);
  if (alert.evaluationPeriods <= 1) return `en 1 ventana de ${window}`;
  if (alert.datapointsToAlarm >= alert.evaluationPeriods) return `en ${alert.evaluationPeriods} ventanas seguidas de ${window}`;
  return `en ${alert.datapointsToAlarm} de ${alert.evaluationPeriods} ventanas de ${window}`;
}

function windowLabel(minutes: number): string {
  if (minutes <= 0) return 'ventana';
  if (minutes % 1440 === 0) return `${minutes / 1440} día${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** Lo que se despliega al abrir una fila: por qué llega, qué hacer y cuándo saltó. */
function AlertDetail({ alert }: { alert: AlertSummary }) {
  const api = useApi();
  const history = useAsync(() => api.alertHistory(alert.key), [api, alert.key], !alert.missing);

  return (
    <div className="detail detail--inline">
      <div>
        <p className="small">
          <strong>Por qué llega.</strong> {alert.why}
        </p>
        <p className="small">
          <strong>Qué hacer cuando llega.</strong> {alert.action}
        </p>
      </div>

      <dl className="kv">
        <dt>Condición</dt>
        <dd>{alert.condition}</dd>
        <dt>Qué mide</dt>
        <dd>{alert.metricLabel}</dd>
        <dt>Alarma en AWS</dt>
        <dd>
          <code>{alert.alarmName}</code>
        </dd>
        {alert.stateReason && (
          <>
            <dt>Último estado</dt>
            <dd>{alert.stateReason}</dd>
          </>
        )}
      </dl>

      <div>
        <p className="small muted">Últimos cambios de estado (CloudWatch guarda dos semanas).</p>
        {alert.missing ? (
          <Empty text="La alarma todavía no existe en la cuenta." />
        ) : history.loading && !history.data ? (
          <Spinner />
        ) : history.error ? (
          <ErrorBox error={history.error} onRetry={history.reload} />
        ) : history.data && history.data.items.length > 0 ? (
          <ol className="runs">
            {history.data.items.map((item, index) => (
              <li key={`${item.at}-${index}`} className="runs__item">
                <div className="runs__head">
                  <Chip tone={HISTORY_TONE[item.kind]}>{HISTORY_LABEL[item.kind]}</Chip>
                  <span className="muted small">{fmtDateTime(item.at)}</span>
                </div>
                <p className="small" style={{ margin: '6px 0 0' }}>
                  {item.summary}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <Empty text={history.data?.note ?? 'Sin cambios de estado registrados.'} />
        )}
      </div>
    </div>
  );
}

interface ThresholdDialogProps {
  alert: AlertSummary;
  onClose: () => void;
  onSaved: (message: string) => void;
}

function ThresholdDialog({ alert, onClose, onSaved }: ThresholdDialogProps) {
  const api = useApi();
  const notice = useNotice();
  const [threshold, setThreshold] = useState(String(alert.threshold));
  const [periods, setPeriods] = useState(String(alert.evaluationPeriods));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const value = Number(threshold.replace(',', '.'));
    if (!Number.isFinite(value)) {
      notice.show('error', 'El umbral tiene que ser un número.');
      return;
    }
    if (value < alert.minThreshold || value > alert.maxThreshold) {
      notice.show('error', `Tiene que estar entre ${fmtThreshold(alert, alert.minThreshold)} y ${fmtThreshold(alert, alert.maxThreshold)}.`);
      return;
    }
    const windows = Number(periods);
    if (!Number.isInteger(windows) || windows < 1 || windows > 10) {
      notice.show('error', 'Las ventanas seguidas van de 1 a 10.');
      return;
    }
    setBusy(true);
    try {
      await api.updateAlert(alert.key, { threshold: value, evaluationPeriods: windows });
      onSaved(`«${alert.label}» ahora salta en ${fmtThreshold(alert, value)}.`);
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
      title={`Umbral de «${alert.label}»`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar umbral'}
          </button>
        </>
      }
    >
      <Notice notice={notice.notice} onClose={notice.clear} />
      <p className="small">{alert.why}</p>

      <div className="form-grid">
        <Field
          label={`Umbral (${alert.unit})`}
          hint={`Entre ${fmtThreshold(alert, alert.minThreshold)} y ${fmtThreshold(alert, alert.maxThreshold)}. Hoy: ${fmtThreshold(alert)}.`}
        >
          <input
            className="input input--number"
            type="number"
            min={alert.minThreshold}
            max={alert.maxThreshold}
            step={alert.stepThreshold}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
          />
        </Field>
        <Field
          label="Ventanas seguidas"
          hint={`Cuántas mediciones de ${windowLabel(alert.periodMinutes)} tienen que dar mal antes de avisar. Subirlo evita falsos positivos; bajarlo avisa antes.`}
        >
          <input
            className="input input--number"
            type="number"
            min={1}
            max={10}
            step={1}
            value={periods}
            onChange={(event) => setPeriods(event.target.value)}
          />
        </Field>
      </div>

      <div className="notice notice--warning">
        El cambio se aplica en AWS enseguida y queda en la auditoría. La alarma vuelve a «sin datos» hasta que junte
        mediciones nuevas. Si más adelante se vuelve a desplegar la infraestructura, gana el umbral escrito en el código.
      </div>
    </Modal>
  );
}

/** Los avisos que solo se ven en Inicio: no salen por correo y el umbral vive en Configuración. */
function PanelCard({ items }: { items: PanelAlert[] }) {
  const columns: Column<PanelAlert>[] = [
    {
      key: 'alert',
      header: 'Aviso',
      render: (row) => (
        <span className="cell-text">
          <strong>{row.label}</strong>
          <span className="muted small">{row.why}</span>
        </span>
      ),
    },
    { key: 'condition', header: 'Cuándo aparece', render: (row) => <span className="small">{row.condition}</span> },
    {
      key: 'setting',
      header: 'Dónde se cambia',
      render: (row) => (row.settingLabel ? <span className="muted small">{row.settingLabel}</span> : <span className="muted small">Fijo en el código</span>),
    },
  ];

  return (
    <Card
      title="Avisos del panel"
      description="Estos no mandan correo: aparecen arriba de todo en Inicio mientras la condición esté dada. Los umbrales salen de la configuración vigente."
      actions={
        <Link className="btn btn--small" to="/configuracion">
          Ir a Configuración
        </Link>
      }
    >
      <Table columns={columns} rows={items} rowKey={(row) => row.key} dense emptyText="Sin avisos de panel." />
    </Card>
  );
}

export default function AlertasPage() {
  const api = useApi();
  const list = useAsync(() => api.alerts(), [api]);
  const notice = useNotice();
  const [editing, setEditing] = useState<AlertSummary | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const toggleNotifying = async (alert: AlertSummary) => {
    setBusyKey(alert.key);
    try {
      await api.updateAlert(alert.key, { notifying: !alert.notifying });
      notice.show(
        'success',
        alert.notifying
          ? `«${alert.label}» quedó silenciada: sigue midiendo pero no manda correo.`
          : `«${alert.label}» vuelve a mandar correo.`,
      );
      list.reload();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  };

  const saved = (message: string) => {
    notice.show('success', message);
    list.reload();
  };

  const columns: Column<AlertSummary>[] = [
    {
      key: 'alert',
      header: 'Alerta',
      render: (row) => (
        <span className="cell-text">
          <strong>{row.label}</strong>
          <Chip tone={SEVERITY_TONE[row.severity]}>{SEVERITY_LABEL[row.severity]}</Chip>
          {!row.notifying && !row.missing && <Chip tone="warning">silenciada</Chip>}
          {row.missing && <Chip tone="neutral">sin desplegar</Chip>}
          <span className="muted small">{row.why}</span>
        </span>
      ),
    },
    { key: 'group', header: 'Familia', nowrap: true, render: (row) => <span className="muted small">{row.group}</span> },
    {
      key: 'threshold',
      header: 'Salta cuando',
      render: (row) =>
        row.missing ? (
          <span className="muted">—</span>
        ) : (
          <span className="cell-text">
            <strong>
              {row.comparison} {fmtThreshold(row)}
            </strong>
            <span className="muted small">{windowsLabel(row)}</span>
          </span>
        ),
    },
    {
      key: 'state',
      header: 'Estado',
      render: (row) => (
        <span className="cell-text">
          <Chip tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Chip>
          {row.stateChangedAt && <span className="muted small">desde {fmtDateTime(row.stateChangedAt)}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Acciones',
      align: 'right',
      render: (row) =>
        row.missing ? (
          <span className="muted small">Se crea al desplegar</span>
        ) : (
          <div className="btn-row btn-row--end">
            <button type="button" className="btn btn--small" onClick={() => setEditing(row)}>
              Umbral
            </button>
            <button
              type="button"
              className={row.notifying ? 'btn btn--small btn--danger-outline' : 'btn btn--small'}
              disabled={busyKey === row.key}
              onClick={() => void toggleNotifying(row)}
            >
              {row.notifying ? 'Silenciar' : 'Reactivar'}
            </button>
          </div>
        ),
    },
  ];

  const data = list.data;
  const confirmed = data?.recipients.filter((item) => item.confirmed) ?? [];
  const pending = (data?.recipients.length ?? 0) - confirmed.length;
  const firing = data?.alerts.filter((item) => item.state === 'alarma') ?? [];
  const muted = data?.alerts.filter((item) => !item.notifying && !item.missing) ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Alertas"
        description="Todo lo que puede avisarte algo: qué mide cada alerta, por qué llega, con qué umbral salta y a quién le llega. Clic en una fila para ver la explicación completa y cuándo saltó por última vez."
        onRefresh={list.reload}
        refreshing={list.loading}
      />

      <Notice notice={notice.notice} onClose={notice.clear} />

      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {data?.readError && <div className="notice notice--warning">{data.readError}</div>}
      {list.loading && !data && <Spinner />}

      {data && (
        <>
          <Card
            title={
              <>
                Quién recibe estos correos{' '}
                {confirmed.length === 0 ? (
                  <Chip tone="danger">nadie recibe</Chip>
                ) : (
                  <Chip tone="success">{confirmed.length} reciben</Chip>
                )}
                {pending > 0 && <Chip tone="warning">{pending} sin confirmar</Chip>}
              </>
            }
            description="Las alarmas de la tabla de abajo se publican en un tema de SNS y desde ahí salen por correo a esta lista."
            actions={
              <Link className="btn btn--small" to="/notificaciones">
                Editar la lista
              </Link>
            }
          >
            {confirmed.length === 0 ? (
              <Empty text="Nadie confirmó la suscripción a la lista de alarmas: hoy estas alertas no le llegan a nadie." />
            ) : (
              <p className="small">{confirmed.map((item) => item.email).join(' · ')}</p>
            )}
            {(firing.length > 0 || muted.length > 0 || data.missingCount > 0) && (
              <p className="small muted">
                {firing.length > 0 && `${firing.length} ${firing.length === 1 ? 'alerta está saltando' : 'alertas están saltando'} ahora. `}
                {muted.length > 0 && `${muted.length} ${muted.length === 1 ? 'está silenciada' : 'están silenciadas'}. `}
                {data.missingCount > 0 && `${data.missingCount} del catálogo todavía no existen en este entorno.`}
              </p>
            )}
          </Card>

          <Card
            title="Alertas por correo"
            description="El umbral y las ventanas se guardan en CloudWatch y se aplican enseguida. Silenciar deja la alerta midiendo, pero sin mandar el correo."
          >
            <Table
              columns={columns}
              rows={data.alerts}
              rowKey={(row) => row.key}
              expandable={(row) => <AlertDetail alert={row} />}
              emptyText="No hay alertas configuradas."
            />
          </Card>

          <PanelCard items={data.panel} />
        </>
      )}

      {editing && <ThresholdDialog alert={editing} onClose={() => setEditing(null)} onSaved={saved} />}
    </div>
  );
}
