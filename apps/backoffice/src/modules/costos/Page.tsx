import { useEffect, useState } from 'react';
import type { Config } from '@pelp/domain';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { HardMaxDialog, useConfigSaver, type ConfigSaveResult } from '../../shared/useConfigSaver';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Progress, Stat } from '../../shared/components/Stat';
import { Bars, ColumnChart, recordToBars } from '../../shared/components/Bars';
import { Table, type Column } from '../../shared/components/Table';
import { Field } from '../../shared/components/Field';
import { Chip, type Tone } from '../../shared/components/Chip';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { DaysSelector } from '../../shared/components/Tabs';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDay, fmtInt, fmtTokens, fmtUsd } from '../../shared/format';

interface ModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

const MODEL_COLUMNS: Column<ModelRow>[] = [
  { key: 'model', header: 'Modelo', render: (row) => <code>{row.model}</code> },
  { key: 'in', header: 'Tokens entrada', align: 'right', render: (row) => fmtTokens(row.inputTokens) },
  { key: 'out', header: 'Tokens salida', align: 'right', render: (row) => fmtTokens(row.outputTokens) },
  { key: 'calls', header: 'Llamadas', align: 'right', render: (row) => fmtInt(row.calls) },
  { key: 'cost', header: 'USD', align: 'right', render: (row) => fmtUsd(row.costUsd, true) },
];

interface PricingForm {
  pricing: Config['pricing'];
  dailyBudgetUsd: number;
  budgetSoftPercent: number;
  onBudgetExceeded: Config['limits']['onBudgetExceeded'];
}

function formFromConfig(config: Config): PricingForm {
  return {
    pricing: config.pricing,
    dailyBudgetUsd: config.limits.dailyBudgetUsd,
    budgetSoftPercent: config.limits.budgetSoftPercent,
    onBudgetExceeded: config.limits.onBudgetExceeded,
  };
}

function mergeConfig(base: Config, form: PricingForm): Config {
  return {
    ...base,
    pricing: form.pricing,
    limits: { ...base.limits, dailyBudgetUsd: form.dailyBudgetUsd, budgetSoftPercent: form.budgetSoftPercent, onBudgetExceeded: form.onBudgetExceeded },
  };
}

function isDirty(base: Config, merged: Config): boolean {
  return JSON.stringify(merged.pricing) !== JSON.stringify(base.pricing) || JSON.stringify(merged.limits) !== JSON.stringify(base.limits);
}

export default function CostosPage() {
  const api = useApi();
  const [days, setDays] = useState(30);
  const costs = useAsync(() => api.costs(days), [api, days]);
  const current = useAsync(() => api.getConfig(), [api]);
  const saver = useConfigSaver(api);
  const notice = useNotice();

  const [form, setForm] = useState<PricingForm | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  const config = current.data;

  useEffect(() => {
    if (config) setForm(formFromConfig(config.config));
  }, [config]);

  const set = <K extends keyof PricingForm>(key: K, value: PricingForm[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const setPrice = (model: string, key: 'inputPerMTok' | 'outputPerMTok', value: number) =>
    setForm((prev) => {
      if (!prev) return prev;
      const entry = prev.pricing[model];
      if (!entry) return prev;
      return { ...prev, pricing: { ...prev.pricing, [model]: { ...entry, [key]: value } } };
    });

  const addModel = () => {
    const id = newModelId.trim();
    if (!id) return;
    setForm((prev) =>
      prev && !prev.pricing[id]
        ? { ...prev, pricing: { ...prev.pricing, [id]: { inputPerMTok: 0, outputPerMTok: 0, cacheReadFactor: 0.1, cacheWriteFactor: 1.25 } } }
        : prev,
    );
    setNewModelId('');
  };

  const merged = config && form ? mergeConfig(config.config, form) : null;
  const dirty = Boolean(config && merged && isDirty(config.config, merged));

  const applyResult = (result: ConfigSaveResult) => {
    switch (result.status) {
      case 'saved':
        current.setData(result.response);
        notice.show('success', `Precios y presupuesto guardados (versión ${result.response.version}).`);
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

  const save = async (reason: string) => {
    if (!merged) return;
    const result = await saver.save({ config: merged, reason: reason || undefined });
    applyResult(result);
  };

  const data = costs.data;
  const budgetTone: Tone = data ? (data.todayPercent >= 100 ? 'danger' : data.todayPercent >= 80 ? 'warning' : 'primary') : 'primary';
  const modelRows: ModelRow[] = data ? Object.entries(data.byModel).map(([model, metrics]) => ({ model, ...metrics })) : [];

  return (
    <div className="page">
      <PageHeader
        title="Costos"
        description="Tokens y USD por modelo, por día y por canal; proyección mensual y presupuesto."
        onRefresh={() => {
          costs.reload();
          current.reload();
        }}
        refreshing={costs.loading || current.loading}
        actions={<DaysSelector value={days} onChange={setDays} options={[7, 30, 90]} />}
      />
      <Notice notice={notice.notice} onClose={notice.clear} />
      {costs.error && <ErrorBox error={costs.error} onRetry={costs.reload} />}
      {costs.loading && !data && <Spinner />}

      {data && (
        <>
          <div className="stat-grid">
            <Stat label="Hoy" value={fmtUsd(data.todayUsd)} />
            <Stat label="% del presupuesto" value={`${Math.round(data.todayPercent)} %`} tone={budgetTone}>
              <Progress percent={data.todayPercent} label="Consumo del presupuesto diario" />
            </Stat>
            <Stat label="Total del período" value={fmtUsd(data.totalUsd)} hint={`últimos ${data.days} días`} />
            <Stat label="Proyección mensual" value={fmtUsd(data.projectedMonthUsd)} />
          </div>

          <Card title="Costo por día">
            <ColumnChart
              items={data.byDay.map((day) => ({ key: day.day, label: fmtDay(day.day), value: day.costUsd, title: `${fmtDay(day.day)}: ${fmtUsd(day.costUsd, true)}` }))}
              format={(value) => fmtUsd(value, true)}
              threshold={data.dailyBudgetUsd}
            />
          </Card>

          <div className="grid-2">
            <Card title="Por modelo">
              <Table columns={MODEL_COLUMNS} rows={modelRows} rowKey={(row) => row.model} emptyText="Sin costos registrados en el período." dense />
            </Card>
            <Card title="Por canal">
              <Bars items={recordToBars(data.byChannel)} format={(value) => fmtUsd(value, true)} tone="neutral" />
            </Card>
          </div>
        </>
      )}

      {current.error && <ErrorBox error={current.error} onRetry={current.reload} />}
      {current.loading && !config && <Spinner />}

      {config && form && (
        <Card
          title={
            <>
              Precios y presupuesto {dirty && <Chip tone="warning">cambios sin guardar</Chip>}
            </>
          }
          description={`Versión ${config.version}. Los precios son USD por millón de tokens.`}
          actions={
            <div className="btn-row">
              <button type="button" className="btn btn--ghost" disabled={!dirty || saver.saving} onClick={() => setForm(formFromConfig(config.config))}>
                Descartar
              </button>
              <button type="button" className="btn btn--primary" disabled={!dirty || saver.saving} onClick={() => setSaveOpen(true)}>
                {saver.saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          }
        >
          <div className="table-wrap">
            <table className="table table--dense">
              <thead>
                <tr>
                  <th scope="col">Modelo</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    USD / M tok entrada
                  </th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    USD / M tok salida
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(form.pricing).map(([model, price]) => (
                  <tr key={model}>
                    <th scope="row">
                      <code>{model}</code>
                    </th>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        className="input input--number"
                        type="number"
                        min={0}
                        step={0.01}
                        value={price.inputPerMTok}
                        onChange={(event) => setPrice(model, 'inputPerMTok', Number(event.target.value))}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        className="input input--number"
                        type="number"
                        min={0}
                        step={0.01}
                        value={price.outputPerMTok}
                        onChange={(event) => setPrice(model, 'outputPerMTok', Number(event.target.value))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="filters">
            <Field label="Agregar modelo" className="filters__wide" hint="ID exacto del modelo en Bedrock.">
              <input className="input input--code" value={newModelId} onChange={(event) => setNewModelId(event.target.value)} placeholder="us.anthropic.claude-…" />
            </Field>
            <div className="filters__actions">
              <button type="button" className="btn" onClick={addModel} disabled={!newModelId.trim() || Boolean(form.pricing[newModelId.trim()])}>
                Agregar modelo
              </button>
            </div>
          </div>

          <div className="form-grid">
            <Field label="Presupuesto diario (USD)">
              <input
                className="input input--number"
                type="number"
                min={0}
                step={1}
                value={form.dailyBudgetUsd}
                onChange={(event) => set('dailyBudgetUsd', Number(event.target.value))}
              />
            </Field>
            <Field label="Avisar al (%)">
              <input
                className="input input--number"
                type="number"
                min={1}
                max={100}
                value={form.budgetSoftPercent}
                onChange={(event) => set('budgetSoftPercent', Number(event.target.value))}
              />
            </Field>
            <Field label="Al superar el presupuesto">
              <select className="input" value={form.onBudgetExceeded} onChange={(event) => set('onBudgetExceeded', event.target.value as Config['limits']['onBudgetExceeded'])}>
                <option value="fallback">Usar modelo de respaldo (fallback)</option>
                <option value="pause">Pausar el servicio</option>
              </select>
            </Field>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={saveOpen}
        title="Guardar precios y presupuesto"
        message="Se guarda una versión nueva de la configuración y queda registrada en la auditoría."
        confirmLabel="Guardar"
        reason="optional"
        busy={saver.saving}
        onConfirm={(reason) => {
          setSaveOpen(false);
          void save(reason);
        }}
        onCancel={() => setSaveOpen(false)}
      />
      <HardMaxDialog saver={saver} onResult={applyResult} />
    </div>
  );
}
