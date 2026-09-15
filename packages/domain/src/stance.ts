import type { PoliticalBucket, PoliticalLean } from './types';

/**
 * Cálculo de la orientación del lector a partir de posturas observadas. El modelo dice de qué
 * habla y si está a favor o en contra; de qué lado queda el lector lo resuelve esta función.
 *
 * El motivo es concreto: pedirle la etiqueta al modelo daba el resultado invertido en las ocho
 * corridas que medimos, con tres prompts y dos modelos. La inversión es una multiplicación de
 * signos, y eso lo hace bien una función y mal un modelo de lenguaje.
 */
export type StanceTarget = 'izquierda' | 'derecha' | 'centro' | 'ninguno';
export type StanceSide = 'rechaza' | 'apoya';

export interface Stance {
  cita: string;
  objetivo: StanceTarget;
  postura: StanceSide;
}

/** Dirección del objetivo en el eje: -1 izquierda, +1 derecha. */
const DIRECTION: Record<StanceTarget, number> = { izquierda: -1, derecha: 1, centro: 0, ninguno: 0 };

export function isStance(value: unknown): value is Stance {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.cita === 'string' &&
    item.cita.trim().length > 0 &&
    (item.objetivo === 'izquierda' || item.objetivo === 'derecha' || item.objetivo === 'centro' || item.objetivo === 'ninguno') &&
    (item.postura === 'rechaza' || item.postura === 'apoya')
  );
}

export interface StanceResult extends PoliticalLean {
  /** Posturas que aportaron señal: las de objetivo "centro" o "ninguno" no suman. */
  usable: number;
  /** Cuánto coinciden entre sí, de 0 a 1. */
  agreement: number;
}

function bucketFor(score: number): PoliticalBucket {
  if (score <= -0.6) return 'izquierda';
  if (score <= -0.2) return 'centro-izquierda';
  if (score < 0.2) return 'centro';
  if (score < 0.6) return 'centro-derecha';
  return 'derecha';
}

/**
 * Rechazar a la izquierda empuja a la derecha; apoyarla, a la izquierda. Un solo lugar donde se
 * hace la cuenta, y con signo explícito para que se pueda leer.
 */
export function scoreStances(stances: readonly Stance[]): StanceResult {
  const values = stances
    .map((stance) => DIRECTION[stance.objetivo] * (stance.postura === 'rechaza' ? -1 : 1))
    .filter((value) => value !== 0);
  if (!values.length) return { score: 0, bucket: 'sin-señal', confidence: 0, usable: 0, agreement: 0 };

  const score = values.reduce((sum, value) => sum + value, 0) / values.length;
  // Coherencia: 1 si todas apuntan al mismo lado, 0 si se reparten en partes iguales.
  const agreement = Math.abs(score);
  // La confianza crece con la evidencia y se corta por la coherencia: seis frases contradictorias
  // no valen más que ninguna.
  const evidence = Math.min(1, values.length / 6);
  const confidence = Math.min(0.95, Math.round(agreement * evidence * 100) / 100);
  return {
    score: Math.round(score * 100) / 100,
    bucket: agreement === 0 ? 'sin-señal' : bucketFor(score),
    confidence,
    usable: values.length,
    agreement: Math.round(agreement * 100) / 100,
  };
}
