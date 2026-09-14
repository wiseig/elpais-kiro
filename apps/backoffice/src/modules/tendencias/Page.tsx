import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrendingItem } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { csvFilename, downloadCsv, toCsv } from '../../shared/csv';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Table, type Column } from '../../shared/components/Table';
import { Bars, recordToBars } from '../../shared/components/Bars';
import { Chip } from '../../shared/components/Chip';
import { DaysSelector } from '../../shared/components/Tabs';
import { Modal } from '../../shared/components/Modal';
import { Field } from '../../shared/components/Field';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDateTime, fmtInt, fmtPercent } from '../../shared/format';

function coverageTone(rate: number): 'success' | 'warning' | 'danger' {
  if (rate >= 0.8) return 'success';
  if (rate >= 0.5) return 'warning';
  return 'danger';
}

function buildColumns(showCoverage: boolean): Column<TrendingItem>[] {
  const columns: Column<TrendingItem>[] = [
    {
      key: 'question',
      header: 'Pregunta (normalizada)',
      render: (row) => (
        <div>
          <div>{row.questionNormalized}</div>
          {row.sample && row.sample !== row.questionNormalized && <div className="muted small">ej.: {row.sample}</div>}
        </div>
      ),
    },
    { key: 'count', header: 'Veces', align: 'right', render: (row) => <strong>{fmtInt(row.count)}</strong> },
  ];
  if (showCoverage) {
    columns.push({
      key: 'coverage',
      header: 'Cobertura',
      align: 'center',
      render: (row) => <Chip tone={coverageTone(row.coverageRate)}>{fmtPercent(row.coverageRate, 0)}</Chip>,
    });
  }
  columns.push(
    {
      key: 'channels',
      header: 'Canales',
      render: (row) => (
        <span className="chips-row chips-row--tight">
          {row.channels.map((channel) => (
            <Chip key={channel}>{channel}</Chip>
          ))}
        </span>
      ),
    },
    { key: 'topics', header: 'Temas', render: (row) => (row.topics.length > 0 ? row.topics.join(', ') : <span className="muted">—</span>) },
    { key: 'lastAt', header: 'Última', nowrap: true, render: (row) => fmtDateTime(row.lastAt) },
  );
  return columns;
}

export default function TendenciasPage() {
  const api = useApi();
  const [days, setDays] = useState(7);
  const trending = useAsync(() => api.trending(days, 'all'), [api, days]);
  // Quién recibe el envío: hasta ahora la lista era invisible desde acá.
  const mailing = useAsync(() => api.mailingLists(), [api]);
  const newsroomCount = (mailing.data?.lists.find((list) => list.key === 'redaccion')?.subscriptions ?? []).filter((item) => item.confirmed).length;
  const notice = useNotice();
  const [sendOpen, setSendOpen] = useState(false);
  const [note, setNote] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(true);
  const [sending, setSending] = useState(false);

  const data = trending.data;

  const exportCsv = () => {
    if (!data) return;
    const gapHashes = new Set(data.gaps.map((gap) => gap.qnormHash));
    const rows = data.items.map((item) => [
      item.questionNormalized,
      item.sample,
      item.count,
      Math.round(item.coverageRate * 1000) / 10,
      item.channels.join('|'),
      item.topics.join('|'),
      item.lastAt,
      gapHashes.has(item.qnormHash) ? 'sí' : 'no',
    ]);
    downloadCsv(
      csvFilename(`tendencias-${days}d`),
      toCsv(['pregunta_normalizada', 'ejemplo', 'veces', 'cobertura_pct', 'canales', 'temas', 'ultima', 'hueco_editorial'], rows),
    );
  };

  const send = async () => {
    setSending(true);
    try {
      await api.sendTrending({ days, onlyGaps, note: note.trim() || undefined });
      notice.show('success', `Enviado a la redacción (${onlyGaps ? 'solo huecos' : 'todas las tendencias'}, últimos ${days} días).`);
      setSendOpen(false);
      setNote('');
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const sectionBars = recordToBars(data?.bySection);

  return (
    <div className="page">
      <PageHeader
        title="Tendencias y huecos"
        description="Preguntas más frecuentes (normalizadas) y las que quedan sin cobertura: huecos editoriales para la redacción. Solo cuenta lo que preguntan los lectores: las corridas de control quedan afuera."
        onRefresh={trending.reload}
        refreshing={trending.loading}
        actions={
          <>
            <DaysSelector value={days} onChange={setDays} />
            <button type="button" className="btn" onClick={exportCsv} disabled={!data || data.items.length === 0}>
              Exportar CSV
            </button>
            <button type="button" className="btn btn--primary" onClick={() => setSendOpen(true)} disabled={!data}>
              Enviar a la redacción
            </button>
          </>
        }
      />
      <Notice notice={notice.notice} onClose={notice.clear} />
      {trending.error && <ErrorBox error={trending.error} onRetry={trending.reload} />}
      {trending.loading && !data && <Spinner />}

      {data && (
        <>
          <Card
            tone="danger"
            title={`Huecos editoriales (${fmtInt(data.gaps.length)})`}
            description="Preguntas frecuentes que el asistente no pudo responder con notas de El País. Candidatas a cobertura."
          >
            <Table columns={buildColumns(true)} rows={data.gaps} rowKey={(row) => row.qnormHash} emptyText="Sin huecos en el período. 🎉" dense maxHeight={360} />
          </Card>

          <div className="grid-2 grid-2--wide-left">
            <Card title={`Preguntas más frecuentes (${fmtInt(data.items.length)})`} description={`Últimos ${data.days} días.`}>
              <Table columns={buildColumns(true)} rows={data.items} rowKey={(row) => row.qnormHash} emptyText="Sin preguntas en el período." dense maxHeight="60vh" />
            </Card>
            <Card title="Por sección" description="Distribución de las preguntas según la sección de las notas citadas.">
              <Bars items={sectionBars} maxItems={20} />
            </Card>
          </div>
        </>
      )}

      <Modal
        open={sendOpen}
        title="Enviar a la redacción"
        onClose={() => setSendOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setSendOpen(false)} disabled={sending}>
              Cancelar
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void send()} disabled={sending}>
              {sending ? 'Enviando…' : 'Enviar'}
            </button>
          </>
        }
      >
        <p className="muted">
          Se manda por mail el resumen de los últimos {days} días a la lista <strong>Redacción</strong>.{' '}
          {mailing.data ? (
            newsroomCount > 0 ? (
              <>
                Hoy la reciben {fmtInt(newsroomCount)} {newsroomCount === 1 ? 'dirección' : 'direcciones'}.
              </>
            ) : (
              <strong>Hoy no la recibe nadie: el envío no le llega a ninguna dirección.</strong>
            )
          ) : null}{' '}
          <Link to="/notificaciones">Ver o cambiar quién está en la lista</Link>.
        </p>
        <label className="check">
          <input type="checkbox" checked={onlyGaps} onChange={(event) => setOnlyGaps(event.target.checked)} />
          <span>Solo huecos editoriales ({data ? fmtInt(data.gaps.length) : '—'})</span>
        </label>
        <Field label="Nota para la redacción (opcional)">
          <textarea className="input" rows={4} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Contexto, prioridades, a quién va dirigido…" />
        </Field>
      </Modal>
    </div>
  );
}
