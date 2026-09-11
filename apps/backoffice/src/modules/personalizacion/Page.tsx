import { useEffect, useState } from 'react';
import type { ConfigResponse } from '@pelp/domain/api';
import { effectiveIntensity, intensityLevel, type BiasReportRecord, type Config, type IncidentRecord, type IntensityLevel, type VerifierVerdict } from '@pelp/domain';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { HardMaxDialog, useConfigSaver, type ConfigSaveResult } from '../../shared/useConfigSaver';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Field, Toggle } from '../../shared/components/Field';
import { Table, type Column } from '../../shared/components/Table';
import { Chip } from '../../shared/components/Chip';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { DaysSelector } from '../../shared/components/Tabs';
import { Empty } from '../../shared/components/Empty';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDateTime, fmtDay, fmtInt, fmtNumber, fmtPercent, fmtUsd, truncate } from '../../shared/format';

type Personalization = Config['personalization'];
type Axis = keyof Personalization['dimensions'];

const AXES: { key: Axis; label: string; hint: string }[] = [
  { key: 'topics', label: 'Temas', hint: 'Reordena y elige la nota de apertura según los temas del lector.' },
  { key: 'frames', label: 'Encuadres', hint: 'Abre por el encuadre del lector y agrega «por qué te puede importar».' },
  { key: 'politicalLean', label: 'Orientación', hint: 'Solo influye en la elección del encuadre entre los que las notas ya soportan.' },
  { key: 'style', label: 'Estilo', hint: 'Largo, afinidad con datos y tono.' },
];

const LEVEL_TEXT: Record<IntensityLevel, string> = {
  0: 'Nivel 0: solo canónica. La adaptación no se ejecuta.',
  1: 'Nivel 1 (0,01–0,33): reordena por temas, ajusta largo y estilo, elige la nota de apertura.',
  2: 'Nivel 2 (0,34–0,66): además abre por el encuadre del lector, agrega «por qué te puede importar» y sugiere repreguntas afines.',
  3: 'Nivel 3 (0,67–1,00): además intensifica énfasis y registro según encuadres.',
};

function parseChannels(text: string): string[] {
  return Array.from(new Set(text.split(/[,\s]+/).map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0)));
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <input
      className="input input--number"
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.valueAsNumber;
        if (!Number.isNaN(next)) onChange(next);
      }}
    />
  );
}

function SliderField({
  label,
  hint,
  value,
  onChange,
  effective,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  effective?: number;
  disabled?: boolean;
}) {
  return (
    <div className="slider">
      <div className="slider__head">
        <span className="field__label">{label}</span>
        <span className="slider__value">
          {fmtNumber(value, 2)}
          {effective !== undefined && <span className="muted"> · efectiva {fmtNumber(effective, 2)}</span>}
        </span>
      </div>
      <div className="slider__controls">
        <input type="range" min={0} max={1} step={0.01} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} disabled={disabled} />
        <NumberInput value={value} min={0} max={1} step={0.01} onChange={onChange} disabled={disabled} />
      </div>
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

function VerdictView({ verdict }: { verdict: VerifierVerdict }) {
  return (
    <div className="verdict">
      <div className="chips-row">
        <Chip tone={verdict.ok ? 'success' : 'danger'}>{verdict.ok ? 'aprobado' : 'rechazado'}</Chip>
        <Chip tone={verdict.citationsEqual ? 'success' : 'danger'}>{verdict.citationsEqual ? 'mismas citas' : 'citas distintas'}</Chip>
        <Chip tone={verdict.opinionDetected ? 'danger' : 'success'}>{verdict.opinionDetected ? 'opinión detectada' : 'sin opinión'}</Chip>
      </div>
      {verdict.missingFacts.length > 0 && (
        <p>
          <strong>Hechos omitidos:</strong> {verdict.missingFacts.join(' · ')}
        </p>
      )}
      {verdict.newFacts.length > 0 && (
        <p>
          <strong>Hechos agregados:</strong> {verdict.newFacts.join(' · ')}
        </p>
      )}
      {verdict.notes && <p className="muted">{verdict.notes}</p>}
    </div>
  );
}

function IncidentDetail({ incident }: { incident: IncidentRecord }) {
  return (
    <div className="detail detail--inline">
      <div className="split">
        <section>
          <h4 className="h4">Canónica</h4>
          <div className="answer">{incident.canonicalAnswer}</div>
        </section>
        <section>
          <h4 className="h4">Adaptada (rechazada)</h4>
          <div className="answer answer--rejected">{incident.adaptedAnswer}</div>
        </section>
      </div>
      <VerdictView verdict={incident.verdict} />
    </div>
  );
}

const BIAS_COLUMNS: Column<BiasReportRecord>[] = [
  { key: 'day', header: 'Día', nowrap: true, render: (row) => fmtDay(row.day) },
  { key: 'intensity', header: 'Intensidad', align: 'right', render: (row) => fmtNumber(row.intensity, 2) },
  { key: 'samples', header: 'Muestras', align: 'right', render: (row) => fmtInt(row.samples) },
  { key: 'facts', header: 'Diverg. de hechos', align: 'right', render: (row) => fmtInt(row.factDivergenceTotal) },
  { key: 'citations', header: 'Igualdad de citas', align: 'right', render: (row) => fmtPercent(row.citationEqualityRate, 0) },
  { key: 'frame', header: 'Diverg. de encuadre', align: 'right', render: (row) => fmtNumber(row.frameDivergenceAvg, 2) },
  { key: 'opinion', header: 'Opinión', align: 'right', render: (row) => fmtInt(row.opinionCount) },
  { key: 'clean', header: 'Limpio', align: 'center', render: (row) => <Chip tone={row.clean ? 'success' : 'danger'}>{row.clean ? '✓' : '✗'}</Chip> },
  {
    key: 'lowered',
    header: 'Auto-bajada',
    render: (row) => (row.autoLowered ? <Chip tone="danger">sí{row.loweredTo !== undefined ? ` → ${fmtNumber(row.loweredTo, 2)}` : ''}</Chip> : <span className="muted">no</span>),
  },
  { key: 'cost', header: 'Costo', align: 'right', render: (row) => fmtUsd(row.costUsd, true) },
];

function BiasDetails({ report }: { report: BiasReportRecord }) {
  if (report.details.length === 0) return <Empty text="Sin muestras detalladas." />;
  return (
    <Table
      dense
      columns={[
        { key: 'q', header: 'Pregunta', render: (row) => <span title={row.questionMasked}>{truncate(row.questionMasked, 90)}</span> },
        { key: 'facts', header: 'Diverg. hechos', align: 'right', render: (row) => fmtInt(row.factDivergence) },
        { key: 'cit', header: 'Citas iguales', align: 'center', render: (row) => (row.citationsEqual ? '✓' : '✗') },
        { key: 'frame', header: 'Diverg. encuadre', align: 'right', render: (row) => fmtNumber(row.frameDivergence, 2) },
        { key: 'op', header: 'Opinión', align: 'center', render: (row) => (row.opinionDetected ? '✗' : '—') },
        { key: 'profiles', header: 'Perfiles', render: (row) => row.profiles.join(', ') },
      ]}
      rows={report.details}
      rowKey={(row) => row.msgId}
    />
  );
}

export default function PersonalizacionPage() {
  const api = useApi();
  const current = useAsync(() => api.getConfig(), [api]);
  const saver = useConfigSaver(api);
  const notice = useNotice();
  const [form, setForm] = useState<Personalization | null>(null);
  const [channelsText, setChannelsText] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [rehabOpen, setRehabOpen] = useState(false);
  const [days, setDays] = useState(30);
  const bias = useAsync(() => api.bias(days), [api, days]);
  const incidents = useAsync(() => api.incidents(days), [api, days]);

  const config = current.data;

  useEffect(() => {
    if (config) {
      setForm(config.config.personalization);
      setChannelsText(config.config.personalization.channels.join(', '));
    }
  }, [config]);

  const merged: Config | null = config && form ? { ...config.config, personalization: { ...form, channels: parseChannels(channelsText) } } : null;
  const dirty = merged !== null && config !== undefined && JSON.stringify(merged.personalization) !== JSON.stringify(config.config.personalization);
  const aboveHardMax = form !== null && form.intensity > form.hardMax;
  const level = intensityLevel(form?.intensity ?? 0);

  const set = <K extends keyof Personalization>(key: K, value: Personalization[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const setDim = (axis: Axis, value: number) => setForm((f) => (f ? { ...f, dimensions: { ...f.dimensions, [axis]: value } } : f));

  const applyResult = (result: ConfigSaveResult, success: (response: ConfigResponse) => string) => {
    switch (result.status) {
      case 'saved':
        current.setData(result.response);
        notice.show('success', success(result.response));
        break;
      case 'confirm':
        break;
      case 'invalid':
        notice.show('error', `Configuración inválida: ${result.errors.join(' · ')}`);
        break;
      case 'error':
        notice.show('error', result.message);
        break;
    }
  };

  const save = async (reason: string, override?: Partial<Personalization>) => {
    if (!merged) return;
    const next: Config = override ? { ...merged, personalization: { ...merged.personalization, ...override } } : merged;
    const result = await saver.save({ config: next, reason: reason || undefined });
    applyResult(result, (response) => `Personalización guardada (versión ${response.version}).`);
  };

  const refreshAll = () => {
    current.reload();
    bias.reload();
    incidents.reload();
  };

  const incidentColumns: Column<IncidentRecord>[] = [
    { key: 'at', header: 'Fecha', nowrap: true, render: (row) => fmtDateTime(row.at) },
    { key: 'msgId', header: 'Mensaje', render: (row) => <code>{truncate(row.msgId, 16)}</code> },
    { key: 'reader', header: 'Lector', render: (row) => (row.readerId ? <code>{truncate(row.readerId, 12)}</code> : <span className="muted">—</span>) },
    {
      key: 'verdict',
      header: 'Veredicto',
      render: (row) => (
        <span className="chips-row chips-row--tight">
          {row.verdict.missingFacts.length > 0 && <Chip tone="danger">{fmtInt(row.verdict.missingFacts.length)} omitidos</Chip>}
          {row.verdict.newFacts.length > 0 && <Chip tone="danger">{fmtInt(row.verdict.newFacts.length)} agregados</Chip>}
          {!row.verdict.citationsEqual && <Chip tone="danger">citas distintas</Chip>}
          {row.verdict.opinionDetected && <Chip tone="danger">opinión</Chip>}
        </span>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Personalización"
        description="Perilla de intensidad por eje, techo, umbrales y rollout. Reporte de sesgo diario e incidentes PersonalizationRejected."
        onRefresh={refreshAll}
        refreshing={current.loading || bias.loading || incidents.loading}
      />
      <Notice notice={notice.notice} onClose={notice.clear} />
      {current.error && <ErrorBox error={current.error} onRetry={current.reload} />}
      {current.loading && !config && <Spinner />}

      {config && form && merged && (
        <>
          {aboveHardMax && (
            <div className="banner banner--danger" role="alert">
              <strong>Intensidad por encima del techo.</strong> intensity ({fmtNumber(form.intensity, 2)}) supera hardMax ({fmtNumber(form.hardMax, 2)}). Guardar
              requiere confirmación explícita y esta advertencia se mantiene mientras dure.
            </div>
          )}
          {form.autoLowered && (
            <div className="banner banner--warning" role="alert">
              <div>
                <strong>Auto-bajada activa.</strong> El reporte de sesgo no salió limpio y la intensidad bajó sola al último valor limpio (
                {fmtNumber(form.lastCleanIntensity, 2)}). Revisá el reporte y los incidentes antes de rehabilitar.
              </div>
              <button type="button" className="btn btn--warning" onClick={() => setRehabOpen(true)} disabled={saver.saving}>
                Rehabilitar
              </button>
            </div>
          )}

          <Card
            title={
              <>
                Perilla{' '}
                <Chip tone={form.enabled ? 'success' : 'neutral'}>{form.enabled ? 'habilitada' : 'apagada'}</Chip>{' '}
                {dirty && <Chip tone="warning">cambios sin guardar</Chip>}
              </>
            }
            description={`Versión ${config.version} · ${LEVEL_TEXT[level]}`}
            actions={
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!dirty || saver.saving}
                  onClick={() => {
                    setForm(config.config.personalization);
                    setChannelsText(config.config.personalization.channels.join(', '));
                  }}
                >
                  Descartar
                </button>
                <button type="button" className="btn btn--primary" disabled={!dirty || saver.saving} onClick={() => setSaveOpen(true)}>
                  {saver.saving ? 'Guardando…' : 'Guardar'}
                </button>
              </div>
            }
          >
            <div className="form-grid">
              <div className="form-grid__full">
                <Toggle checked={form.enabled} onChange={(next) => set('enabled', next)} label={<strong>Personalización habilitada</strong>} />
              </div>
              <div className="form-grid__full">
                <SliderField label="Intensidad global (intensity)" value={form.intensity} onChange={(value) => set('intensity', value)} hint={LEVEL_TEXT[level]} />
              </div>
              {AXES.map((axis) => (
                <SliderField
                  key={axis.key}
                  label={`Eje ${axis.label} (dimensions.${axis.key})`}
                  value={form.dimensions[axis.key]}
                  onChange={(value) => setDim(axis.key, value)}
                  effective={effectiveIntensity(merged, axis.key)}
                  hint={axis.hint}
                />
              ))}
              <Field label="Techo (hardMax)" hint="Por encima se exige confirmación y advertencia permanente.">
                <NumberInput value={form.hardMax} min={0} max={1} step={0.01} onChange={(value) => set('hardMax', value)} />
              </Field>
              <Field label="Evidencia mínima (minEvidence)" hint="Preguntas mínimas antes de adaptar.">
                <NumberInput value={form.minEvidence} min={1} step={1} onChange={(value) => set('minEvidence', Math.round(value))} />
              </Field>
              <Field label="Confianza mínima (minConfidence)">
                <NumberInput value={form.minConfidence} min={0} max={1} step={0.05} onChange={(value) => set('minConfidence', value)} />
              </Field>
              <Field label="Rollout (%)" hint="Porcentaje de lectores con consentimiento que entra a la cohorte personalizada.">
                <NumberInput value={form.rolloutPercent} min={0} max={100} step={1} onChange={(value) => set('rolloutPercent', Math.round(value))} />
              </Field>
              <Field label="Decaimiento del perfil (días)">
                <NumberInput value={form.profileDecayDays} min={1} step={1} onChange={(value) => set('profileDecayDays', Math.round(value))} />
              </Field>
              <Field label="Perfil cada N preguntas">
                <NumberInput value={form.profileEveryQuestions} min={1} step={1} onChange={(value) => set('profileEveryQuestions', Math.round(value))} />
              </Field>
              <Field label="Canales" hint="Separados por coma (web, whatsapp, discord).">
                <input className="input" value={channelsText} onChange={(event) => setChannelsText(event.target.value)} />
              </Field>
              <Field label="Modelo de adaptación">
                <input className="input input--code" value={form.adaptationModel} onChange={(event) => set('adaptationModel', event.target.value)} />
              </Field>
              <Field label="Modelo verificador">
                <input className="input input--code" value={form.verifierModel} onChange={(event) => set('verifierModel', event.target.value)} />
              </Field>
              <div>
                <Toggle checked={form.requireConsent} onChange={(next) => set('requireConsent', next)} label="Requiere consentimiento explícito" />
              </div>
            </div>
          </Card>
        </>
      )}

      <div className="section-head">
        <h2 className="h2">Reporte de sesgo e incidentes</h2>
        <DaysSelector value={days} onChange={setDays} options={[7, 30, 90]} />
      </div>

      <Card title="Reporte de sesgo por día" description="Job nocturno: misma pregunta con perfiles distintos. Un día no limpio dispara la auto-bajada.">
        {bias.error && <ErrorBox error={bias.error} onRetry={bias.reload} />}
        {bias.loading && !bias.data && <Spinner />}
        {bias.data && (
          <Table
            columns={BIAS_COLUMNS}
            rows={bias.data.reports}
            rowKey={(row) => row.day}
            expandable={(row) => <BiasDetails report={row} />}
            emptyText="Sin reportes en el período (la personalización puede estar apagada)."
            dense
            maxHeight={420}
          />
        )}
      </Card>

      <Card title="Incidentes PersonalizationRejected" description="Adaptaciones que el verificador rechazó: se envió la canónica. Clic para ver ambas versiones.">
        {incidents.error && <ErrorBox error={incidents.error} onRetry={incidents.reload} />}
        {incidents.loading && !incidents.data && <Spinner />}
        {incidents.data && (
          <Table
            columns={incidentColumns}
            rows={incidents.data.items}
            rowKey={(row) => row.id}
            expandable={(row) => <IncidentDetail incident={row} />}
            emptyText="Sin incidentes en el período."
            dense
            maxHeight={520}
          />
        )}
      </Card>

      <ConfirmDialog
        open={saveOpen}
        title="Guardar personalización"
        message="Se guarda solo el bloque personalization sobre la configuración vigente y se crea una versión nueva."
        confirmLabel="Guardar"
        reason="optional"
        busy={saver.saving}
        onConfirm={(reason) => {
          setSaveOpen(false);
          void save(reason);
        }}
        onCancel={() => setSaveOpen(false)}
      />
      <ConfirmDialog
        open={rehabOpen}
        title="Rehabilitar tras la auto-bajada"
        danger
        confirmLabel="Rehabilitar"
        reason="required"
        busy={saver.saving}
        message={
          <>
            Se limpia <code>autoLowered</code> y se guarda la perilla tal como está en el formulario (intensidad {fmtNumber(form?.intensity ?? 0, 2)}). Indicá el
            motivo: qué se revisó y por qué es seguro volver.
          </>
        }
        onConfirm={(reason) => {
          setRehabOpen(false);
          void save(reason, { autoLowered: false });
        }}
        onCancel={() => setRehabOpen(false)}
      />
      <HardMaxDialog saver={saver} onResult={(result) => applyResult(result, (response) => `Personalización guardada (versión ${response.version}).`)} />
    </div>
  );
}
