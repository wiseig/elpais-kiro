import { useState } from 'react';
import type { EvalCaseInput } from '@pelp/domain/api';
import type { EvalCaseRecord, EvalCaseResult, EvalRunRecord } from '@pelp/domain';
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
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { Chip } from '../../shared/components/Chip';
import { Empty } from '../../shared/components/Empty';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDateTime, fmtInt, fmtPercent, fmtUsd, fromLines, toLines, truncate } from '../../shared/format';

interface CaseFormState {
  question: string;
  expectedUrls: string;
  expectedCoverage: boolean;
  mustMention: string;
  mustNotMention: string;
  tags: string;
}

const EMPTY_FORM: CaseFormState = {
  question: '',
  expectedUrls: '',
  expectedCoverage: true,
  mustMention: '',
  mustNotMention: '',
  tags: '',
};

function formFromCase(record: EvalCaseRecord): CaseFormState {
  return {
    question: record.question,
    expectedUrls: toLines(record.expectedUrls),
    expectedCoverage: record.expectedCoverage,
    mustMention: toLines(record.mustMention),
    mustNotMention: toLines(record.mustNotMention),
    tags: record.tags.join(', '),
  };
}

function toInput(form: CaseFormState): EvalCaseInput {
  return {
    question: form.question.trim(),
    expectedUrls: fromLines(form.expectedUrls),
    expectedCoverage: form.expectedCoverage,
    mustMention: fromLines(form.mustMention),
    mustNotMention: fromLines(form.mustNotMention),
    tags: form.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
  };
}

function caseColumns(onEdit: (row: EvalCaseRecord) => void, onDelete: (row: EvalCaseRecord) => void): Column<EvalCaseRecord>[] {
  return [
    { key: 'question', header: 'Pregunta', render: (row) => <span title={row.question}>{truncate(row.question, 90)}</span> },
    {
      key: 'coverage',
      header: 'Cobertura esperada',
      align: 'center',
      render: (row) => <Chip tone={row.expectedCoverage ? 'success' : 'neutral'}>{row.expectedCoverage ? 'Sí' : 'No'}</Chip>,
    },
    { key: 'urls', header: 'URLs esperadas', align: 'right', render: (row) => fmtInt(row.expectedUrls.length) },
    {
      key: 'tags',
      header: 'Tags',
      render: (row) =>
        row.tags.length > 0 ? (
          <span className="chips-row chips-row--tight">
            {row.tags.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'source', header: 'Origen', render: (row) => <Chip tone={row.source === 'golden' ? 'primary' : 'neutral'}>{row.source}</Chip> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="btn-row btn-row--end">
          <button type="button" className="btn btn--small" onClick={() => onEdit(row)}>
            Editar
          </button>
          <button type="button" className="btn btn--small btn--danger-outline" onClick={() => onDelete(row)}>
            Borrar
          </button>
        </div>
      ),
    },
  ];
}

const RUN_COLUMNS: Column<EvalRunRecord>[] = [
  { key: 'startedAt', header: 'Fecha', nowrap: true, render: (row) => fmtDateTime(row.startedAt) },
  {
    key: 'trigger',
    header: 'Disparo',
    render: (row) => <Chip tone={row.trigger === 'manual' ? 'primary' : 'neutral'}>{row.trigger === 'manual' ? 'manual' : 'nocturna'}</Chip>,
  },
  { key: 'total', header: 'Total', align: 'right', render: (row) => fmtInt(row.total) },
  {
    key: 'passed',
    header: 'Pasadas',
    align: 'right',
    render: (row) => `${fmtInt(row.passed)} / ${fmtInt(row.total)} (${fmtPercent(row.total > 0 ? row.passed / row.total : 0, 0)})`,
  },
  { key: 'citPrecision', header: 'Precisión de citas', align: 'right', render: (row) => fmtPercent(row.citationPrecision) },
  { key: 'citRecall', header: 'Cobertura de citas', align: 'right', render: (row) => fmtPercent(row.citationRecall) },
  { key: 'groundingFail', header: 'Fallo de grounding', align: 'right', render: (row) => fmtPercent(row.groundingFailureRate) },
  { key: 'noCoverage', header: 'Sin cobertura', align: 'right', render: (row) => fmtPercent(row.noCoverageRate) },
  { key: 'cost', header: 'Costo', align: 'right', render: (row) => fmtUsd(row.costUsd, true) },
];

function RunResults({ run }: { run: EvalRunRecord }) {
  if (run.results.length === 0) return <Empty text="Sin resultados detallados para esta corrida." />;
  const columns: Column<EvalCaseResult>[] = [
    { key: 'passed', header: '', align: 'center', render: (row) => <Chip tone={row.passed ? 'success' : 'danger'}>{row.passed ? '✓' : '✗'}</Chip> },
    { key: 'question', header: 'Pregunta', render: (row) => <span title={row.question}>{truncate(row.question, 80)}</span> },
    {
      key: 'coverage',
      header: 'Cobertura (obtenida / esperada)',
      render: (row) =>
        row.hadCoverage === row.expectedCoverage ? (
          <span className="text-success">{row.hadCoverage ? 'sí' : 'no'}</span>
        ) : (
          <span className="text-danger">
            {row.hadCoverage ? 'sí' : 'no'} (esperado: {row.expectedCoverage ? 'sí' : 'no'})
          </span>
        ),
    },
    { key: 'precision', header: 'Precisión de citas', align: 'right', render: (row) => fmtPercent(row.citationPrecision) },
    { key: 'recall', header: 'Cobertura de citas', align: 'right', render: (row) => fmtPercent(row.citationRecall) },
    { key: 'error', header: 'Error', render: (row) => (row.error ? <span className="text-danger">{row.error}</span> : <span className="muted">—</span>) },
  ];
  return <Table dense columns={columns} rows={run.results} rowKey={(row, index) => `${row.caseId}-${index}`} />;
}

export default function CalidadPage() {
  const api = useApi();
  const cases = useAsync(() => api.evalCases(), [api]);
  const runs = useAsync(() => api.evalRuns(20), [api]);
  const notice = useNotice();

  const [editing, setEditing] = useState<EvalCaseRecord | null>(null);
  const [form, setForm] = useState<CaseFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EvalCaseRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);

  const setField = <K extends keyof CaseFormState>(key: K, value: CaseFormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };
  const openEdit = (row: EvalCaseRecord) => {
    setEditing(row);
    setForm(formFromCase(row));
  };
  const closeForm = () => {
    setEditing(null);
    setForm(null);
  };

  const submitForm = async () => {
    if (!form) return;
    if (!form.question.trim()) {
      notice.show('error', 'La pregunta es obligatoria.');
      return;
    }
    setSaving(true);
    try {
      const input = toInput(form);
      if (editing) {
        const updated = await api.updateEvalCase(editing.id, input);
        cases.setData((current) => (current ? { items: current.items.map((item) => (item.id === updated.id ? updated : item)) } : current));
        notice.show('success', 'Caso actualizado.');
      } else {
        const created = await api.createEvalCase(input);
        cases.setData((current) => (current ? { items: [...current.items, created] } : current));
        notice.show('success', 'Caso creado.');
      }
      closeForm();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteEvalCase(deleteTarget.id);
      cases.setData((current) => (current ? { items: current.items.filter((item) => item.id !== deleteTarget.id) } : current));
      notice.show('success', 'Caso borrado.');
      setDeleteTarget(null);
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const result = await api.runEvals();
      if (result.started) {
        notice.show('success', result.detail ?? 'Evaluación disparada. Los resultados aparecen en la tabla de corridas en unos minutos.');
      } else {
        notice.show('error', result.detail ?? 'No se pudo disparar la evaluación.');
      }
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Calidad"
        description="Set dorado de preguntas con notas esperadas y corridas de evaluación: fidelidad, precisión y cobertura de citas, fallo de grounding y preguntas sin cobertura."
        onRefresh={() => {
          cases.reload();
          runs.reload();
        }}
        refreshing={cases.loading || runs.loading}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => void runNow()} disabled={running}>
            {running ? 'Disparando…' : 'Correr evaluación ahora'}
          </button>
        }
      />
      <Notice notice={notice.notice} onClose={notice.clear} />

      <Card
        title={cases.data ? `Casos de evaluación (${fmtInt(cases.data.items.length)})` : 'Casos de evaluación'}
        actions={
          <button type="button" className="btn" onClick={openCreate}>
            Agregar caso
          </button>
        }
      >
        {cases.error && <ErrorBox error={cases.error} onRetry={cases.reload} />}
        {cases.loading && !cases.data && <Spinner />}
        {cases.data && (
          <Table
            columns={caseColumns(openEdit, setDeleteTarget)}
            rows={cases.data.items}
            rowKey={(row) => row.id}
            emptyText="Todavía no hay casos de evaluación."
            dense
            maxHeight="50vh"
          />
        )}
      </Card>

      <Card title="Corridas de evaluación" description="Resultados de las corridas nocturnas y manuales. Clic en una fila para ver el detalle por caso.">
        {runs.error && <ErrorBox error={runs.error} onRetry={runs.reload} />}
        {runs.loading && !runs.data && <Spinner />}
        {runs.data && (
          <Table
            columns={RUN_COLUMNS}
            rows={runs.data.items}
            rowKey={(row) => row.runId}
            expandable={(row) => <RunResults run={row} />}
            emptyText="Todavía no hay corridas registradas."
            dense
            maxHeight="55vh"
          />
        )}
      </Card>

      <Modal
        open={form !== null}
        title={editing ? 'Editar caso de evaluación' : 'Agregar caso de evaluación'}
        onClose={closeForm}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={closeForm} disabled={saving}>
              Cancelar
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void submitForm()} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </>
        }
      >
        {form && (
          <div className="form-grid">
            <div className="form-grid__full">
              <Field label="Pregunta">
                <textarea className="input" rows={2} value={form.question} onChange={(event) => setField('question', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field label="URLs esperadas" hint="Una por línea. Dejalo vacío si se espera «sin cobertura».">
                <textarea
                  className="input input--code"
                  rows={4}
                  value={form.expectedUrls}
                  onChange={(event) => setField('expectedUrls', event.target.value)}
                />
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.expectedCoverage} onChange={(event) => setField('expectedCoverage', event.target.checked)} />
              <span>Se espera cobertura (hay notas de El País para esta pregunta)</span>
            </label>
            <div className="form-grid__full">
              <Field label="Debe mencionar" hint="Frases que tienen que aparecer en la respuesta, una por línea (opcional).">
                <textarea className="input" rows={3} value={form.mustMention} onChange={(event) => setField('mustMention', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field label="No debe mencionar" hint="Frases que no pueden aparecer, una por línea (opcional).">
                <textarea className="input" rows={3} value={form.mustNotMention} onChange={(event) => setField('mustNotMention', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field label="Tags" hint="Separados por coma.">
                <input className="input" value={form.tags} onChange={(event) => setField('tags', event.target.value)} />
              </Field>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Borrar caso de evaluación"
        danger
        busy={deleting}
        confirmLabel="Borrar"
        message={
          <>
            Se borra el caso «{truncate(deleteTarget?.question ?? '', 80)}» del set de evaluación. Esta acción no se puede deshacer.
          </>
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
