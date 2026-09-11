import { Link } from 'react-router-dom';
import type { AdminOverview } from '@pelp/domain/api';
import type { SyncRunRecord } from '@pelp/domain';
import { intensityLevel } from '@pelp/domain';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Progress, Stat } from '../../shared/components/Stat';
import { Chip, type Tone } from '../../shared/components/Chip';
import { Empty } from '../../shared/components/Empty';
import { fmtDateTime, fmtDay, fmtDuration, fmtInt, fmtMs, fmtPercent, fmtPercentValue, fmtUsd } from '../../shared/format';

const LEVEL_LABELS: Record<number, string> = {
  0: 'nivel 0 · solo canónica',
  1: 'nivel 1 · reordena y ajusta estilo',
  2: 'nivel 2 · encuadre y repreguntas',
  3: 'nivel 3 · énfasis por encuadre',
};

function syncTone(status: SyncRunRecord['status']): Tone {
  if (status === 'ok') return 'success';
  if (status === 'failed') return 'danger';
  return 'warning';
}

export function SyncStatusCard({ run, corpusVersion }: { run: SyncRunRecord | undefined; corpusVersion: string }) {
  return (
    <Card
      title="Último sync del corpus"
      description={
        <>
          Versión del corpus: <code>{corpusVersion || '—'}</code>
        </>
      }
      actions={
        <Link className="btn btn--small" to="/corpus">
          Ver corpus
        </Link>
      }
    >
      {!run ? (
        <Empty text="Todavía no hay corridas de sincronización registradas." />
      ) : (
        <dl className="kv">
          <dt>Estado</dt>
          <dd>
            <Chip tone={syncTone(run.status)}>{run.status}</Chip> <span className="muted">({run.job})</span>
          </dd>
          <dt>Inicio</dt>
          <dd>{fmtDateTime(run.startedAt)}</dd>
          <dt>Duración</dt>
          <dd>{run.finishedAt ? fmtDuration(run.startedAt, run.finishedAt) : 'en curso'}</dd>
          <dt>Notas</dt>
          <dd>
            {fmtInt(run.fetched)} leídas · {fmtInt(run.written)} escritas · {fmtInt(run.unchanged)} sin cambios
          </dd>
          {run.ingestionJobId && (
            <>
              <dt>Ingestion job</dt>
              <dd>
                <code>{run.ingestionJobId}</code>
              </dd>
            </>
          )}
          {run.error && (
            <>
              <dt>Error</dt>
              <dd className="text-danger">{run.error}</dd>
            </>
          )}
          {run.consecutiveFailures !== undefined && run.consecutiveFailures > 0 && (
            <>
              <dt>Fallos seguidos</dt>
              <dd className="text-danger">{run.consecutiveFailures}</dd>
            </>
          )}
        </dl>
      )}
    </Card>
  );
}

function Overview({ data }: { data: AdminOverview }) {
  const budgetTone: Tone = data.budgetPercent >= 100 ? 'danger' : data.budgetPercent >= 80 ? 'warning' : 'primary';
  const level = intensityLevel(data.personalizationIntensity);

  return (
    <>
      <div className="stat-grid">
        <Stat label="Preguntas hoy" value={fmtInt(data.questionsToday)} hint={fmtDay(data.day)} />
        <Stat label="Con cobertura" value={fmtPercent(data.coverageRate)} hint="respuestas con notas de El País" />
        <Stat label="Latencia p95" value={fmtMs(data.latencyP95Ms)} />
        <Stat
          label="Costo del día"
          value={fmtUsd(data.costTodayUsd)}
          tone={budgetTone}
          hint={`${fmtPercentValue(data.budgetPercent)} de ${fmtUsd(data.dailyBudgetUsd)} de presupuesto`}
        >
          <Progress percent={data.budgetPercent} label="Consumo del presupuesto diario" />
        </Stat>
        <Stat label="Bloqueos" value={fmtInt(data.blockedToday)} tone={data.blockedToday > 0 ? 'warning' : undefined} hint="guardrails hoy" />
        <Stat label="Personalizadas" value={fmtInt(data.personalizedToday)} hint="respuestas adaptadas hoy" />
        <Stat label="Caché" value={fmtPercent(data.cachedRate)} hint="respuestas servidas desde caché" />
      </div>

      <div className="grid-2">
        <SyncStatusCard run={data.lastSync} corpusVersion={data.corpusVersion} />

        <Card title="Alertas activas" description="Condiciones que requieren atención.">
          {data.alerts.length === 0 ? (
            <p className="text-success">Sin alertas activas.</p>
          ) : (
            <ul className="alerts">
              {data.alerts.map((alert, index) => (
                <li key={`${index}-${alert}`} className="alerts__item">
                  {alert}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Estado del servicio" description="Interruptores globales y personalización.">
        <div className="chips-row">
          <Chip tone={data.serviceEnabled ? 'success' : 'danger'}>{data.serviceEnabled ? 'Servicio habilitado' : 'Servicio pausado'}</Chip>
          <Chip tone={data.personalizationEnabled ? 'success' : 'neutral'}>
            {data.personalizationEnabled ? 'Personalización habilitada' : 'Personalización apagada'}
          </Chip>
          <Chip tone={level === 3 ? 'warning' : 'neutral'}>
            Intensidad {data.personalizationIntensity} · {LEVEL_LABELS[level] ?? ''}
          </Chip>
          {data.autoLowered && <Chip tone="danger">Auto-bajada activa</Chip>}
        </div>
        <div className="btn-row">
          <Link className="btn btn--small" to="/configuracion">
            Kill switches y configuración
          </Link>
          <Link className="btn btn--small" to="/personalizacion">
            Ajustar personalización
          </Link>
          <Link className="btn btn--small" to="/costos">
            Costos y presupuesto
          </Link>
          <Link className="btn btn--small" to="/guardrails">
            Guardrails
          </Link>
        </div>
      </Card>
    </>
  );
}

export default function InicioPage() {
  const api = useApi();
  const { data, loading, error, reload } = useAsync(() => api.overview(), [api]);

  return (
    <div className="page">
      <PageHeader
        title="Inicio"
        description="Estado general del servicio: volumen, cobertura, costo del día y alertas."
        onRefresh={reload}
        refreshing={loading}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && <Overview data={data} />}
    </div>
  );
}
