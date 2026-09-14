import { normalizeQuestion } from '@pelp/domain';
import { GOLDEN_SET } from '@pelp/testing';
import type { AdminContext } from '../context';

/**
 * Preguntas de control: las del set dorado, que el smoke test dispara contra la API real en cada
 * despliegue. Entran al log como tráfico de lectores y ensucian tendencias, huecos y métricas, así
 * que se apartan. Los casos creados desde el backoffice no cuentan: esos nacieron de una pregunta
 * real y tienen que seguir viéndose.
 */
const TTL_MS = 60_000;
let cache: { at: number; keys: Set<string> } | undefined;

export async function controlQuestions(ctx: AdminContext): Promise<ReadonlySet<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.keys;
  const cases = await ctx.store.listEvalCases().catch(() => []);
  const keys = new Set<string>();
  // El set dorado que dispara el smoke test vive en el repo, no en la base: borrar un caso desde
  // Calidad no lo saca de las corridas, y si solo miráramos la base volvería a ensuciar los datos.
  for (const item of GOLDEN_SET.cases) {
    const key = normalizeQuestion(item.question);
    if (key) keys.add(key);
  }
  for (const item of cases) {
    if (item.source !== 'golden') continue;
    const key = normalizeQuestion(item.question);
    if (key) keys.add(key);
  }
  cache = { at: Date.now(), keys };
  return keys;
}

/** Solo para los tests: la lista se relee en la próxima llamada. */
export function resetControlCache(): void {
  cache = undefined;
}

export function isControlQuestion(text: string, keys: ReadonlySet<string>): boolean {
  if (!text) return false;
  return keys.has(normalizeQuestion(text));
}
