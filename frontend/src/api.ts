import { demoAnswer, NO_COVERAGE_PREFIX } from './demoData';

export interface Source {
  title: string;
  url: string;
  date: string;
  snippet: string;
}

/**
 * Clasificación del resultado de una consulta.
 * - answer: hay una respuesta respaldada por notas.
 * - no_coverage: El País no cubrió el tema (puede traer notas relacionadas).
 * - off_topic: la pregunta está fuera del dominio del agente.
 *
 * Hoy `off_topic` se decide en el front (heurística, solo en modo demo).
 * Cuando exista el backend, esta clasificación debería venir de la API
 * (por ejemplo con un campo `kind` en la respuesta) y acá solo se mapea.
 */
export type AnswerKind = 'answer' | 'no_coverage' | 'off_topic';

export interface AskResponse {
  kind: AnswerKind;
  answer: string;
  sources: Source[];
}

/** Categorías de error para mostrar mensajes e íconos diferenciados. */
export type ErrorKind = 'network' | 'timeout' | 'server' | 'invalid' | 'config';

export class AskError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = 'AskError';
    this.kind = kind;
  }
}

const configuredUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '');

/**
 * El prototipo corre en modo demo cuando no hay una API real configurada.
 * Consideramos "no real" tanto la ausencia de URL como el placeholder de
 * ejemplo, para que las pruebas manuales funcionen de entrada.
 */
export const isDemoMode =
  !configuredUrl || /example\.execute-api/i.test(configuredUrl);

/**
 * Heurística de "fuera de tema" para el modo demo. Detecta preguntas que
 * claramente no son sobre la actualidad informativa (recetas, código,
 * tareas personales, etc.).
 *
 * OJO: esto es un stub de demostración. El filtro real de dominio lo hace
 * el RAG en el backend; cuando se integre, hay que borrar esta función y
 * leer la clasificación desde la respuesta de la API.
 */
const OFF_TOPIC_PATTERNS = [
  /receta|cocinar|ingrediente/i,
  /\bcódigo\b|programar|javascript|python|función en/i,
  /chiste|adiviná|poema|cuento/i,
  /cuánto es \d|resolvé|matemática|ecuación/i,
  /traducí|traducción/i,
  /consejo (personal|de vida)|qué hago con mi/i,
];

function looksOffTopic(question: string): boolean {
  return OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(question));
}

function endpoint(): string {
  if (!configuredUrl) {
    throw new AskError('config', 'Falta configurar VITE_API_URL para conectar el sitio con la API.');
  }
  return configuredUrl.endsWith('/ask') ? configuredUrl : `${configuredUrl}/ask`;
}

function isSource(value: unknown): value is Source {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.title === 'string' &&
    typeof source.url === 'string' &&
    typeof source.date === 'string' &&
    typeof source.snippet === 'string'
  );
}

/** Clasifica una respuesta ya normalizada (answer + sources) en un AnswerKind. */
function classify(answer: string, sources: Source[]): AnswerKind {
  if (answer.trim().startsWith(NO_COVERAGE_PREFIX)) return 'no_coverage';
  if (sources.length === 0) return 'no_coverage';
  return 'answer';
}

export async function askElPais(question: string): Promise<AskResponse> {
  if (isDemoMode) {
    // Simulamos latencia de red para mostrar el estado de carga.
    await new Promise((resolve) => window.setTimeout(resolve, 900));

    if (looksOffTopic(question)) {
      return {
        kind: 'off_topic',
        answer:
          'Solo puedo responder sobre la actualidad publicada por El País. Probá con una pregunta sobre las noticias de los últimos días.',
        sources: [],
      };
    }

    const demo = demoAnswer(question);
    return { ...demo, kind: classify(demo.answer, demo.sources) };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 32_000);

  let response: Response;
  try {
    response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof AskError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AskError('timeout', 'La consulta demoró demasiado. Probá de nuevo.');
    }
    // fetch rechaza así cuando no hay red o el servidor es inalcanzable.
    throw new AskError('network', 'No pudimos conectar con el servicio. Revisá tu conexión.');
  } finally {
    window.clearTimeout(timer);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage =
      payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).error === 'string'
        ? String((payload as Record<string, unknown>).error)
        : 'No pudimos consultar las noticias en este momento.';
    throw new AskError('server', apiMessage);
  }

  if (!payload || typeof payload !== 'object') {
    throw new AskError('invalid', 'La API devolvió una respuesta inválida.');
  }
  const result = payload as Record<string, unknown>;
  if (typeof result.answer !== 'string' || !Array.isArray(result.sources)) {
    throw new AskError('invalid', 'La API devolvió una respuesta inválida.');
  }

  const answer = result.answer;
  const sources = result.sources.filter(isSource);

  // Cuando el backend agregue un campo `kind`, usarlo directamente en lugar
  // de inferirlo. Por ahora lo derivamos de la respuesta y las fuentes.
  const kind: AnswerKind =
    result.kind === 'off_topic' ? 'off_topic' : classify(answer, sources);

  return { kind, answer, sources };
}
