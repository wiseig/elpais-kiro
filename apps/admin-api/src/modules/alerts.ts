import {
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
  DisableAlarmActionsCommand,
  EnableAlarmActionsCommand,
  PutMetricAlarmCommand,
  type MetricAlarm,
} from '@aws-sdk/client-cloudwatch';
import { ListSubscriptionsByTopicCommand } from '@aws-sdk/client-sns';
import type {
  AlertGroup,
  AlertHistoryEntry,
  AlertHistoryResponse,
  AlertSeverity,
  AlertState,
  AlertSummary,
  AlertsResponse,
  MailingSubscription,
  PanelAlert,
  UpdateAlertRequest,
} from '@pelp/domain/api';
import { HttpError, audit, type AdminContext } from '../context';

interface CatalogEntry {
  key: string;
  /** Nombre de la alarma sin el sufijo de entorno (`pelp-api-5xx`, `pelp-api-5xx-dev`). */
  alarm: string;
  label: string;
  group: AlertGroup;
  severity: AlertSeverity;
  /** Por qué llega el correo: qué se mide y qué lo dispara. */
  why: string;
  /** Qué hacer cuando llega. */
  action: string;
  /** Qué mira la métrica, en palabras. */
  metricLabel: string;
  unit: string;
  /** El mismo nombre en singular, para no escribir «1 corridas fallidas». */
  unitOne?: string;
  minThreshold: number;
  maxThreshold: number;
  stepThreshold: number;
}

/**
 * Las alarmas que el producto manda por correo (sección 15 de la spec). Los umbrales reales
 * viven en CloudWatch; acá está el catálogo con los textos y los rangos que acepta el panel.
 * El orden es el que se ve en la pantalla.
 */
const CATALOG: CatalogEntry[] = [
  {
    key: 'engine-errors',
    alarm: 'pelp-engine-errors',
    label: 'El motor está fallando',
    group: 'Servicio',
    severity: 'critica',
    why: 'La función que responde las preguntas terminó con excepción más veces que el umbral dentro de una misma ventana. Cada error es una pregunta que el lector vio fallar: no hubo respuesta, ni siquiera una canónica.',
    action: 'Mirá los logs de la Lambda del motor. Si el problema es Bedrock (cuota, modelo caído), suele resolverse solo; si no, desde Configuración se puede pausar el servicio con el kill switch hasta arreglarlo.',
    metricLabel: 'Errores de la Lambda del motor, sumados por ventana',
    unit: 'errores',
    unitOne: 'error',
    minThreshold: 1,
    maxThreshold: 200,
    stepThreshold: 1,
  },
  {
    key: 'api-5xx',
    alarm: 'pelp-api-5xx',
    label: 'La API pública devuelve errores',
    group: 'Servicio',
    severity: 'critica',
    why: 'Porcentaje de llamadas a la API pública que terminan en error de servidor (5xx). Se calcula sobre el total de llamadas de cada ventana, así que un pico de tráfico no lo dispara solo: tiene que fallar de verdad una porción de las respuestas.',
    action: 'Cruzalo con «El motor está fallando»: si saltan las dos, el problema está en el motor. Si salta sola, mirá API Gateway (throttling, timeouts de 29 s).',
    metricLabel: '% de respuestas 5xx sobre el total de llamadas',
    unit: '%',
    minThreshold: 0.1,
    maxThreshold: 50,
    stepThreshold: 0.1,
  },
  {
    key: 'api-latency-p95',
    alarm: 'pelp-api-latency-p95',
    label: 'Las respuestas tardan demasiado',
    group: 'Servicio',
    severity: 'importante',
    why: 'Latencia p95 de la API: el tiempo por debajo del cual se resuelven 95 de cada 100 preguntas. Cuando pasa el umbral, uno de cada veinte lectores está esperando más que eso.',
    action: 'Suele ser recuperación lenta de la Knowledge Base o un modelo saturado. Mirá el dashboard de CloudWatch; si el gasto está cerca del presupuesto, la canónica ya está usando el modelo económico y eso también mueve la latencia.',
    metricLabel: 'Latencia p95 de la API pública',
    unit: 'ms',
    minThreshold: 1000,
    maxThreshold: 30_000,
    stepThreshold: 500,
  },
  {
    key: 'grounding-failures',
    alarm: 'pelp-grounding-failures',
    label: 'Respuestas sin sustento en las notas',
    group: 'Calidad',
    severity: 'critica',
    why: 'El motor puntúa cada respuesta contra las notas que cita; si el puntaje no llega al umbral de grounding de Configuración, la cuenta como fallo. Esta alarma mira qué porcentaje de las preguntas de la ventana fallaron así. Es la defensa contra respuestas inventadas.',
    action: 'Entrá a Preguntas y filtrá por las que no tuvieron cobertura: o el corpus no tiene la nota (mirá Corpus y el último sync) o el modelo se está yendo de tema. El umbral de grounding se ajusta en Configuración.',
    metricLabel: '% de respuestas que no alcanzaron el umbral de grounding',
    unit: '%',
    minThreshold: 1,
    maxThreshold: 100,
    stepThreshold: 1,
  },
  {
    key: 'bias-fact-divergence',
    alarm: 'pelp-bias-fact-divergence',
    label: 'La personalización cambió hechos',
    group: 'Calidad',
    severity: 'critica',
    why: 'El reporte de sesgo compara cada respuesta personalizada contra la canónica. Puede cambiar el orden, el énfasis o el tono; no puede cambiar los hechos ni las citas. Cualquier divergencia de hechos dispara esta alarma, y el propio reporte baja la intensidad solo.',
    action: 'Andá a Personalización: ahí están las dos versiones de cada muestra. Hasta que alguien revise y vuelva a subir la intensidad a mano, queda en el último valor con reporte limpio.',
    metricLabel: 'Divergencias de hechos detectadas por el reporte de sesgo',
    unit: 'divergencias',
    unitOne: 'divergencia',
    minThreshold: 0,
    maxThreshold: 20,
    stepThreshold: 1,
  },
  {
    key: 'budget-80',
    alarm: 'pelp-budget-80',
    label: 'Presupuesto del día al 80 %',
    group: 'Costos',
    severity: 'aviso',
    why: 'Porcentaje del presupuesto diario ya gastado en llamadas a los modelos. Es el aviso temprano: a partir de este punto la respuesta canónica pasa al modelo económico para estirar lo que queda del día.',
    action: 'Mirá Costos para ver qué modelo se llevó el gasto. Si es un día con tráfico real y no un bucle, subí el presupuesto diario en Configuración.',
    metricLabel: '% del presupuesto diario consumido',
    unit: '%',
    minThreshold: 10,
    maxThreshold: 100,
    stepThreshold: 5,
  },
  {
    key: 'budget-100',
    alarm: 'pelp-budget-100',
    label: 'Presupuesto del día agotado',
    group: 'Costos',
    severity: 'importante',
    why: 'El gasto del día llegó al presupuesto completo. Desde acá se aplica lo que diga «al pasarse del presupuesto» en Configuración: seguir con el modelo de respaldo o dejar de responder hasta que cambie el día.',
    action: 'Decidí en Configuración: subir el presupuesto o dejar que corra el modo de respaldo. El contador se reinicia a la medianoche de Montevideo.',
    metricLabel: '% del presupuesto diario consumido',
    unit: '%',
    minThreshold: 50,
    maxThreshold: 200,
    stepThreshold: 5,
  },
  {
    key: 'sync-failed-3x',
    alarm: 'pelp-sync-failed-3x',
    label: 'El corpus dejó de actualizarse',
    group: 'Corpus',
    severity: 'importante',
    why: 'El sync del feed corre cada hora y reintenta solo; una falla aislada no avisa nada. Esta alarma espera a que falle varias corridas seguidas, que es cuando el corpus empieza a quedarse sin las notas del día y el asistente responde sobre un diario viejo.',
    action: 'Entrá a Trabajos programados y mirá el detalle de las últimas corridas de «Sincronizar feed». Desde ahí mismo se puede disparar a mano una vez arreglado el origen.',
    metricLabel: 'Corridas del sync que terminaron mal, por ventana',
    unit: 'corridas fallidas',
    unitOne: 'corrida fallida',
    minThreshold: 1,
    maxThreshold: 10,
    stepThreshold: 1,
  },
  {
    key: 'inbound-age',
    alarm: 'pelp-inbound-age',
    label: 'Mensajes encolados sin responder',
    group: 'Servicio',
    severity: 'importante',
    why: 'Las preguntas que llegan por WhatsApp y Discord entran a una cola antes de procesarse. Esto mide cuánto lleva esperando el mensaje más viejo: si pasa el umbral, hay gente esperando respuesta y algo trabó el consumo.',
    action: 'Revisá si el motor está fallando (las otras dos alarmas de servicio) y mirá Canales. Los mensajes no se pierden: se procesan cuando el consumo se destraba.',
    metricLabel: 'Antigüedad del mensaje más viejo en la cola de entrada',
    unit: 's',
    minThreshold: 60,
    maxThreshold: 3600,
    stepThreshold: 30,
  },
];

/** Los nombres llevan el sufijo del entorno, igual que el resto de los recursos `pelp-*`. */
function suffix(ctx: AdminContext): string {
  const explicit = ctx.env.ALARM_SUFFIX;
  if (explicit !== undefined) return explicit;
  const env = ctx.env.PELP_ENV ?? 'dev';
  return env === 'prod' ? '' : `-${env}`;
}

function alarmName(ctx: AdminContext, entry: CatalogEntry): string {
  return `${entry.alarm}${suffix(ctx)}`;
}

function entryOf(key: string): CatalogEntry {
  const entry = CATALOG.find((item) => item.key === key);
  if (!entry) throw new HttpError(404, 'Esa alerta no existe.', 'not_found');
  return entry;
}

const COMPARISON_SYMBOL: Record<string, string> = {
  GreaterThanThreshold: '>',
  GreaterThanOrEqualToThreshold: '≥',
  LessThanThreshold: '<',
  LessThanOrEqualToThreshold: '≤',
};

function stateOf(value: string | undefined): AlertState {
  if (value === 'ALARM') return 'alarma';
  if (value === 'OK') return 'ok';
  if (value === 'INSUFFICIENT_DATA') return 'sin_datos';
  return 'desconocido';
}

/**
 * Las alarmas de expresión (5xx, grounding) no traen `Period` arriba: está adentro de cada
 * consulta. Se busca en los dos lugares para poder escribir «ventanas de N minutos».
 */
export function periodMinutesOf(alarm: MetricAlarm): number {
  const seconds =
    alarm.Period ??
    alarm.Metrics?.find((item) => item.Period !== undefined)?.Period ??
    alarm.Metrics?.find((item) => item.MetricStat?.Period !== undefined)?.MetricStat?.Period ??
    0;
  return seconds > 0 ? Math.round(seconds / 60) : 0;
}

/** El número tal como se escribe: sin decimales cuando es entero. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function windowLabel(minutes: number): string {
  if (minutes <= 0) return 'cada ventana';
  if (minutes % 1440 === 0) return `${minutes / 1440} día${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0) return `${minutes / 60} hora${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutos`;
}

/** La condición en castellano, con los valores que tiene hoy la alarma. */
export function describeCondition(entry: CatalogEntry, alarm: MetricAlarm): string {
  const symbol = COMPARISON_SYMBOL[alarm.ComparisonOperator ?? ''] ?? '>';
  const value = alarm.Threshold ?? 0;
  const unit = value === 1 && entry.unitOne ? entry.unitOne : entry.unit;
  const threshold = `${num(value)}${unit === '%' ? ' %' : ` ${unit}`}`;
  const window = windowLabel(periodMinutesOf(alarm));
  const needed = alarm.DatapointsToAlarm ?? alarm.EvaluationPeriods ?? 1;
  const total = alarm.EvaluationPeriods ?? 1;
  const repeat =
    total <= 1
      ? `en una ventana de ${window}`
      : needed === total
        ? `en ${total} ventanas seguidas de ${window}`
        : `en ${needed} de ${total} ventanas de ${window}`;
  return `Salta si ${entry.metricLabel.toLocaleLowerCase('es')} ${symbol} ${threshold} ${repeat}.`;
}

function toSummary(ctx: AdminContext, entry: CatalogEntry, alarm: MetricAlarm | undefined): AlertSummary {
  const base = {
    key: entry.key,
    label: entry.label,
    group: entry.group,
    severity: entry.severity,
    why: entry.why,
    action: entry.action,
    metricLabel: entry.metricLabel,
    unit: entry.unit,
    ...(entry.unitOne ? { unitOne: entry.unitOne } : {}),
    minThreshold: entry.minThreshold,
    maxThreshold: entry.maxThreshold,
    stepThreshold: entry.stepThreshold,
    alarmName: alarmName(ctx, entry),
  };
  if (!alarm) {
    return {
      ...base,
      condition: 'La alarma todavía no existe en la cuenta: se crea al desplegar la infraestructura.',
      threshold: 0,
      comparisonOperator: '',
      comparison: '>',
      evaluationPeriods: 0,
      datapointsToAlarm: 0,
      periodMinutes: 0,
      state: 'desconocido',
      notifying: false,
      configurable: false,
      missing: true,
    };
  }
  return {
    ...base,
    condition: describeCondition(entry, alarm),
    threshold: alarm.Threshold ?? 0,
    comparisonOperator: alarm.ComparisonOperator ?? '',
    comparison: COMPARISON_SYMBOL[alarm.ComparisonOperator ?? ''] ?? '>',
    evaluationPeriods: alarm.EvaluationPeriods ?? 1,
    datapointsToAlarm: alarm.DatapointsToAlarm ?? alarm.EvaluationPeriods ?? 1,
    periodMinutes: periodMinutesOf(alarm),
    state: stateOf(alarm.StateValue),
    ...(alarm.StateReason ? { stateReason: alarm.StateReason } : {}),
    ...(alarm.StateUpdatedTimestamp ? { stateChangedAt: new Date(alarm.StateUpdatedTimestamp).toISOString() } : {}),
    notifying: alarm.ActionsEnabled !== false && (alarm.AlarmActions ?? []).length > 0,
    configurable: true,
    missing: false,
  };
}

async function describeAll(ctx: AdminContext): Promise<{ found: Map<string, MetricAlarm>; error?: string }> {
  const names = CATALOG.map((entry) => alarmName(ctx, entry));
  const found = new Map<string, MetricAlarm>();
  try {
    const page = await ctx.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: names, AlarmTypes: ['MetricAlarm'] }));
    for (const alarm of page.MetricAlarms ?? []) if (alarm.AlarmName) found.set(alarm.AlarmName, alarm);
  } catch (error) {
    // Sin permisos o sin red se muestra el catálogo igual: los textos del «por qué» valen solos.
    // El aviso importa porque si no, una lectura fallida se lee como «no está desplegada».
    console.warn(JSON.stringify({ level: 'warn', message: 'alerts.describe_failed', error: String(error) }));
    return { found, error: 'No se pudieron leer las alarmas de CloudWatch: lo que sigue es el catálogo, sin los umbrales ni el estado reales.' };
  }
  return { found };
}

/** Quiénes reciben los correos de alarma. Es la misma lista que se edita en Listas de correo. */
async function recipients(ctx: AdminContext): Promise<{ items: MailingSubscription[]; topicArn: string; error?: string }> {
  const topicArn = ctx.env.ALERTS_TOPIC_ARN ?? '';
  if (!topicArn) return { items: [], topicArn: '' };
  const items: MailingSubscription[] = [];
  try {
    const page = await ctx.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
    for (const item of page.Subscriptions ?? []) {
      if (item.Protocol !== 'email' && item.Protocol !== 'email-json') continue;
      const pending = !item.SubscriptionArn || !item.SubscriptionArn.startsWith('arn:');
      items.push({ email: item.Endpoint ?? '', confirmed: !pending, ...(pending ? {} : { subscriptionArn: item.SubscriptionArn ?? '' }) });
    }
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'alerts.recipients_failed', error: String(error) }));
    return { items, topicArn, error: 'No se pudo leer la lista de alarmas en SNS: no sabemos a quién le están llegando.' };
  }
  items.sort((a, b) => a.email.localeCompare(b.email, 'es'));
  return { items, topicArn };
}

/**
 * Los avisos que arma Inicio con la configuración vigente. No salen por correo: se ven en el
 * panel. Se listan acá para que en una sola pantalla esté todo lo que puede avisar algo.
 */
async function panelAlerts(ctx: AdminContext): Promise<PanelAlert[]> {
  const config = await ctx.config.get();
  const pct = (value: number): string => `${Math.round(value * 100)} %`;
  return [
    {
      key: 'service-paused',
      label: 'El servicio está pausado',
      why: 'Alguien bajó el kill switch: el asistente no responde ninguna pregunta en ningún canal. Aparece en Inicio hasta que se vuelva a prender.',
      condition: config.service.enabled ? 'Hoy el servicio está activo.' : 'Ahora mismo está pausado.',
      settingLabel: 'Configuración → Servicio → kill switch',
    },
    {
      key: 'budget-soft',
      label: 'Presupuesto del día en la zona blanda',
      why: 'El gasto del día pasó el porcentaje blando del presupuesto. Desde ese punto la respuesta canónica usa el modelo económico, antes de que llegue a agotarse.',
      condition: `Avisa al ${config.limits.budgetSoftPercent} % de US$ ${config.limits.dailyBudgetUsd} por día.`,
      settingLabel: 'Configuración → Límites → presupuesto diario y % blando',
    },
    {
      key: 'budget-exceeded',
      label: 'Presupuesto del día superado',
      why: 'El gasto llegó al 100 % del presupuesto diario. A partir de ahí se aplica lo elegido para «al pasarse»: responder con el modelo de respaldo o dejar de responder.',
      condition: `Al 100 % de US$ ${config.limits.dailyBudgetUsd}: modo «${config.limits.onBudgetExceeded === 'pause' ? 'pausar' : 'respaldo'}».`,
      settingLabel: 'Configuración → Límites → al pasarse del presupuesto',
    },
    {
      key: 'sync-failed',
      label: 'Último sync fallido',
      why: 'La última corrida del sync del feed terminó mal. Con una sola falla ya se ve en Inicio; recién cuando son varias seguidas sale además el correo de «El corpus dejó de actualizarse».',
      condition: 'Avisa con una sola corrida fallida.',
    },
    {
      key: 'auto-lowered',
      label: 'La intensidad de personalización fue bajada sola',
      why: 'El reporte de sesgo encontró divergencias y bajó la intensidad al último valor con reporte limpio. El aviso queda hasta que una persona la vuelva a subir a mano.',
      condition: config.personalization.autoLowered ? 'Está bajada automáticamente ahora mismo.' : 'Hoy no está bajada.',
      settingLabel: 'Personalización → intensidad',
    },
    {
      key: 'intensity-over-hardmax',
      label: 'La intensidad supera el techo',
      why: 'La intensidad quedó por encima del techo duro. Puede pasar tras un rollback de configuración; el motor recorta igual al techo, pero conviene dejarlo coherente.',
      condition: `Techo actual: ${pct(config.personalization.hardMax)} · intensidad: ${pct(config.personalization.intensity)}.`,
      settingLabel: 'Configuración → Personalización → intensidad y techo',
    },
    {
      key: 'grounding-today',
      label: 'Más del 10 % de las respuestas de hoy fallaron grounding',
      why: 'La misma idea que la alarma por correo, pero contada sobre el día entero y con las preguntas ya registradas. Solo se muestra si hubo al menos diez respuestas, para que un par de casos no lo disparen.',
      condition: `Fijo en 10 % del día, contra el umbral de grounding de ${pct(config.answering.groundingThreshold)}.`,
      settingLabel: 'Configuración → Respuestas → umbral de grounding',
    },
  ];
}

export async function listAlerts(ctx: AdminContext): Promise<AlertsResponse> {
  const [alarms, mail, panel] = await Promise.all([describeAll(ctx), recipients(ctx), panelAlerts(ctx)]);
  const alerts = CATALOG.map((entry) => toSummary(ctx, entry, alarms.found.get(alarmName(ctx, entry))));
  const readError = [alarms.error, mail.error].filter(Boolean).join(' ');
  return {
    alerts,
    panel,
    recipients: mail.items,
    alertsTopicArn: mail.topicArn,
    missingCount: alerts.filter((alert) => alert.missing).length,
    ...(readError ? { readError } : {}),
  };
}

async function describeOne(ctx: AdminContext, name: string): Promise<MetricAlarm> {
  const page = await ctx.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [name], AlarmTypes: ['MetricAlarm'] }));
  const alarm = (page.MetricAlarms ?? [])[0];
  if (!alarm) throw new HttpError(404, `La alarma «${name}» no existe en la cuenta. Falta desplegar la infraestructura.`, 'not_found');
  return alarm;
}

/**
 * `PutMetricAlarm` reemplaza la alarma entera, así que hay que volver a mandar todo lo que ya
 * tenía. Las alarmas de expresión (5xx, grounding) llevan `Metrics` y no aceptan métrica suelta.
 */
function putInput(alarm: MetricAlarm, threshold: number, evaluationPeriods: number): PutMetricAlarmCommand['input'] {
  const datapoints = alarm.DatapointsToAlarm ?? alarm.EvaluationPeriods ?? 1;
  const common = {
    AlarmName: alarm.AlarmName ?? '',
    ...(alarm.AlarmDescription ? { AlarmDescription: alarm.AlarmDescription } : {}),
    ActionsEnabled: alarm.ActionsEnabled ?? true,
    ...(alarm.OKActions?.length ? { OKActions: alarm.OKActions } : {}),
    ...(alarm.AlarmActions?.length ? { AlarmActions: alarm.AlarmActions } : {}),
    ...(alarm.InsufficientDataActions?.length ? { InsufficientDataActions: alarm.InsufficientDataActions } : {}),
    EvaluationPeriods: evaluationPeriods,
    // Si antes pedía todos los puntos, se mantiene esa exigencia con el nuevo largo.
    DatapointsToAlarm: datapoints >= (alarm.EvaluationPeriods ?? 1) ? evaluationPeriods : Math.min(datapoints, evaluationPeriods),
    Threshold: threshold,
    ComparisonOperator: alarm.ComparisonOperator,
    ...(alarm.TreatMissingData ? { TreatMissingData: alarm.TreatMissingData } : {}),
  };
  if (alarm.Metrics?.length) return { ...common, Metrics: alarm.Metrics };
  return {
    ...common,
    ...(alarm.Namespace ? { Namespace: alarm.Namespace } : {}),
    ...(alarm.MetricName ? { MetricName: alarm.MetricName } : {}),
    ...(alarm.Dimensions?.length ? { Dimensions: alarm.Dimensions } : {}),
    ...(alarm.Statistic ? { Statistic: alarm.Statistic } : {}),
    ...(alarm.ExtendedStatistic ? { ExtendedStatistic: alarm.ExtendedStatistic } : {}),
    ...(alarm.Period ? { Period: alarm.Period } : {}),
    ...(alarm.Unit ? { Unit: alarm.Unit } : {}),
  };
}

export async function updateAlert(ctx: AdminContext, key: string, body: UpdateAlertRequest): Promise<AlertsResponse> {
  const entry = entryOf(key);
  const name = alarmName(ctx, entry);
  const alarm = await describeOne(ctx, name);

  let threshold = alarm.Threshold ?? 0;
  if (body.threshold !== undefined) {
    const value = Number(body.threshold);
    if (!Number.isFinite(value)) throw new HttpError(400, 'El umbral tiene que ser un número.', 'bad_request');
    if (value < entry.minThreshold || value > entry.maxThreshold) {
      throw new HttpError(400, `El umbral de «${entry.label}» tiene que estar entre ${num(entry.minThreshold)} y ${num(entry.maxThreshold)} ${entry.unit}.`, 'bad_request');
    }
    threshold = value;
  }

  let evaluationPeriods = alarm.EvaluationPeriods ?? 1;
  if (body.evaluationPeriods !== undefined) {
    const value = Math.round(Number(body.evaluationPeriods));
    if (!Number.isFinite(value) || value < 1 || value > 10) throw new HttpError(400, 'Las ventanas seguidas tienen que ir de 1 a 10.', 'bad_request');
    evaluationPeriods = value;
  }

  const before = { threshold: alarm.Threshold, evaluationPeriods: alarm.EvaluationPeriods, actionsEnabled: alarm.ActionsEnabled };
  const changedThreshold = body.threshold !== undefined || body.evaluationPeriods !== undefined;
  if (changedThreshold) await ctx.cloudwatch.send(new PutMetricAlarmCommand(putInput(alarm, threshold, evaluationPeriods)));
  if (body.notifying === true) await ctx.cloudwatch.send(new EnableAlarmActionsCommand({ AlarmNames: [name] }));
  if (body.notifying === false) await ctx.cloudwatch.send(new DisableAlarmActionsCommand({ AlarmNames: [name] }));
  if (!changedThreshold && body.notifying === undefined) throw new HttpError(400, 'No viene nada para cambiar.', 'bad_request');

  await audit(ctx, 'alerts.update', key, {
    before,
    after: { threshold, evaluationPeriods, actionsEnabled: body.notifying ?? alarm.ActionsEnabled },
  });
  return listAlerts(ctx);
}

const HISTORY_KIND: Record<string, AlertHistoryEntry['kind']> = {
  ALARM: 'alarma',
  OK: 'ok',
  INSUFFICIENT_DATA: 'sin_datos',
};

interface AlarmHistoryData {
  newState?: { stateValue?: string; stateReason?: string };
}

/** El historial contesta la pregunta de siempre: por qué llegó ese correo y a qué hora. */
export async function alertHistory(ctx: AdminContext, key: string): Promise<AlertHistoryResponse> {
  const entry = entryOf(key);
  const name = alarmName(ctx, entry);
  let history;
  try {
    history = await ctx.cloudwatch.send(
      new DescribeAlarmHistoryCommand({ AlarmName: name, HistoryItemType: 'StateUpdate', MaxRecords: 20, ScanBy: 'TimestampDescending' }),
    );
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'alerts.history_failed', alarm: name, error: String(error) }));
    return { key, items: [], note: 'No se pudo leer el historial de CloudWatch.' };
  }
  const items: AlertHistoryEntry[] = [];
  for (const record of history.AlarmHistoryItems ?? []) {
    if (!record.Timestamp) continue;
    let parsed: AlarmHistoryData = {};
    try {
      parsed = JSON.parse(record.HistoryData ?? '{}') as AlarmHistoryData;
    } catch {
      parsed = {};
    }
    items.push({
      at: new Date(record.Timestamp).toISOString(),
      kind: HISTORY_KIND[parsed.newState?.stateValue ?? ''] ?? 'configuracion',
      summary: parsed.newState?.stateReason ?? record.HistorySummary ?? 'Sin detalle.',
    });
  }
  return {
    key,
    items,
    ...(items.length ? {} : { note: 'CloudWatch no registró cambios de estado: la alarma nunca saltó (guarda dos semanas de historial).' }),
  };
}

export const ALERT_CATALOG = CATALOG;
