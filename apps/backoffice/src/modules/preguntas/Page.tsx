import { useState, type FormEvent } from 'react';
import type { QuestionDetail, QuestionListItem, QuestionsQuery } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Field } from '../../shared/components/Field';
import { Table, type Column } from '../../shared/components/Table';
import { Modal } from '../../shared/components/Modal';
import { Chip, BoolChip } from '../../shared/components/Chip';
import { Empty } from '../../shared/components/Empty';
import { JsonView } from '../../shared/components/JsonView';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDate, fmtDateTime, fmtInt, fmtMs, fmtNumber, fmtTokens, fmtUsd, truncate } from '../../shared/format';

type YesNo = '' | 'yes' | 'no';

interface Filters {
  day: string;
  days: string;
  channel: string;
  coverage: YesNo;
  personalized: YesNo;
  q: string;
  limit: string;
}

const DEFAULT_FILTERS: Filters = { day: '', days: '7', channel: '', coverage: '', personalized: '', q: '', limit: '100' };

function toQuery(filters: Filters): QuestionsQuery {
  return {
    day: filters.day || undefined,
    days: filters.day ? undefined : filters.days ? Number(filters.days) : undefined,
    channel: filters.channel.trim() || undefined,
    coverage: filters.coverage || undefined,
    personalized: filters.personalized || undefined,
    q: filters.q.trim() || undefined,
    limit: Number(filters.limit) || undefined,
  };
}

function Feedback({ item }: { item: QuestionListItem }) {
  if (!item.feedback) return <span className="muted">—</span>;
  const icon = item.feedback.vote === 'up' ? '👍' : '👎';
  return (
    <span title={item.feedback.comment ? `${icon} ${item.feedback.comment}` : undefined}>
      {icon}
      {item.feedback.comment ? ' 💬' : ''}
    </span>
  );
}

function AnswerText({ text }: { text: string }) {
  return <div className="answer">{text}</div>;
}

function DetailView({ detail }: { detail: QuestionDetail }) {
  const { log } = detail;
  return (
    <div className="detail">
      <section>
        <h3 className="h3">Pregunta</h3>
        <p className="detail__question">{log.questionMasked}</p>
        {log.questionNormalized && (
          <p className="muted">
            Normalizada: <code>{log.questionNormalized}</code>
          </p>
        )}
        <div className="chips-row">
          <Chip>{log.channel}</Chip>
          <Chip>{fmtDateTime(log.at)}</Chip>
          <Chip>turno {log.turn}</Chip>
          <Chip tone={log.hadCoverage ? 'success' : 'warning'}>{log.hadCoverage ? 'con cobertura' : 'sin cobertura'}</Chip>
          {log.personalized && <Chip tone="primary">personalizada</Chip>}
          {log.cohort && <Chip>cohorte {log.cohort}</Chip>}
          {log.cached && <Chip>caché</Chip>}
          {log.blocked && <Chip tone="danger">bloqueada: {log.blocked}</Chip>}
          {log.evalMarked && <Chip tone="primary">en set de evaluación</Chip>}
        </div>
        <dl className="kv kv--compact">
          <dt>Modelo</dt>
          <dd>
            <code>{log.model}</code>
          </dd>
          <dt>Latencia</dt>
          <dd>{fmtMs(log.latencyMs)}</dd>
          <dt>Costo</dt>
          <dd>{fmtUsd(log.costUsd, true)}</dd>
          <dt>Tokens</dt>
          <dd>
            {fmtTokens(log.usage.inputTokens)} entrada · {fmtTokens(log.usage.outputTokens)} salida
            {log.usage.cacheReadTokens > 0 ? ` · ${fmtTokens(log.usage.cacheReadTokens)} caché` : ''}
          </dd>
          <dt>Grounding / relevancia</dt>
          <dd>
            {log.groundingScore !== undefined ? fmtNumber(log.groundingScore, 2) : '—'} / {log.relevanceScore !== undefined ? fmtNumber(log.relevanceScore, 2) : '—'}
          </dd>
          <dt>Corpus</dt>
          <dd>
            <code>{log.corpusVersion}</code>
          </dd>
          <dt>Conversación</dt>
          <dd>
            <code>{log.convId}</code>
          </dd>
          {log.topics.length > 0 && (
            <>
              <dt>Temas</dt>
              <dd>{log.topics.join(', ')}</dd>
            </>
          )}
          {log.feedback && (
            <>
              <dt>Feedback</dt>
              <dd>
                {log.feedback.vote === 'up' ? '👍 Útil' : '👎 No útil'} · {fmtDateTime(log.feedback.at)}
                {log.feedback.comment && <blockquote className="quote">{log.feedback.comment}</blockquote>}
              </dd>
            </>
          )}
        </dl>
      </section>

      <div className="split">
        <section>
          <h3 className="h3">Respuesta canónica</h3>
          {log.canonicalAnswer ? <AnswerText text={log.canonicalAnswer} /> : <Empty text="Sin respuesta canónica registrada." />}
        </section>
        <section>
          <h3 className="h3">Respuesta adaptada</h3>
          {detail.adaptedAnswer ? <AnswerText text={detail.adaptedAnswer} /> : <Empty text="No hubo adaptación: se envió la canónica." />}
          {detail.explain && (
            <p className="muted">
              <strong>Por qué veo esto:</strong> {detail.explain}
            </p>
          )}
        </section>
      </div>

      <section>
        <h3 className="h3">Fuentes ({log.sources.length})</h3>
        {log.sources.length === 0 ? (
          <Empty text="Sin fuentes citadas." />
        ) : (
          <ol className="sources">
            {log.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title || source.url}
                </a>
                <span className="muted">
                  {' '}
                  · {source.section} · {fmtDate(source.date)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3 className="h3">Veredicto del verificador</h3>
        {detail.verifier === undefined || detail.verifier === null ? <Empty text="Sin veredicto (no hubo adaptación)." /> : <JsonView value={detail.verifier} />}
      </section>
    </div>
  );
}

function QuestionDrawer({ item, onClose, onMarked }: { item: QuestionListItem; onClose: () => void; onMarked: (msgId: string) => void }) {
  const api = useApi();
  const detail = useAsync(() => api.question(item.msgId), [api, item.msgId]);
  const [marking, setMarking] = useState(false);
  const notice = useNotice();
  const marked = item.evalMarked || detail.data?.log.evalMarked;

  const mark = async () => {
    setMarking(true);
    try {
      const result = await api.markEval(item.msgId);
      notice.show('success', `Marcada para evaluación (caso ${result.caseId}).`);
      onMarked(item.msgId);
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setMarking(false);
    }
  };

  return (
    <Modal
      open
      side
      size="xl"
      title="Detalle de la pregunta"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cerrar
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void mark()} disabled={marking || Boolean(marked)}>
            {marked ? 'Ya está en el set de evaluación' : marking ? 'Marcando…' : 'Marcar para evaluación'}
          </button>
        </>
      }
    >
      <Notice notice={notice.notice} onClose={notice.clear} />
      {detail.loading && !detail.data && <Spinner />}
      {detail.error && <ErrorBox error={detail.error} onRetry={detail.reload} />}
      {detail.data && <DetailView detail={detail.data} />}
    </Modal>
  );
}

export default function PreguntasPage() {
  const api = useApi();
  const [draft, setDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const list = useAsync(() => api.questions(toQuery(filters)), [api, filters]);
  const [selected, setSelected] = useState<QuestionListItem | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters(draft);
  };

  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const onMarked = (msgId: string) => {
    list.setData((current) => (current ? { items: current.items.map((item) => (item.msgId === msgId ? { ...item, evalMarked: true } : item)) } : current));
    setSelected((current) => (current && current.msgId === msgId ? { ...current, evalMarked: true } : current));
  };

  const columns: Column<QuestionListItem>[] = [
    { key: 'at', header: 'Fecha', render: (row) => fmtDateTime(row.at), nowrap: true },
    { key: 'channel', header: 'Canal', render: (row) => <Chip>{row.channel}</Chip> },
    {
      key: 'question',
      header: 'Pregunta',
      render: (row) => (
        <span className="cell-text" title={row.questionMasked}>
          {truncate(row.questionMasked, 110)}
          {row.blocked && (
            <>
              {' '}
              <Chip tone="danger">bloqueada: {row.blocked}</Chip>
            </>
          )}
          {row.cached && (
            <>
              {' '}
              <Chip>caché</Chip>
            </>
          )}
          {row.evalMarked && (
            <>
              {' '}
              <Chip tone="primary">eval</Chip>
            </>
          )}
        </span>
      ),
    },
    { key: 'coverage', header: 'Cobertura', align: 'center', render: (row) => <BoolChip value={row.hadCoverage} yes="Sí" no="No" /> },
    { key: 'sources', header: 'Fuentes', align: 'right', render: (row) => fmtInt(row.sourceCount) },
    {
      key: 'personalized',
      header: 'Personalizada',
      render: (row) =>
        row.personalized ? (
          <Chip tone="primary">Sí{row.cohort ? ` · ${row.cohort}` : ''}</Chip>
        ) : (
          <span className="muted">No{row.cohort === 'control' ? ' · control' : ''}</span>
        ),
    },
    { key: 'latency', header: 'Latencia', align: 'right', nowrap: true, render: (row) => fmtMs(row.latencyMs) },
    { key: 'cost', header: 'Costo', align: 'right', nowrap: true, render: (row) => fmtUsd(row.costUsd, true) },
    { key: 'feedback', header: 'Feedback', align: 'center', render: (row) => <Feedback item={row} /> },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Preguntas"
        description="Log buscable de preguntas (PII enmascarada) con cobertura, fuentes, costo y feedback. Hacé clic en una fila para ver la respuesta."
        onRefresh={list.reload}
        refreshing={list.loading}
      />

      <Card title="Filtros">
        <form className="filters" onSubmit={submit}>
          <Field label="Día">
            <input className="input" type="date" value={draft.day} onChange={(event) => update('day', event.target.value)} />
          </Field>
          <Field label="Últimos N días" hint={draft.day ? 'Se ignora si elegís un día.' : undefined}>
            <select className="input" value={draft.days} onChange={(event) => update('days', event.target.value)} disabled={Boolean(draft.day)}>
              <option value="1">1 día</option>
              <option value="7">7 días</option>
              <option value="30">30 días</option>
              <option value="90">90 días</option>
            </select>
          </Field>
          <Field label="Canal">
            <input className="input" list="channel-options" value={draft.channel} onChange={(event) => update('channel', event.target.value)} placeholder="todos" />
            <datalist id="channel-options">
              <option value="web" />
              <option value="whatsapp" />
              <option value="discord" />
            </datalist>
          </Field>
          <Field label="Cobertura">
            <select className="input" value={draft.coverage} onChange={(event) => update('coverage', event.target.value as YesNo)}>
              <option value="">Todas</option>
              <option value="yes">Con cobertura</option>
              <option value="no">Sin cobertura</option>
            </select>
          </Field>
          <Field label="Personalizada">
            <select className="input" value={draft.personalized} onChange={(event) => update('personalized', event.target.value as YesNo)}>
              <option value="">Todas</option>
              <option value="yes">Sí</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Texto" className="filters__wide">
            <input className="input" type="search" value={draft.q} onChange={(event) => update('q', event.target.value)} placeholder="Buscar en la pregunta" />
          </Field>
          <Field label="Límite">
            <select className="input" value={draft.limit} onChange={(event) => update('limit', event.target.value)}>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="500">500</option>
            </select>
          </Field>
          <div className="filters__actions">
            <button type="submit" className="btn btn--primary">
              Buscar
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setDraft(DEFAULT_FILTERS);
                setFilters(DEFAULT_FILTERS);
              }}
            >
              Limpiar
            </button>
          </div>
        </form>
      </Card>

      <Card title={list.data ? `Resultados (${fmtInt(list.data.items.length)})` : 'Resultados'}>
        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.loading && !list.data && <Spinner />}
        {list.data && (
          <Table
            columns={columns}
            rows={list.data.items}
            rowKey={(row) => row.msgId}
            onRowClick={setSelected}
            emptyText="No hay preguntas con esos filtros."
            maxHeight="65vh"
            dense
          />
        )}
      </Card>

      {selected && <QuestionDrawer item={selected} onClose={() => setSelected(null)} onMarked={onMarked} />}
    </div>
  );
}
