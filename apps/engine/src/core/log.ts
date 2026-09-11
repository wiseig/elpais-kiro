/**
 * Logs estructurados JSON (sección 15). Nunca incluyen texto de preguntas ni respuestas.
 * Las métricas salen en formato EMF para que CloudWatch las cree sin llamadas a la API.
 */
export type LogLevel = 'info' | 'warn' | 'error';

const NAMESPACE = process.env.METRICS_NAMESPACE ?? 'PreguntaleElPais';
const SERVICE = process.env.SERVICE_NAME ?? 'pelp-engine';
const ENV = process.env.PELP_ENV ?? 'dev';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  metric(name: string, value: number, unit?: 'Count' | 'Milliseconds' | 'None', dimensions?: Record<string, string>): void;
}

function write(level: LogLevel, message: string, fields: Record<string, unknown> | undefined): void {
  const line = JSON.stringify({ level, message, service: SERVICE, env: ENV, at: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger: Logger = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
  metric: (name, value, unit = 'Count', dimensions = {}) => {
    const dims = { Service: SERVICE, Env: ENV, ...dimensions };
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [Object.keys(dims)], Metrics: [{ Name: name, Unit: unit }] }],
        },
        ...dims,
        [name]: value,
      }),
    );
  },
};

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, metric: () => undefined };
