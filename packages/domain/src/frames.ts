/**
 * Encuadres (frames) de la sección 8.2, revisados con criterio de redacción.
 * Ningún encuadre se corresponde con un partido ni con una posición ideológica.
 */

export interface Frame {
  id: string;
  label: string;
  cares: string;
  /** Si es false, el profiler tiene prohibido usarlo como señal de orientación política. */
  politicalSignal: boolean;
}

export const FRAMES: readonly Frame[] = [
  { id: 'seguridad', label: 'Seguridad y convivencia', cares: 'Delitos, policía, cárceles, violencia, sentirse seguro en el barrio', politicalSignal: true },
  { id: 'costo-de-vida', label: 'Costo de vida y bolsillo', cares: 'Precios, inflación, tarifas, alquileres, salario real, canasta', politicalSignal: true },
  { id: 'empleo', label: 'Empleo y trabajo', cares: 'Desempleo, salarios, negociación colectiva, paros, informalidad', politicalSignal: true },
  { id: 'jubilaciones', label: 'Jubilaciones y seguridad social', cares: 'BPS, edad de retiro, AFAP, pensiones, reforma', politicalSignal: true },
  { id: 'educacion', label: 'Educación', cares: 'Liceos, UTU, Udelar, ANEP, resultados, becas, inicio de clases', politicalSignal: true },
  { id: 'salud', label: 'Salud', cares: 'ASSE, mutualistas, medicamentos, tickets, brotes, vacunas', politicalSignal: true },
  { id: 'vivienda-ciudad', label: 'Vivienda, ciudad y transporte', cares: 'Alquileres, cooperativas, ómnibus, tránsito, siniestros, obras, peajes', politicalSignal: true },
  { id: 'agro', label: 'Agro y producción', cares: 'Ganadería, soja, arroz, sequía, exportaciones, frigoríficos, celulosa', politicalSignal: true },
  { id: 'negocios', label: 'Negocios e inversión', cares: 'Dólar, empresas, zonas francas, inversión extranjera, bolsa', politicalSignal: true },
  { id: 'derechos', label: 'Derechos y libertades', cares: 'Derechos humanos, género, diversidad, pasado reciente, libertad de expresión', politicalSignal: true },
  { id: 'institucionalidad', label: 'Institucionalidad y transparencia', cares: 'Parlamento, contralor, corrupción, Justicia, reglas electorales', politicalSignal: true },
  { id: 'ambiente', label: 'Ambiente, agua y energía', cares: 'Agua potable, energía, clima, contaminación, residuos', politicalSignal: true },
  { id: 'interior', label: 'Interior y territorio', cares: 'Departamentos, intendencias, descentralización, fronteras, rutas', politicalSignal: false },
  { id: 'deporte', label: 'Deporte y pasión', cares: 'Fútbol, selección, Peñarol y Nacional, básquetbol, otros deportes', politicalSignal: false },
  { id: 'cultura', label: 'Cultura e identidad', cares: 'Carnaval, música, cine, libros, patrimonio, espectáculos', politicalSignal: false },
  { id: 'tecnologia', label: 'Tecnología e innovación', cares: 'Startups, IA, ciberseguridad, Ceibal, conectividad', politicalSignal: false },
];

export const FRAME_IDS: readonly string[] = FRAMES.map((frame) => frame.id);

export const NON_POLITICAL_FRAME_IDS: readonly string[] = FRAMES.filter((frame) => !frame.politicalSignal).map(
  (frame) => frame.id,
);

export function frameById(id: string): Frame | undefined {
  return FRAMES.find((frame) => frame.id === id);
}

/**
 * Taxonomía de temas: secciones reales del feed (`categorySlug`, primer segmento).
 * Semilla desde Daily Brief más las que aparecen en el feed.
 */
export const TOPIC_SEED: readonly string[] = [
  'politica',
  'economia',
  'deportes',
  'cultura',
  'internacional',
  'sociedad',
  'nacional',
  'regional',
  'informacion',
  'negocios',
  'el-empresario',
  'mercados',
  'ovacion',
  'tvshow',
  'opinion',
  'mundo',
  'bienestar',
  'vida-actual',
];

/** Normaliza `negocios/empresas` → `negocios`. */
export function topicFromSection(section: string): string {
  return (section.split('/')[0] ?? section).trim().toLowerCase() || 'sin-seccion';
}
