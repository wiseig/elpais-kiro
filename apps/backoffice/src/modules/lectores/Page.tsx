import { useState } from 'react';
import type { CohortMetrics, ReaderDetail, ReaderListItem, ReadersSummary, QuestionListItem } from '@pelp/domain/api';
import { frameById, type Cohort } from '@pelp/domain';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { csvFilename, downloadCsv, toCsv, type CsvCell } from '../../shared/csv';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Stat } from '../../shared/components/Stat';
import { Bars, ColumnChart, recordToBars } from '../../shared/components/Bars';
import { Table, type Column } from '../../shared/components/Table';
import { Tabs, DaysSelector } from '../../shared/components/Tabs';
import { Field } from '../../shared/components/Field';
import { Chip } from '../../shared/components/Chip';
import { Modal } from '../../shared/components/Modal';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { JsonView } from '../../shared/components/JsonView';
import { Empty } from '../../shared/components/Empty';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDateTime, fmtInt, fmtNumber, fmtPercent, fmtUsd, truncate, fmtMs } from '../../shared/format';

type Tab = 'agregado' | 'individual';

const TABS: { key: Tab; label: string }[] = [
  { key: 'agregado', label: 'Agregado' },
  { key: 'individual', label: 'Individual (solo admin, acceso auditado)' },
];

const MODE_LABELS: Record<string, string> = {
  personalized: 'Personalizado',
  neutral: 'Neutral',
  undecided: 'Sin decidir',
};

function frameLabel(id: string): string {
  return frameById(id)?.label ?? id;
}

function modeLabel(id: string): string {
  return MODE_LABELS[id] ?? id;
}

/* ------------------------------ Agregado -------------------------------- */

interface CohortRow {
  key: keyof CohortMetrics;
  label: string;
  format: (value: number) => string;
}

const COHORT_ROWS: CohortRow[] = [
  { key: 'readers', label: 'Lectores', format: fmtInt },
  { key: 'questions', label: 'Preguntas', format: fmtInt },
  { key: 'followUpRate', label: 'Tasa de repregunta', format: (v) => fmtPercent(v) },
  { key: 'clicks', label: 'Clics en fuentes', format: fmtInt },
  { key: 'thumbsUp', label: '👍', format: fmtInt },
  { key: 'thumbsDown', label: '👎', format: fmtInt },
  { key: 'sessionsPerReader', label: 'Sesiones por lector', format: (v) => fmtNumber(v, 2) },
];

const COHORTS: { key: Cohort; label: string }[] = [
  { key: 'personalized', label: 'Personalizada' },
  { key: 'control', label: 'Control' },
];

function cohortCell(metrics: CohortMetrics | undefined, row: CohortRow, k: number): string {
  if (!metrics) return '—';
  if (metrics.readers > 0 && metrics.readers < k) return `oculto (< ${k})`;
  return row.format(metrics[row.key]);
}

function CrossTable({ data }: { data: Record<string, Record<string, number>> }) {
  const topics = Object.keys(data).sort();
  const frames = Array.from(new Set(topics.flatMap((topic) => Object.keys(data[topic] ?? {})))).sort();
  if (topics.length === 0 || frames.length === 0) return <Empty text="Sin cruces con suficientes lectores." />;
  return (
    <div className="table-wrap" style={{ maxHeight: 420 }}>
      <table className="table table--dense table--matrix">
        <thead>
          <tr>
            <th scope="col">Tema \ Encuadre</th>
            {frames.map((frame) => (
              <th key={frame} scope="col" title={frame}>
                {frameLabel(frame)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {topics.map((topic) => (
            <tr key={topic}>
              <th scope="row">{topic}</th>
              {frames.map((frame) => {
                const value = data[topic]?.[frame] ?? 0;
                return (
                  <td key={frame} className={value > 0 ? 'matrix__cell matrix__cell--on' : 'matrix__cell'}>
                    {value > 0 ? fmtInt(value) : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summaryToCsv(summary: ReadersSummary): string {
  const rows: CsvCell[][] = [];
  const push = (dimension: string, record: Record<string, number>, labelOf: (key: string) => string = (key) => key) => {
    for (const [key, value] of Object.entries(record)) rows.push([dimension, key, labelOf(key), value]);
  };
  push('canal', summary.byChannel);
  push('modo', summary.byMode, modeLabel);
  push('tema', summary.topics);
  push('encuadre', summary.frames, frameLabel);
  push('estilo', summary.style);
  push('orientacion', summary.politicalLean);
  for (const week of summary.weekly) {
    rows.push(['semana_lectores', week.week, week.week, week.readers]);
    rows.push(['semana_preguntas', week.week, week.week, week.questions]);
  }
  for (const cohort of COHORTS) {
    const metrics = summary.cohorts[cohort.key];
    for (const row of COHORT_ROWS) rows.push([`cohorte_${cohort.key}`, row.key, row.label, metrics ? metrics[row.key] : '']);
  }
  for (const [topic, frames] of Object.entries(summary.frameByTopic)) {
    for (const [frame, value] of Object.entries(frames)) rows.push(['encuadre_x_tema', `${topic}|${frame}`, `${topic} × ${frameLabel(frame)}`, value]);
  }
  return toCsv(['dimension', 'clave', 'etiqueta', 'valor'], rows);
}

function Aggregate({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  const api = useApi();
  const [days, setDays] = useState(30);
  const summary = useAsync(() => api.readersSummary(days), [api, days]);
  const data = summary.data;

  return (
    <>
      <PageHeader
        title="Lectores"
        description={`Panel agregado de perfiles: temas, encuadres, estilo y orientación. Ninguna celda con menos de ${data?.k ?? 20} lectores se muestra.`}
        onRefresh={summary.reload}
        refreshing={summary.loading}
        actions={
          <>
            <DaysSelector value={days} onChange={setDays} options={[7, 30, 90]} />
            <button
              type="button"
              className="btn"
              onClick={() => data && downloadCsv(csvFilename(`lectores-agregado-${days}d`), summaryToCsv(data))}
              disabled={!data}
            >
              Exportar CSV agregado
            </button>
          </>
        }
      />
      <Tabs items={TABS} value={tab} onChange={onTab} />
      {summary.error && <ErrorBox error={summary.error} onRetry={summary.reload} />}
      {summary.loading && !data && <Spinner />}
      {data && (
        <>
          <div className="stat-grid">
            <Stat label="Lectores" value={fmtInt(data.readers)} hint={`últimos ${data.days} días`} />
            <Stat label="Umbral k-anonimato" value={fmtInt(data.k)} hint="mínimo de lectores por celda" />
            {COHORTS.map((cohort) => (
              <Stat key={cohort.key} label={`Cohorte ${cohort.label.toLowerCase()}`} value={cohortCell(data.cohorts[cohort.key], COHORT_ROWS[0] as CohortRow, data.k)} hint="lectores" />
            ))}
          </div>

          <div className="grid-3">
            <Card title="Por canal">
              <Bars items={recordToBars(data.byChannel)} />
            </Card>
            <Card title="Por modo">
              <Bars items={recordToBars(data.byMode, modeLabel)} />
            </Card>
            <Card title="Orientación (genérica, sin partidos)">
              <Bars items={recordToBars(data.politicalLean)} tone="neutral" />
            </Card>
          </div>

          <div className="grid-3">
            <Card title="Temas">
              <Bars items={recordToBars(data.topics)} maxItems={18} />
            </Card>
            <Card title="Encuadres">
              <Bars items={recordToBars(data.frames, frameLabel)} maxItems={16} />
            </Card>
            <Card title="Estilo">
              <Bars items={recordToBars(data.style)} />
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Evolución semanal · lectores">
              <ColumnChart items={data.weekly.map((week) => ({ key: week.week, label: week.week.slice(-5), value: week.readers, title: `${week.week}: ${fmtInt(week.readers)} lectores` }))} />
            </Card>
            <Card title="Evolución semanal · preguntas">
              <ColumnChart
                tone="neutral"
                items={data.weekly.map((week) => ({ key: week.week, label: week.week.slice(-5), value: week.questions, title: `${week.week}: ${fmtInt(week.questions)} preguntas` }))}
              />
            </Card>
          </div>

          <Card title="Cohortes: personalizada vs. control" description={`Medición de enganche (9.7). Las celdas con menos de ${data.k} lectores se ocultan.`}>
            <div className="table-wrap">
              <table className="table table--dense">
                <thead>
                  <tr>
                    <th scope="col">Métrica</th>
                    {COHORTS.map((cohort) => (
                      <th key={cohort.key} scope="col" style={{ textAlign: 'right' }}>
                        {cohort.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COHORT_ROWS.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{row.label}</th>
                      {COHORTS.map((cohort) => (
                        <td key={cohort.key} style={{ textAlign: 'right' }}>
                          {cohortCell(data.cohorts[cohort.key], row, data.k)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Encuadre × tema" description="Cruce de encuadres por tema (solo celdas con suficientes lectores).">
            <CrossTable data={data.frameByTopic} />
          </Card>
        </>
      )}
    </>
  );
}

/* ----------------------------- Individual ------------------------------- */

const QUESTION_COLUMNS: Column<QuestionListItem>[] = [
  { key: 'at', header: 'Fecha', nowrap: true, render: (row) => fmtDateTime(row.at) },
  { key: 'channel', header: 'Canal', render: (row) => row.channel },
  { key: 'question', header: 'Pregunta', render: (row) => <span title={row.questionMasked}>{truncate(row.questionMasked, 100)}</span> },
  { key: 'coverage', header: 'Cobertura', align: 'center', render: (row) => (row.hadCoverage ? 'Sí' : 'No') },
  { key: 'personalized', header: 'Pers.', align: 'center', render: (row) => (row.personalized ? 'Sí' : 'No') },
  { key: 'latency', header: 'Latencia', align: 'right', render: (row) => fmtMs(row.latencyMs) },
  { key: 'cost', header: 'Costo', align: 'right', render: (row) => fmtUsd(row.costUsd, true) },
];

function ReaderDetailView({ detail }: { detail: ReaderDetail }) {
  return (
    <div className="detail">
      <section>
        <div className="chips-row">
          <Chip>{detail.reader.channel}</Chip>
          <Chip tone={detail.reader.mode === 'personalized' ? 'primary' : 'neutral'}>{modeLabel(detail.reader.mode)}</Chip>
          <Chip>{fmtInt(detail.reader.questionCount)} preguntas</Chip>
          <Chip>última actividad {fmtDateTime(detail.reader.lastActivityAt)}</Chip>
        </div>
        {detail.reader.summary && <p className="detail__question">{detail.reader.summary}</p>}
      </section>
      <section>
        <h3 className="h3">Perfil actual</h3>
        <JsonView value={detail.profile} maxHeight={360} />
      </section>
      <section>
        <h3 className="h3">Versiones del perfil ({detail.profileVersions.length})</h3>
        {detail.profileVersions.length === 0 ? (
          <Empty text="Sin versiones anteriores." />
        ) : (
          detail.profileVersions.map((version, index) => (
            <details key={`${version.at}-${index}`} className="details">
              <summary>{fmtDateTime(version.at)}</summary>
              <JsonView value={version.profile} maxHeight={300} />
            </details>
          ))
        )}
      </section>
      <section>
        <h3 className="h3">Consentimientos ({detail.consents.length})</h3>
        <Table
          dense
          columns={[
            { key: 'at', header: 'Fecha', nowrap: true, render: (row) => fmtDateTime(row.at) },
            { key: 'decision', header: 'Decisión', render: (row) => <Chip tone={row.decision === 'delete' ? 'danger' : 'neutral'}>{row.decision}</Chip> },
            { key: 'channel', header: 'Canal', render: (row) => row.channel },
            { key: 'textVersion', header: 'Versión del texto', render: (row) => <code>{truncate(row.textVersion, 16)}</code> },
          ]}
          rows={detail.consents}
          rowKey={(row, index) => `${row.at}-${index}`}
          emptyText="Sin consentimientos registrados."
        />
      </section>
      <section>
        <h3 className="h3">Preguntas ({detail.questions.length})</h3>
        <Table dense columns={QUESTION_COLUMNS} rows={detail.questions} rowKey={(row) => row.msgId} emptyText="Sin preguntas registradas." maxHeight={360} />
      </section>
    </div>
  );
}

function ReaderDrawer({ readerId, onClose, onDeleted }: { readerId: string; onClose: () => void; onDeleted: (readerId: string) => void }) {
  const api = useApi();
  const detail = useAsync(() => api.reader(readerId), [api, readerId]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const notice = useNotice();

  const remove = async (reason: string) => {
    setDeleting(true);
    try {
      await api.deleteReader(readerId, { reason });
      setConfirmOpen(false);
      onDeleted(readerId);
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Modal
        open
        side
        size="xl"
        title={
          <>
            Lector <code>{readerId}</code>
          </>
        }
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cerrar
            </button>
            <button type="button" className="btn btn--danger" onClick={() => setConfirmOpen(true)} disabled={!detail.data}>
              Borrar perfil
            </button>
          </>
        }
      >
        <Notice notice={notice.notice} onClose={notice.clear} />
        <p className="notice notice--warning">Este acceso quedó registrado en la auditoría con tu usuario.</p>
        {detail.loading && !detail.data && <Spinner />}
        {detail.error && <ErrorBox error={detail.error} onRetry={detail.reload} />}
        {detail.data && <ReaderDetailView detail={detail.data} />}
      </Modal>
      <ConfirmDialog
        open={confirmOpen}
        title="Borrar perfil del lector"
        danger
        busy={deleting}
        confirmLabel="Borrar definitivamente"
        reason="required"
        message={
          <>
            Se eliminan el perfil, sus versiones, las identidades de canal y las preguntas asociadas. Queda una lápida anónima de consentimiento.
            Esta acción no se puede deshacer.
          </>
        }
        onConfirm={(reason) => void remove(reason)}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

function Individual({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  const api = useApi();
  const [channel, setChannel] = useState('');
  const [limit, setLimit] = useState(100);
  const list = useAsync(() => api.readers(channel.trim() || undefined, limit), [api, channel, limit]);
  const [selected, setSelected] = useState<string | null>(null);
  const notice = useNotice();

  const columns: Column<ReaderListItem>[] = [
    { key: 'readerId', header: 'Lector', render: (row) => <code>{truncate(row.readerId, 18)}</code> },
    { key: 'channel', header: 'Canal', render: (row) => <Chip>{row.channel}</Chip> },
    { key: 'mode', header: 'Modo', render: (row) => modeLabel(row.mode) },
    { key: 'questionCount', header: 'Preguntas', align: 'right', render: (row) => fmtInt(row.questionCount) },
    { key: 'lastActivityAt', header: 'Última actividad', nowrap: true, render: (row) => fmtDateTime(row.lastActivityAt) },
    { key: 'summary', header: 'Resumen', render: (row) => <span title={row.summary}>{truncate(row.summary, 120) || <span className="muted">—</span>}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Lectores"
        description="Lista individual de lectores seudónimos. Cada acceso queda auditado. Sin exportación individual."
        onRefresh={list.reload}
        refreshing={list.loading}
      />
      <Tabs items={TABS} value={tab} onChange={onTab} />
      <Notice notice={notice.notice} onClose={notice.clear} />
      <div className="notice notice--warning" role="note">
        <strong>Acceso restringido y auditado.</strong> Cada lista y cada detalle que abrís se registran en la auditoría con tu usuario. Usalo solo para
        atender pedidos de lectores (borrado, revisión de perfil).
      </div>
      <Card title="Filtros">
        <div className="filters">
          <Field label="Canal">
            <input className="input" value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="todos (web, whatsapp, discord)" />
          </Field>
          <Field label="Límite">
            <select className="input" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </Field>
        </div>
      </Card>
      <Card title={list.data ? `Lectores (${fmtInt(list.data.items.length)})` : 'Lectores'}>
        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.loading && !list.data && <Spinner />}
        {list.data && (
          <Table columns={columns} rows={list.data.items} rowKey={(row) => row.readerId} onRowClick={(row) => setSelected(row.readerId)} emptyText="Sin lectores." dense maxHeight="60vh" />
        )}
      </Card>
      {selected && (
        <ReaderDrawer
          readerId={selected}
          onClose={() => setSelected(null)}
          onDeleted={(readerId) => {
            list.setData((current) => (current ? { items: current.items.filter((item) => item.readerId !== readerId) } : current));
            setSelected(null);
            notice.show('success', `Perfil ${truncate(readerId, 18)} borrado.`);
          }}
        />
      )}
    </>
  );
}

export default function LectoresPage() {
  const [tab, setTab] = useState<Tab>('agregado');
  return <div className="page">{tab === 'agregado' ? <Aggregate tab={tab} onTab={setTab} /> : <Individual tab={tab} onTab={setTab} />}</div>;
}
