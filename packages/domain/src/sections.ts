/**
 * Nombre legible de una sección a partir de su slug ("informacion/politica" → "Política").
 *
 * El índice guarda la sección completa que dice la URL, no solo el primer segmento: hasta el
 * 15/9/2026 se guardaba achatada y las notas de política salían etiquetadas "Información". Pero
 * no toda subsección es una etiqueta mejor que su padre: "negocios/noticias" no merece decir
 * "Noticias", ni "tvshow/personajes" "Personajes", ni "opinion/ecos" "Ecos". La regla: si el
 * último segmento es una sección conocida, se usa su nombre; si no, el del primer segmento; y
 * solo como último recurso se prettifica el slug. Así "Política", "Fútbol" o "Policiales" ganan
 * visibilidad y lo genérico cae al padre en vez de a un slug crudo capitalizado.
 */
export const SECTION_LABELS: Readonly<Record<string, string>> = {
  // Secciones de primer nivel.
  informacion: 'Información',
  opinion: 'Opinión',
  ovacion: 'Ovación',
  negocios: 'Negocios',
  tvshow: 'TV Show',
  bienestar: 'Bienestar',
  mundo: 'Mundo',
  'vida-actual': 'Vida Actual',
  rurales: 'Rurales',
  'expo-prado': 'Expo Prado',
  'el-empresario': 'El Empresario',
  espectaculos: 'Espectáculos',
  cultura: 'Cultura',
  deportes: 'Deportes',
  economia: 'Economía',
  nacional: 'Nacional',
  internacional: 'Internacional',
  horoscopo: 'Horóscopo',
  domingo: 'Domingo',
  // Subsecciones que sí le dicen algo al lector.
  politica: 'Política',
  judiciales: 'Judiciales',
  policiales: 'Policiales',
  educacion: 'Educación',
  servicios: 'Servicios',
  sociedad: 'Sociedad',
  salud: 'Salud',
  futbol: 'Fútbol',
  basquetbol: 'Básquetbol',
  turf: 'Turf',
  finanzas: 'Finanzas',
  empresas: 'Empresas',
  mercados: 'Mercados',
  tecnologia: 'Tecnología',
  ciencia: 'Ciencia',
  cine: 'Cine',
  series: 'Series',
  musica: 'Música',
  editorial: 'Editorial',
  argentina: 'Argentina',
  espana: 'España',
  'estados-unidos': 'Estados Unidos',
  nutricion: 'Nutrición',
  fitness: 'Fitness',
};

function prettify(slug: string): string {
  const spaced = slug.replace(/-+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : '';
}

export function sectionLabel(slug: string): string {
  const segments = slug.trim().toLowerCase().split('/').filter(Boolean);
  if (!segments.length) return '';
  const last = segments[segments.length - 1] ?? '';
  const first = segments[0] ?? '';
  return SECTION_LABELS[last] ?? SECTION_LABELS[first] ?? prettify(first);
}
