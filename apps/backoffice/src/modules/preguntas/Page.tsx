import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { QuestionDetail, QuestionListItem, QuestionsQuery } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Field, Toggle } from '../../shared/components/Field';
import { Table, type Column } from '../../shared/components/Table';
import { Modal } from '../../shared/components/Modal';
import { Chip, BoolChip } from '../../shared/components/Chip';
import { Empty } from '../../shared/components/Empty';
import { VerdictView } from '../../shared/components/Verdict';
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
  includeControl: boolean;
}

const DEFAULT_FILTERS: Filters = { day: '', days: '7', channel: '', coverage: '', personalized: '', q: '', limit: '100', includeControl: false };

function toQuery(filters: Filters): QuestionsQuery {
  return {
    day: filters.day || undefined,
    days: filters.day ? undefined : filters.days ? Number(filters.days) : undefined,
    channel: filters.channel.trim() || undefined,
    coverage: filters.coverage || undefined,
    personalized: filters.personalized || undefined,
    q: filters.q.trim() || undefined,
    limit: Number(filters.limit) || undefined,
    ...(filters.includeControl ? { includeControl: 'yes' as const } : {}),
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

/** Celda de la ficha técnica: rótulo arriba, valor abajo, con aire propio. */
function MetaCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="meta__cell">
      <span className="meta__label">{label}</span>
      <span className="meta__value">{children}</span>
    </div>
  );
}

function DetailView({ detail }: { detail: QuestionDetail }) {
  const { log } = detail;
  return (
    <div className="detail">
      <section className="detail__ask">
        <p className="detail__question">{log.questionMasked}</p>
        {log.questionNormalized && (
          <p className="muted small">
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
      </section>

      <section>
        <h3 className="h3">Ficha técnica</h3>
        <div className="meta">
          <MetaCell label="Modelo">
            <code>{log.model}</code>
          </MetaCell>
          <MetaCell label="Latencia">{fmtMs(log.latencyMs)}</MetaCell>
          <MetaCell label="Costo">{fmtUsd(log.costUsd, true)}</MetaCell>
          <MetaCell label="Grounding">{log.groundingScore !== undefined ? fmtNumber(log.groundingScore, 2) : '—'}</MetaCell>
          <MetaCell label="Relevancia">{log.relevanceScore !== undefined ? fmtNumber(log.relevanceScore, 2) : '—'}</MetaCell>
          <MetaCell label="Tokens usados">
            {fmtTokens(log.usage.inputTokens)} entrada · {fmtTokens(log.usage.outputTokens)} salida
            {log.usage.cacheReadTokens > 0 ? ` · ${fmtTokens(log.usage.cacheReadTokens)} caché` : ''}
          </MetaCell>
        </div>
        <dl className="kv meta-ids">
          <dt>Temas</dt>
          <dd>{log.topics.length > 0 ? log.topics.join(' · ') : <span className="muted">sin temas detectados</span>}</dd>
          <dt>Versión del corpus</dt>
          <dd>
            <code>{log.corpusVersion}</code>
          </dd>
          <dt>Lector</dt>
          <dd>
            {log.readerId ? (
              <Link to={`/lectores?lector=${encodeURIComponent(log.readerId)}`}>
                Ver el lector <code>{log.readerId}</code> →
              </Link>
            ) : (
              <span className="muted">Modo neutral: la pregunta no queda atada a nadie.</span>
            )}
          </dd>
          <dt>Conversación</dt>
          <dd>
            <code>{log.convId}</code>
          </dd>
          <dt>Mensaje</dt>
          <dd>
            <code>{log.msgId}</code>
          </dd>
        </dl>
      </section>

      {log.feedback && (
        <section>
          <h3 className="h3">Feedback del lector</h3>
          <p>
            {log.feedback.vote === 'up' ? '👍 Útil' : '👎 No útil'} <span className="muted">· {fmtDateTime(log.feedback.at)}</span>
          </p>
          {log.feedback.comment && <blockquote className="quote">{log.feedback.comment}</blockquote>}
        </section>
      )}

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

      {log.unverifiedAnswer && (
        <section>
          <h3 className="h3">Resumen descartado por falta de sustento</h3>
          <p className="muted small">
            El modelo escribió esto, el guardrail de Bedrock no pudo respaldarlo contra las notas y el lector recibió, en
            su lugar, las fuentes para leerlas completas. Sirve para ver qué afirmación se fue de los fragmentos.
          </p>
          <div className="answer answer--rejected">{log.unverifiedAnswer}</div>
        </section>
      )}

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
        <p className="muted small">
          Cuando una respuesta se adapta al perfil del lector, un segundo modelo compara la adaptada contra la
          canónica y solo la deja pasar si dicen exactamente los mismos hechos. Esto es lo que encontró.
        </p>
        {detail.verifier === undefined || detail.verifier === null ? (
          <Empty text="Sin veredicto: esta respuesta no se adaptó, se sirvió la canónica." />
        ) : (
          <VerdictView verdict={detail.verifier} />
        )}
      </section>
    </div>
  );
}

function QuestionDrawer({
  item,
  onClose,
  onMarkedChange,
}: {
  item: QuestionListItem;
  onClose: () => void;
  onMarkedChange: (msgId: string, marked: boolean) => void;
}) {
  const api = useApi();
  const detail = useAsync(() => api.question(item.msgId), [api, item.msgId]);
  const [busy, setBusy] = useState(false);
  const notice = useNotice();
  const marked = Boolean(item.evalMarked || detail.data?.log.evalMarked);

  const toggleEval = async () => {
    setBusy(true);
    try {
      if (marked) {
        await api.unmarkEval(item.msgId);
        notice.show('success', 'La pregunta salió del set de evaluación.');
        onMarkedChange(item.msgId, false);
      } else {
        const result = await api.markEval(item.msgId);
        notice.show('success', `Agregada al set de evaluación (caso ${result.caseId}).`);
        onMarkedChange(item.msgId, true);
      }
      detail.reload();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusy(false);
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
          <p className="drawer-help small muted">
            {marked
              ? 'Está en el set de evaluación: se corre todas las noches y avisa si la respuesta cambia de cobertura o de fuentes.'
              : 'Agregarla al set de evaluación guarda esta pregunta con sus fuentes actuales como respuesta esperada. Se corre todas las noches para avisar si algo se rompe.'}
          </p>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cerrar
          </button>
          <button
            type="button"
            className={marked ? 'btn btn--danger-outline' : 'btn btn--primary'}
            onClick={() => void toggleEval()}
            disabled={busy}
          >
            {busy ? 'Guardando…' : marked ? 'Sacar del set de evaluación' : 'Agregar al set de evaluación'}
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

  const onMarkedChange = (msgId: string, marked: boolean) => {
    list.setData((current) =>
      current ? { ...current, items: current.items.map((item) => (item.msgId === msgId ? { ...item, evalMarked: marked } : item)) } : current,
    );
    setSelected((current) => (current && current.msgId === msgId ? { ...current, evalMarked: marked } : current));
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
          {row.isControl && (
            <>
              {' '}
              <Chip>control</Chip>
            </>
          )}
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
          <Field label="Texto" className="filters__wide">
            <input className="input" type="search" value={draft.q} onChange={(event) => update('q', event.target.value)} placeholder="Buscar en la pregunta" />
          </Field>
          <Field label="Últimos N días" hint={draft.day ? 'Se ignora si elegís un día.' : undefined}>
            <select className="input" value={draft.days} onChange={(event) => update('days', event.target.value)} disabled={Boolean(draft.day)}>
              <option value="1">1 día</option>
              <option value="7">7 días</option>
              <option value="30">30 días</option>
              <option value="90">90 días</option>
            </select>
          </Field>
          <Field label="Día">
            <input className="input" type="date" value={draft.day} onChange={(event) => update('day', event.target.value)} />
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
          <Field label="Límite">
            <select className="input" value={draft.limit} onChange={(event) => update('limit', event.target.value)}>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="500">500</option>
            </select>
          </Field>
          <div className="filters__actions">
            <Toggle
              checked={draft.includeControl}
              onChange={(next) => {
                const updated = { ...draft, includeControl: next };
                setDraft(updated);
                setFilters(updated);
              }}
              label="Incluir preguntas de control"
            />
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

      <Card
        title={list.data ? `Resultados (${fmtInt(list.data.items.length)})` : 'Resultados'}
        description={
          list.data && list.data.controlExcluded > 0
            ? `Se ocultaron ${fmtInt(list.data.controlExcluded)} preguntas de control: las del set dorado, que el smoke test dispara contra la API en cada despliegue.`
            : undefined
        }
      >
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

      {selected && <QuestionDrawer item={selected} onClose={() => setSelected(null)} onMarkedChange={onMarkedChange} />}
    </div>
  );
}
