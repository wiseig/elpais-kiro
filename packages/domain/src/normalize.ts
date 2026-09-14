/**
 * Normalización de preguntas para caché y tendencias (6.5). Sin dependencias de Node.
 * Mantiene acentos y eñes: son parte del español y distinguen preguntas.
 */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[¿¡]/g, '')
    .replace(/[?!.,;:'"“”‘’«»()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recorta y colapsa espacios sin cambiar el contenido. */
export function cleanQuestion(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const AMBIGUOUS_PRONOUNS =
  /\b(él|ella|ellos|ellas|eso|esto|aquello|le|les)\b|\b(ese|esa|esos|esas|este|esta|estos|estas|aquel|aquella)\b(?!\s+\p{L})|^\s*¿?\s*y\b/iu;

/**
 * Regla de 6.4: la reescritura resuelve referencias con la conversación. Sin turnos previos
 * solo corre si hay pronombres ambiguos: antes también corría en preguntas de hasta 6
 * palabras y el modelo liviano inventaba tema ("Valentina Cancela" → "qué dijo Valentina
 * Cancela sobre el presupuesto", 13/9/2026). Los temas sueltos los arma el motor.
 */
export function needsRewrite(question: string, hasHistory: boolean): boolean {
  if (hasHistory) return true;
  return AMBIGUOUS_PRONOUNS.test(question.trim());
}

/**
 * Preguntas ancladas al presente ("¿cómo va a estar el tiempo el finde?", "¿cómo cerró el
 * dólar hoy?"). Con notas viejas hay que decir de cuándo son en vez de darlas por vigentes.
 */
const PRESENT_ANCHORS =
  /\b(hoy|ahora|ahora mismo|actual|actualmente|vigente|reci[eé]n|[uú]ltima hora|ma[nñ]ana|pasado ma[nñ]ana|anoche|esta (mañana|tarde|noche|semana|semana|jornada)|este (finde|fin de semana|mes|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|fin de semana|finde|pr[oó]xim[oa]s? (d[ií]as|horas|semana)|en estos d[ií]as|va a (estar|llover|hacer)|c[oó]mo est[aá]|qu[eé] tiempo)\b/i;

export function isTimeSensitive(question: string): boolean {
  return PRESENT_ANCHORS.test(question.normalize('NFC'));
}

/** Sin acentos y en minúsculas: `\b` de JavaScript no reconoce las vocales acentuadas. */
export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Listas que deciden cómo se lee una consulta. Viven en la configuración para que la redacción
 * pueda agregar formas nuevas sin tocar código ni desplegar.
 */
export interface IntentWords {
  /** Marcan que la consulta ya es una pregunta o un pedido, no un tema suelto. */
  questionMarkers: readonly string[];
  /** Hasta cuántas palabras se considera tema suelto y se envuelve en "¿Qué publicó El País sobre…?". */
  topicMaxWords: number;
  /** Palabras de panorama: resumen, titulares, qué hay de nuevo. */
  digestWords: readonly string[];
  /** Anclas al día en curso, sin las cuales "resumen de X" es un pedido sobre X. */
  digestToday: readonly string[];
  /** Frases que por sí solas ya son el pedido completo ("titulares", "portada"). */
  digestStandalone: readonly string[];
  /** Hasta cuántas palabras vale una frase suelta como pedido de panorama. */
  digestMaxWords: number;
  /** Secciones del diario que el lector puede pedir por su nombre. */
  digestSections: readonly DigestSection[];
}

/** Una sección del diario: cómo la nombra el lector y qué categorías del corpus le tocan. */
export interface DigestSection {
  /** Formas en que el lector la escribe. La primera es la que se usa al contestar. */
  names: string[];
  /** Prefijos de categoría del corpus que entran ("informacion/judiciales", "ovacion"). */
  match: string[];
}

/**
 * Las secciones de elpais.com.uy. "Resumen de judiciales" no es un tema suelto: es el
 * panorama de una sección. Sin esta lista el clasificador de alcance lo daba por fuera de
 * tema (14/9/2026) y, si pasaba, la búsqueda semántica traía cualquier cosa.
 * Los nombres son los que usa el lector; `match` son las categorías tal como vienen del feed.
 */
export const DEFAULT_DIGEST_SECTIONS: DigestSection[] = [
  { names: ['judiciales', 'judicial'], match: ['informacion/judiciales'] },
  { names: ['policiales', 'policial'], match: ['informacion/policiales'] },
  { names: ['sindicales', 'sindical'], match: ['informacion/sindicales'] },
  { names: ['en clave pais'], match: ['informacion/en-clave-pais'] },
  { names: ['educacion'], match: ['informacion/educacion'] },
  { names: ['sociedad'], match: ['informacion/sociedad'] },
  { names: ['servicios'], match: ['informacion/servicios'] },
  { names: ['politica'], match: ['informacion/politica'] },
  { names: ['salud'], match: ['informacion/salud', 'bienestar'] },
  { names: ['mundo', 'internacionales', 'internacional'], match: ['mundo'] },
  { names: ['deportes', 'deporte', 'ovacion'], match: ['ovacion'] },
  { names: ['economia', 'negocios', 'mercados', 'finanzas'], match: ['negocios', 'mercados', 'economia', 'el-empresario'] },
  { names: ['opinion', 'editoriales', 'columnas'], match: ['opinion'] },
  { names: ['espectaculos', 'cultura', 'tvshow'], match: ['tvshow'] },
  { names: ['tecnologia'], match: ['vida-actual/tecnologia'] },
  { names: ['informacion', 'nacionales'], match: ['informacion'] },
];

export const DEFAULT_INTENT_WORDS: IntentWords = {
  questionMarkers: [
    'que', 'quien', 'quienes', 'cual', 'cuales', 'como', 'cuando', 'donde', 'cuanto', 'cuanta', 'cuantos', 'cuantas',
    'porque', 'hay', 'hubo', 'paso', 'pasa', 'dijo', 'dice', 'contame', 'contanos', 'conta', 'explicame', 'explica',
    'decime', 'resumime', 'resumi', 'resumen', 'ampliame', 'dame', 'damelo', 'mostrame', 'pasame', 'traeme', 'haceme',
    'hacer', 'armame', 'listame', 'enumerame', 'detallame', 'describime', 'buscame', 'busca', 'quiero', 'necesito',
    'sabes', 'se sabe',
  ],
  topicMaxWords: 6,
  digestWords: [
    'resumen', 'resumime', 'resumi', 'panorama', 'titulares', 'portada', 'novedades', 'que hay de nuevo', 'que hay hoy',
    'lo mas importante', 'lo ultimo', 'ultimas noticias', 'noticias del dia', 'noticias de hoy', 'que paso hoy',
    'que pasa hoy', 'que se publico hoy', 'que publicaron hoy', 'como viene el dia',
  ],
  digestToday: ['hoy', 'del dia', 'de la jornada', 'de la manana', 'de la tarde', 'de esta manana', 'de esta tarde'],
  digestStandalone: ['titulares', 'portada', 'novedades', 'ultimas noticias', 'que hay de nuevo', 'lo mas importante'],
  digestMaxWords: 5,
  digestSections: DEFAULT_DIGEST_SECTIONS,
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Armar la expresión en cada pregunta sería barato, pero la lista casi nunca cambia y el motor
// recibe muchas consultas por instancia: se memoriza por el contenido de la lista.
const regexCache = new Map<string, RegExp | undefined>();

/** Une las palabras en una sola expresión, sin acentos y con límites de palabra. */
export function wordListRegex(words: readonly string[], all = false): RegExp | undefined {
  const cleaned = words.map((word) => foldAccents(word).trim()).filter(Boolean);
  if (!cleaned.length) return undefined;
  const key = `${all ? 'g' : ''}\u0001${cleaned.join('\u0000')}`;
  if (regexCache.has(key)) return regexCache.get(key);
  // Las frases largas primero: "que hay de nuevo" tiene que ganarle a "que".
  const sorted = [...cleaned].sort((a, b) => b.length - a.length);
  const regex = new RegExp(`\\b(?:${sorted.map(escapeRegex).join('|')})\\b`, all ? 'g' : undefined);
  regexCache.set(key, regex);
  return regex;
}

/**
 * Pedidos de panorama: "haceme un resumen de las noticias de hoy", "qué hay de nuevo",
 * "titulares". No preguntan por un tema, así que la búsqueda semántica devuelve cualquier cosa
 * (el 14/9/2026 trajo las notas del aniversario del diario y contestó que no se había publicado
 * nada). Se responden con las notas del día en vez del índice vectorial.
 */
export function isDigestRequest(question: string, words: IntentWords = DEFAULT_INTENT_WORDS): boolean {
  const text = foldAccents(question);
  // El nombre de una sección ya es el pedido completo: "resumen de judiciales", "policiales".
  if (digestSection(question, words)) return true;
  const digest = wordListRegex(words.digestWords);
  if (!digest?.test(text)) return false;
  if (wordListRegex(words.digestToday)?.test(text)) return true;
  const standalone = wordListRegex(words.digestStandalone);
  if (!standalone?.test(text)) return false;
  return text.split(/[^a-z0-9]+/).filter(Boolean).length <= words.digestMaxWords;
}

/**
 * Palabras que no aportan tema: si lo único que sobra después de sacar la sección y las
 * palabras de panorama es relleno, el lector pidió la sección entera y no un asunto dentro.
 */
const SECTION_FILLERS = new Set([
  'a', 'al', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'en', 'sobre', 'para', 'por',
  'con', 'y', 'que', 'me', 'dame', 'pasame', 'mostrame', 'traeme', 'contame', 'decime', 'haceme', 'quiero', 'hay',
  'seccion', 'nota', 'notas', 'noticia', 'noticias', 'novedades', 'ultima', 'ultimas', 'ultimo', 'ultimos', 'todo',
  'toda', 'todos', 'todas', 'porfa', 'favor', 'nuevo',
]);

/** Saca del texto todas las apariciones de una lista de palabras. */
function stripWords(text: string, words: readonly string[]): string {
  // Solo por `replace`: `test` sobre una expresión global arrastraría `lastIndex` entre llamadas.
  const regex = wordListRegex(words, true);
  return regex ? text.replace(regex, ' ') : text;
}

/** La primera sección cuyo nombre aparece en el texto; gana el nombre más largo. */
function namedSection(text: string, sections: readonly DigestSection[]): DigestSection | undefined {
  let best: DigestSection | undefined;
  let length = 0;
  for (const section of sections) {
    for (const name of section.names) {
      const cleaned = foldAccents(name).trim();
      if (cleaned.length <= length) continue;
      if (!wordListRegex([cleaned])?.test(text)) continue;
      best = section;
      length = cleaned.length;
    }
  }
  return best;
}

/**
 * Panorama de una sección: "resumen de judiciales", "titulares de policiales", "deportes".
 * Devuelve la sección pedida o `undefined` si la consulta tiene tema propio: "resumen de la
 * política de vivienda" nombra una sección pero pregunta por vivienda, y ahí manda la búsqueda.
 */
export function digestSection(question: string, words: IntentWords = DEFAULT_INTENT_WORDS): DigestSection | undefined {
  const text = foldAccents(question);
  const section = namedSection(text, words.digestSections);
  if (!section) return undefined;
  const rest = stripWords(stripWords(stripWords(text, section.names), words.digestWords), words.digestToday);
  const left = rest.split(/[^a-z0-9]+/).filter((word) => word && !SECTION_FILLERS.has(word));
  return left.length ? undefined : section;
}

/** Nombre del día de la semana en español, a partir de un YYYY-MM-DD. */
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'] as const;

export function describeDay(day: string): string {
  const parsed = Date.parse(`${day}T12:00:00-03:00`);
  if (Number.isNaN(parsed)) return day;
  // Mediodía de Montevideo: el día del calendario es el mismo en UTC, sin bordes raros.
  const date = new Date(parsed);
  return `${DIAS[date.getUTCDay()]} ${date.getUTCDate()} de ${MESES[date.getUTCMonth()]}`;
}

/** Suma días a una fecha YYYY-MM-DD y devuelve otra fecha YYYY-MM-DD. */
export function addDays(day: string, days: number): string {
  const parsed = Date.parse(`${day}T12:00:00-03:00`);
  if (Number.isNaN(parsed)) return day;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Preguntas que piden un día que todavía no llegó ("¿el tiempo para mañana?"). El corpus solo
 * puede tener notas hasta hoy, así que hay que decirlo en vez de presentar lo de hoy como si
 * fuera ese día (13/9/2026: "Tiempo para mañana" devolvió el pronóstico del día en curso).
 */
export function futureDayOffset(question: string): number | undefined {
  const text = question.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/\bpasado manana\b/.test(text)) return 2;
  if (/\bmanana\b/.test(text) && !/\besta manana\b|\bde la manana\b|\ben la manana\b/.test(text)) return 1;
  if (/\bproxim[oa]s? (dias|semana|jornadas)\b|\bsemana que viene\b/.test(text)) return 1;
  return undefined;
}

/** Días completos entre dos fechas YYYY-MM-DD (negativo si `day` es posterior a `today`). */
export function daysBetweenDays(today: string, day: string): number {
  const a = Date.parse(`${today}T00:00:00-03:00`);
  const b = Date.parse(`${day}T00:00:00-03:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

/** Fecha calendario en America/Montevideo (YYYY-MM-DD). */
export function montevideoDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Montevideo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Clave de hora UTC para rate limit: YYYY-MM-DD-HH. */
export function hourKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 13).replace('T', '-');
}

export function daysAgo(n: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000);
}

export function epochSeconds(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

/** epoch (segundos) a partir de un YYYY-MM-DD interpretado a las 00:00 de Montevideo (UTC-3). */
export function dayToEpoch(day: string): number {
  const parsed = Date.parse(`${day}T00:00:00-03:00`);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

/** Lista de fechas (YYYY-MM-DD, Montevideo) hacia atrás incluyendo hoy. */
export function lastDays(n: number, from: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) out.push(montevideoDay(daysAgo(i, from)));
  return out;
}
