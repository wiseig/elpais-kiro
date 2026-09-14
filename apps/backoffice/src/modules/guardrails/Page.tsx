import { useEffect, useState } from 'react';
import type { Config } from '@pelp/domain';
import type { BlockedItem } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { HardMaxDialog, useConfigSaver, type ConfigSaveResult } from '../../shared/useConfigSaver';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Field, Toggle } from '../../shared/components/Field';
import { Table, type Column } from '../../shared/components/Table';
import { Bars, recordToBars } from '../../shared/components/Bars';
import { Chip } from '../../shared/components/Chip';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { DaysSelector } from '../../shared/components/Tabs';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDateTime, fmtInt, fromLines, toLines } from '../../shared/format';

const KIND_LABELS: Record<string, string> = {
  too_long: 'pregunta muy larga',
  rate_limited: 'límite de frecuencia',
  prompt_attack: 'intento de prompt injection',
  denied_topic: 'tema vedado',
  blocked_word: 'palabra bloqueada',
  content: 'contenido (guardrail Bedrock)',
  off_topic: 'fuera de tema',
  output_content: 'contenido de salida',
  grounding: 'grounding insuficiente',
  format: 'formato inválido',
  consent_required: 'falta consentimiento',
  service_paused: 'servicio pausado',
  budget_paused: 'presupuesto agotado',
};

const BLOCK_COLUMNS: Column<BlockedItem>[] = [
  { key: 'at', header: 'Fecha', nowrap: true, render: (row) => fmtDateTime(row.at) },
  { key: 'channel', header: 'Canal', render: (row) => <Chip>{row.channel}</Chip> },
  { key: 'kind', header: 'Tipo', render: (row) => <Chip tone="danger">{KIND_LABELS[row.kind] ?? row.kind}</Chip> },
  {
    key: 'sample',
    header: 'Muestra enmascarada',
    render: (row) => (
      <span className="cell-text">
        {row.sampleMasked || <span className="muted">—</span>}
        {row.fromEvalSet && <Chip>prueba</Chip>}
      </span>
    ),
  },
  { key: 'detail', header: 'Detalle', render: (row) => row.detail || <span className="muted">—</span> },
];

/** Resta los bloqueos de prueba del conteo por tipo, sin dejar tipos en cero. */
function withoutTests(total: Record<string, number>, tests: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [kind, count] of Object.entries(total)) {
    const rest = count - (tests[kind] ?? 0);
    if (rest > 0) result[kind] = rest;
  }
  return result;
}

interface GuardrailsForm {
  deniedTopicsText: string;
  blockedWordsText: string;
  maxQuestionChars: number;
  offTopicEnabled: boolean;
  offTopicThreshold: number;
  groundingThreshold: number;
  relevanceThreshold: number;
  questionMarkersText: string;
  topicMaxWords: number;
  digestWordsText: string;
  digestTodayText: string;
  digestStandaloneText: string;
  digestMaxWords: number;
  digestNotes: number;
  digestSkipText: string;
  digestOrderText: string;
  digestSectionsText: string;
  digestSectionDays: number;
}

/** Una sección por línea: "judiciales, judicial = informacion/judiciales". */
function sectionsToText(sections: readonly { names: string[]; match: string[] }[]): string {
  return sections.map((section) => `${section.names.join(', ')} = ${section.match.join(', ')}`).join('\n');
}

function sectionsFromText(text: string): { names: string[]; match: string[] }[] {
  const parse = (part: string) => part.split(',').map((item) => item.trim()).filter(Boolean);
  return fromLines(text)
    .map((line) => {
      const [names = '', match = ''] = line.split('=');
      return { names: parse(names), match: parse(match) };
    })
    .filter((section) => section.names.length > 0 && section.match.length > 0);
}

function formFromConfig(config: Config): GuardrailsForm {
  return {
    deniedTopicsText: toLines(config.guardrails.deniedTopics),
    blockedWordsText: toLines(config.guardrails.blockedWords),
    maxQuestionChars: config.guardrails.maxQuestionChars,
    offTopicEnabled: config.guardrails.offTopicClassifier.enabled,
    offTopicThreshold: config.guardrails.offTopicClassifier.threshold,
    groundingThreshold: config.answering.groundingThreshold,
    relevanceThreshold: config.answering.relevanceThreshold,
    questionMarkersText: toLines(config.intents.questionMarkers),
    topicMaxWords: config.intents.topicMaxWords,
    digestWordsText: toLines(config.intents.digest.words),
    digestTodayText: toLines(config.intents.digest.today),
    digestStandaloneText: toLines(config.intents.digest.standalone),
    digestMaxWords: config.intents.digest.maxWords,
    digestNotes: config.intents.digest.notes,
    digestSkipText: toLines(config.intents.digest.skipSections),
    digestOrderText: toLines(config.intents.digest.sectionOrder),
    digestSectionsText: sectionsToText(config.intents.digest.sections),
    digestSectionDays: config.intents.digest.sectionDays,
  };
}

function mergeConfig(base: Config, form: GuardrailsForm): Config {
  return {
    ...base,
    guardrails: {
      ...base.guardrails,
      deniedTopics: fromLines(form.deniedTopicsText),
      blockedWords: fromLines(form.blockedWordsText),
      maxQuestionChars: form.maxQuestionChars,
      offTopicClassifier: { ...base.guardrails.offTopicClassifier, enabled: form.offTopicEnabled, threshold: form.offTopicThreshold },
    },
    answering: { ...base.answering, groundingThreshold: form.groundingThreshold, relevanceThreshold: form.relevanceThreshold },
    intents: {
      questionMarkers: fromLines(form.questionMarkersText),
      topicMaxWords: form.topicMaxWords,
      digest: {
        words: fromLines(form.digestWordsText),
        today: fromLines(form.digestTodayText),
        standalone: fromLines(form.digestStandaloneText),
        maxWords: form.digestMaxWords,
        notes: form.digestNotes,
        skipSections: fromLines(form.digestSkipText),
        sectionOrder: fromLines(form.digestOrderText),
        sections: sectionsFromText(form.digestSectionsText),
        sectionDays: form.digestSectionDays,
      },
    },
  };
}

function isDirty(base: Config, merged: Config): boolean {
  return (
    JSON.stringify(merged.guardrails) !== JSON.stringify(base.guardrails) ||
    JSON.stringify(merged.answering) !== JSON.stringify(base.answering) ||
    JSON.stringify(merged.intents) !== JSON.stringify(base.intents)
  );
}

export default function GuardrailsPage() {
  const api = useApi();
  const current = useAsync(() => api.getConfig(), [api]);
  const saver = useConfigSaver(api);
  const notice = useNotice();
  const [days, setDays] = useState(7);
  const blocksState = useAsync(() => api.blocks(days), [api, days]);
  const [showTests, setShowTests] = useState(false);
  const [form, setForm] = useState<GuardrailsForm | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const config = current.data;

  useEffect(() => {
    if (config) setForm(formFromConfig(config.config));
  }, [config]);

  const set = <K extends keyof GuardrailsForm>(key: K, value: GuardrailsForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const merged = config && form ? mergeConfig(config.config, form) : null;
  const dirty = Boolean(config && merged && isDirty(config.config, merged));

  const applyResult = (result: ConfigSaveResult) => {
    switch (result.status) {
      case 'saved':
        current.setData(result.response);
        notice.show('success', `Guardrails guardados (versión ${result.response.version}).`);
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

  const allBlocks = blocksState.data?.items ?? [];
  const testCount = allBlocks.filter((item) => item.fromEvalSet).length;
  const visibleBlocks = showTests ? allBlocks : allBlocks.filter((item) => !item.fromEvalSet);

  return (
    <div className="page">
      <PageHeader
        title="Guardrails"
        description="Temas vedados, palabras bloqueadas y umbrales; cómo se leen las consultas que llegan; conteo de bloqueos por tipo con muestras enmascaradas."
        onRefresh={() => {
          current.reload();
          blocksState.reload();
        }}
        refreshing={current.loading || blocksState.loading}
      />
      <Notice notice={notice.notice} onClose={notice.clear} />

      <div className="section-head">
        <h2 className="h2">Bloqueos</h2>
        <DaysSelector value={days} onChange={setDays} options={[1, 7, 30]} />
      </div>

      {blocksState.error && <ErrorBox error={blocksState.error} onRetry={blocksState.reload} />}
      {blocksState.loading && !blocksState.data && <Spinner />}
      {blocksState.data && (
        <div className="grid-2 grid-2--wide-left">
          <Card
            title="Muestras"
            description={
              testCount > 0 && !showTests
                ? `Últimos bloqueos con muestra enmascarada. Se ocultaron ${fmtInt(testCount)} del set de evaluación: el smoke test y las corridas de control preguntan esos casos contra la API real y tres existen para que los guardrails los frenen.`
                : 'Últimos bloqueos con muestra enmascarada.'
            }
            actions={
              testCount > 0 ? <Toggle checked={showTests} onChange={setShowTests} label="Incluir las del set de evaluación" /> : undefined
            }
          >
            <Table
              columns={BLOCK_COLUMNS}
              rows={visibleBlocks}
              rowKey={(row) => row.id}
              emptyText="Sin bloqueos de lectores en el período."
              dense
              maxHeight="55vh"
            />
          </Card>
          <Card title="Por tipo">
            <Bars
              items={recordToBars(
                showTests ? blocksState.data.byKind : withoutTests(blocksState.data.byKind, blocksState.data.evalSetByKind),
                (key) => KIND_LABELS[key] ?? key,
              )}
              tone="danger"
            />
          </Card>
        </div>
      )}

      {current.error && <ErrorBox error={current.error} onRetry={current.reload} />}
      {current.loading && !config && <Spinner />}

      {config && form && (
        <Card
          title={
            <>
              Reglas y umbrales {dirty && <Chip tone="warning">cambios sin guardar</Chip>}
            </>
          }
          description={`Versión ${config.version}. Los cambios impactan en menos de 60 segundos (la Lambda cachea la configuración).`}
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
          <div className="form-grid">
            <div className="form-grid__full">
              <Field label="Temas vedados" hint="Uno por línea.">
                <textarea className="input" rows={4} value={form.deniedTopicsText} onChange={(event) => set('deniedTopicsText', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field label="Palabras bloqueadas" hint="Una por línea.">
                <textarea className="input" rows={4} value={form.blockedWordsText} onChange={(event) => set('blockedWordsText', event.target.value)} />
              </Field>
            </div>
            <Field label="Máximo de caracteres por pregunta">
              <input
                className="input input--number"
                type="number"
                min={20}
                max={5000}
                value={form.maxQuestionChars}
                onChange={(event) => set('maxQuestionChars', Number(event.target.value))}
              />
            </Field>
            <Field label="Umbral del clasificador fuera de tema">
              <input
                className="input input--number"
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={form.offTopicThreshold}
                onChange={(event) => set('offTopicThreshold', Number(event.target.value))}
              />
            </Field>
            <Field label="Umbral de grounding (answering.groundingThreshold)">
              <input
                className="input input--number"
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={form.groundingThreshold}
                onChange={(event) => set('groundingThreshold', Number(event.target.value))}
              />
            </Field>
            <Field label="Umbral de relevancia (answering.relevanceThreshold)">
              <input
                className="input input--number"
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={form.relevanceThreshold}
                onChange={(event) => set('relevanceThreshold', Number(event.target.value))}
              />
            </Field>
            <div className="form-grid__full">
              <Toggle checked={form.offTopicEnabled} onChange={(next) => set('offTopicEnabled', next)} label="Clasificador fuera de tema habilitado" />
            </div>
          </div>
        </Card>
      )}

      {config && form && (
        <Card
          title="Cómo se leen las consultas"
          description="Las listas que deciden si lo que escribió el lector es un tema, un pedido o una pregunta por el panorama del día. Se guardan con el mismo botón de arriba y el motor las toma en menos de un minuto."
        >
          <div className="form-grid">
            <div className="form-grid__full">
              <Field
                label="Palabras que marcan una pregunta o un pedido"
                hint="Una por línea, sin acentos ni signos. Si la consulta tiene alguna, se manda tal cual; si no, se envuelve como «¿Qué publicó El País sobre…?». Acá van verbos como «contame», «haceme» o «mostrame»."
              >
                <textarea className="input" rows={6} value={form.questionMarkersText} onChange={(event) => set('questionMarkersText', event.target.value)} />
              </Field>
            </div>
            <Field label="Hasta cuántas palabras se trata como tema suelto" hint="«Valentina Cancela» es un tema; un pedido de diez palabras no.">
              <input
                className="input input--number"
                type="number"
                min={1}
                max={20}
                value={form.topicMaxWords}
                onChange={(event) => set('topicMaxWords', Number(event.target.value))}
              />
            </Field>

            <div className="form-grid__full">
              <Field
                label="Palabras de panorama"
                hint="Una por línea. Disparan la respuesta con las notas del día en lugar de la búsqueda por tema: «resumen», «titulares», «qué hay de nuevo»."
              >
                <textarea className="input" rows={5} value={form.digestWordsText} onChange={(event) => set('digestWordsText', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field
                label="Anclas al día de hoy"
                hint="Sin alguna de estas, «resumen de las noticias de Peñarol» se responde como tema y no como panorama."
              >
                <textarea className="input" rows={3} value={form.digestTodayText} onChange={(event) => set('digestTodayText', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field
                label="Frases que ya son el pedido completo"
                hint="Valen solas, sin ancla al día, cuando la consulta es corta: «titulares», «portada»."
              >
                <textarea className="input" rows={3} value={form.digestStandaloneText} onChange={(event) => set('digestStandaloneText', event.target.value)} />
              </Field>
            </div>
            <Field label="Largo máximo de esas frases sueltas" hint="En palabras.">
              <input
                className="input input--number"
                type="number"
                min={1}
                max={12}
                value={form.digestMaxWords}
                onChange={(event) => set('digestMaxWords', Number(event.target.value))}
              />
            </Field>
            <Field label="Notas que entran en el panorama" hint="Con muchas la respuesta sale como una lista; con pocas elige y cuenta.">
              <input
                className="input input--number"
                type="number"
                min={3}
                max={20}
                value={form.digestNotes}
                onChange={(event) => set('digestNotes', Number(event.target.value))}
              />
            </Field>
            <div className="form-grid__full">
              <Field label="Secciones que no entran en el panorama" hint="Una por línea, como aparecen en la URL de la nota.">
                <textarea className="input" rows={3} value={form.digestSkipText} onChange={(event) => set('digestSkipText', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field
                label="Orden editorial del panorama"
                hint="Una por línea. Se toma una nota de cada sección por ronda, en este orden; lo que no esté en la lista va después."
              >
                <textarea className="input" rows={4} value={form.digestOrderText} onChange={(event) => set('digestOrderText', event.target.value)} />
              </Field>
            </div>
            <div className="form-grid__full">
              <Field
                label="Secciones que el lector puede pedir por su nombre"
                hint="Una por línea: cómo la nombra el lector = secciones del corpus. Ejemplo: judiciales, judicial = informacion/judiciales. Con esto «resumen de judiciales» arma el panorama de la sección en vez de buscar el tema."
              >
                <textarea className="input" rows={8} value={form.digestSectionsText} onChange={(event) => set('digestSectionsText', event.target.value)} />
              </Field>
            </div>
            <Field label="Días que mira el panorama de una sección" hint="Una sección chica puede no publicar todos los días; con pocos días contesta «no hay nada» de más.">
              <input
                className="input input--number"
                type="number"
                min={1}
                max={60}
                value={form.digestSectionDays}
                onChange={(event) => set('digestSectionDays', Number(event.target.value))}
              />
            </Field>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={saveOpen}
        title="Guardar guardrails"
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
