import goldenSet from './golden-set.json';

export interface GoldenCase {
  id: string;
  question: string;
  expectedUrls: string[];
  /**
   * Alternativa a `expectedUrls` para preguntas que dependen del día: el pronóstico o el dólar
   * cambian de nota cada jornada, así que se valida la forma de la URL y no una nota fija.
   */
  expectedUrlPattern?: string;
  expectedCoverage: boolean;
  mustMention: string[];
  mustNotMention: string[];
  tags: string[];
}

export interface GoldenSet {
  version: string;
  corpusDay: string;
  cases: GoldenCase[];
}

export const GOLDEN_SET: GoldenSet = goldenSet as GoldenSet;

/** Las 8 preguntas de prueba del set inicial (criterio de terminado de la fase 0). */
export const PHASE0_CASES: GoldenCase[] = GOLDEN_SET.cases.slice(0, 8);

export * from './synthetic-profiles';
