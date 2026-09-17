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

/**
 * Preguntas que ponen al diario de sujeto: "¿Qué dice El País sobre X?", "qué publicó el país del
 * clásico". Es la forma natural de preguntarle a este producto, y también la que peor le cae al
 * guardrail: el filtro de relevancia espera una respuesta *sobre publicaciones* y le da 0,02 a la
 * noticia bien contada (medido el 15/9/2026 con "¿Qué publicó El País sobre clima?": 0,02 contra
 * 1,0 con "¿Qué se sabe sobre clima?"); y en el índice vectorial "El País" pesa más que el tema y
 * arrastra las notas sobre el diario. Como el producto solo responde con notas de El País, el
 * marco es redundante: se lo saca y queda el tema. "Opina" no entra: preguntar por la línea
 * editorial es otra cosa.
 */
const SOURCE_FRAME =
  /^\s*¿?\s*qu[eé]\s+(?:dice|dijo|dicen|publica|public[oó]|publicaron|informa|inform[oó]|cuenta|cont[oó]|hay|tiene|sali[oó]|escribi[oó]|report[oó]|se\s+sabe|sabe)\s+(?:hoy\s+|ayer\s+)?(?:en\s+)?(?:el\s+diario\s+)?el\s+pa[ií]s\s+(?:hoy\s+|ayer\s+)?(sobre|de|del|acerca\s+de|respecto\s+(?:a|de))\s+(.+?)\s*\??\s*$/i;

function sourceFrameParts(text: string): { prep: string; topic: string } | undefined {
  const match = SOURCE_FRAME.exec(text.normalize('NFC'));
  if (!match) return undefined;
  const prep = (match[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
  const raw = (match[2] ?? '').trim().replace(/[.,;:]+$/, '');
  if (!raw) return undefined;
  return { prep, topic: prep === 'del' ? `el ${raw}` : raw };
}

/** El tema pelado de una pregunta con el diario de sujeto, sin comillas; `undefined` si no la tiene. */
export function sourceFrameTopic(text: string): string | undefined {
  const parts = sourceFrameParts(text);
  if (!parts) return undefined;
  const topic = parts.topic.replace(/^[«“"']+|[»”"']+$/g, '').trim();
  return topic || undefined;
}

/** La misma pregunta sin el diario de sujeto: "¿Qué dice El País sobre X?" → "¿Qué se sabe sobre X?". */
export function neutralizeSourceFrame(text: string): string {
  const parts = sourceFrameParts(text);
  return parts ? `¿Qué se sabe sobre ${parts.topic}?` : text;
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
/**
 * La pregunta solo se entiende con el turno anterior ("¿Y en Uruguay?", "¿y eso?"). No sirve para
 * ofrecerla suelta: en la portada o en la bienvenida queda como un chiste interno.
 */
export function isFollowUp(question: string): boolean {
  return AMBIGUOUS_PRONOUNS.test(question.trim());
}

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
 * Palabras sin carga informativa: no distinguen un tema de otro, así que no cuentan al comparar
 * una pregunta con el titular de una nota.
 */
const EMPTY_WORDS = new Set([
  'que', 'quien', 'cual', 'como', 'cuando', 'donde', 'cuanto', 'porque', 'sobre', 'para', 'entre',
  'desde', 'hasta', 'entonces', 'tambien', 'entre', 'este', 'esta', 'esto', 'estos', 'estas',
  'ese', 'esa', 'eso', 'esos', 'esas', 'aquel', 'aquella', 'entre', 'entre', 'pero', 'mientras',
  'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros', 'otras', 'mucho', 'mucha', 'muchos',
  'muchas', 'poco', 'poca', 'pocos', 'pocas', 'algun', 'alguna', 'algunos', 'algunas', 'nada',
  'algo', 'cosa', 'cosas', 'tema', 'temas', 'saber', 'sabe', 'hacer', 'hace', 'puedo', 'puede',
  'pueden', 'tiene', 'tienen', 'tengo', 'hay', 'hubo', 'esta', 'estan', 'ser', 'son', 'era',
  'fue', 'fueron', 'dice', 'dijo', 'dicen', 'noticias', 'noticia', 'nota', 'notas', 'pais',
  'uruguay', 'uruguayo', 'uruguaya', 'diario', 'publico', 'publica', 'publicado',
]);

/** Las palabras de un texto que de verdad nombran algo, sin acentos y en minúscula. */
export function contentWords(text: string): Set<string> {
  const words = foldAccents(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !EMPTY_WORDS.has(word));
  return new Set(words);
}

/**
 * Cuánto de la pregunta aparece en el texto de una nota, entre 0 y 1. Sirve para no descartar por
 * "fuera de alcance" algo que El País sí publicó: el 16/9/2026 la tarjeta de una nota titulada
 * "¿Puedo hacer una llamada…?" se bloqueó como fuera de tema, porque suelta parece un pedido de
 * hacer una llamada. Compara palabras con carga, así que una receta no "coincide" con una nota de
 * nutrición solo por hablar las dos de comida.
 */
export function topicOverlap(question: string, articleText: string): number {
  const asked = contentWords(question);
  if (!asked.size) return 0;
  const published = contentWords(articleText);
  let shared = 0;
  for (const word of asked) if (published.has(word)) shared += 1;
  return shared / asked.size;
}

/**
 * Listas que deciden cómo se lee una consulta. Viven en la configuración para que la redacción
 * pueda agregar formas nuevas sin tocar código ni desplegar.
 */
export interface IntentWords {
  /** Marcan que la consulta ya es una pregunta o un pedido, no un tema suelto. */
  questionMarkers: readonly string[];
  /** Hasta cuántas palabras se considera tema suelto y se envuelve en "¿Qué se sabe sobre…?". */
  topicMaxWords: number;
  /** Palabras de panorama: resumen, titulares, qué hay de nuevo. */
  digestWords: readonly string[];
  /** Anclas al día en curso, sin las cuales "resumen de X" es un pedido sobre X. */
  digestToday: readonly string[];
  /** Frases que por sí solas ya son el pedido completo ("titulares", "portada"). */
  digestStandalone: readonly string[];
  /** Hasta cuántas palabras vale una frase suelta como pedido de panorama. */
  digestMaxWords: number;
  /**
   * Palabras que no son tema: alcance geográfico, muletillas, el nombre del diario. Lo que queda
   * después de sacarlas decide si la consulta pide el panorama o pregunta por algo puntual.
   */
  digestFiller: readonly string[];
  /** Secciones del diario que el lector puede pedir por su nombre. */
  digestSections: readonly DigestSection[];
  /** Saludos: cuando el mensaje es solo esto, se contesta con una bienvenida y sugerencias. */
  greetings: readonly string[];
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
  { names: ['sociedad', 'sociales'], match: ['informacion/sociedad'] },
  { names: ['servicios'], match: ['informacion/servicios'] },
  // "partidos politicos" va entero: "partidos" solo es ambiguo en Uruguay, donde lo más probable
  // es que hablen de fútbol.
  { names: ['partidos politicos', 'politica', 'politicos', 'politicas'], match: ['informacion/politica'] },
  { names: ['salud'], match: ['informacion/salud', 'bienestar'] },
  { names: ['mundo', 'internacionales', 'internacional'], match: ['mundo'] },
  { names: ['deportes', 'deporte', 'deportivas', 'deportivos', 'ovacion'], match: ['ovacion'] },
  { names: ['economia', 'economicas', 'economicos', 'negocios', 'mercados', 'finanzas'], match: ['negocios', 'mercados', 'economia', 'el-empresario'] },
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
    'sabes', 'se sabe', 'pregunta', 'preguntame', 'preguntanos', 'preguntar', 'preguntas',
    // "Noticias sobre X" ya pide algo: envolverlo daba "¿Qué se sabe sobre Noticias sobre X?".
    'noticias', 'novedades',
  ],
  topicMaxWords: 6,
  digestWords: [
    'resumen', 'resumime', 'resumi', 'panorama', 'titulares', 'portada', 'novedades', 'que hay de nuevo', 'que hay hoy',
    'lo mas importante', 'lo ultimo', 'ultimas noticias', 'noticias del dia', 'noticias de hoy', 'que paso hoy',
    'que pasa hoy', 'que se publico hoy', 'que publicaron hoy', 'como viene el dia', 'que esta pasando', 'que estuvo pasando',
    'que viene pasando', 'que pasa', 'que paso', 'que hay', 'actualidad', 'la actualidad',
  ],
  digestToday: [
    'hoy', 'del dia', 'de la jornada', 'de la manana', 'de la tarde', 'de esta manana', 'de esta tarde',
    'esta manana', 'esta tarde', 'esta noche', 'ahora', 'en este momento', 'por estas horas', 'recien',
    'esta semana', 'la semana', 'estos dias', 'ultimos dias', 'ultima semana',
  ],
  digestStandalone: ['titulares', 'portada', 'novedades', 'actualidad', 'ultimas noticias', 'que hay de nuevo', 'lo mas importante'],
  digestMaxWords: 5,
  digestFiller: [
    'uruguay', 'uruguaya', 'uruguayo', 'montevideo', 'pais', 'diario', 'noticia', 'noticias', 'novedad', 'novedades',
    'actualidad', 'jornada', 'nuevo', 'nueva', 'nuevas', 'nuevos', 'esta', 'este', 'esto', 'para', 'sobre', 'como',
    'algo', 'cosa', 'cosas', 'tema', 'temas', 'dame', 'decime', 'contame', 'haceme', 'mostrame', 'pasame', 'quiero',
    'saber', 'contar', 'importante', 'ultimo', 'ultima', 'ultimos', 'ultimas', 'general', 'principales', 'principal',
  ],
  digestSections: DEFAULT_DIGEST_SECTIONS,
  greetings: [
    'hola', 'holis', 'ola', 'buenas', 'buenas buenas', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches',
    'que tal', 'que hacés', 'que haces', 'como va', 'como andas', 'como anda', 'como estas', 'como te va', 'todo bien',
    'hey', 'saludos', 'ey', 'buenass',
  ],
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
/**
 * Lo que queda de la consulta después de sacarle la frase de panorama, el ancla temporal y las
 * palabras que no son tema. Si sobra algo, el lector preguntó por un asunto concreto: "qué está
 * pasando en el puerto" no es un panorama, "qué está pasando esta tarde en Uruguay" sí.
 */
function leftoverTopic(text: string, words: IntentWords, lists: readonly (readonly string[])[]): string[] {
  // Los verbos de pedido tampoco son tema: si alguien agrega "tirame" a la lista de marcadores,
  // "tirame las noticias de hoy" tiene que seguir siendo un panorama.
  const filler = new Set([...words.digestFiller, ...words.questionMarkers].map((word) => foldAccents(word)));
  let rest = text;
  for (const list of lists) {
    const regex = wordListRegex(list, true);
    if (regex) rest = rest.replace(regex, ' ');
  }
  return rest
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !filler.has(word));
}

/**
 * "hola", "buenas buenas", "cómo va?": el mensaje es solo un saludo. Contestarle "El País no
 * publicó sobre 'hola'" es lo peor que puede hacer un asistente en su primer turno. Un saludo con
 * pregunta adentro ("hola, ¿qué pasó en el puerto?") no cuenta: eso se responde normal.
 */
export function isGreeting(text: string, words: IntentWords = DEFAULT_INTENT_WORDS): boolean {
  const folded = foldAccents(text);
  if (!folded.trim()) return false;
  if (!wordListRegex(words.greetings)?.test(folded)) return false;
  return leftoverTopic(folded, words, [words.greetings, words.digestWords, words.digestToday]).length === 0;
}

export function isDigestRequest(question: string, words: IntentWords = DEFAULT_INTENT_WORDS): boolean {
  const text = foldAccents(question);
  // El nombre de una sección ya es el pedido completo: "resumen de judiciales", "policiales".
  if (digestSection(question, words)) return true;
  const lists = [words.digestWords, words.digestToday, words.digestStandalone];
  // Si queda un tema propio no es panorama, con o sin palabra de resumen: "el dólar hoy" pregunta
  // por el dólar.
  if (leftoverTopic(text, words, lists).length > 0) return false;
  const hasToday = Boolean(wordListRegex(words.digestToday)?.test(text));
  // "Uruguay hoy" o "esta semana" no traen ninguna palabra de resumen y son un pedido de panorama
  // igual: lo único que dicen es cuándo, y no queda nada más por lo que preguntar.
  if (hasToday) return true;
  if (!wordListRegex(words.digestWords)?.test(text)) return false;
  const standalone = wordListRegex(words.digestStandalone);
  if (!standalone?.test(text)) return false;
  return text.split(/[^a-z0-9]+/).filter(Boolean).length <= words.digestMaxWords;
}

/** Cuántos días abarca el pedido: "esta semana" mira para atrás, "hoy" es solo hoy. */
const WEEK_ANCHOR = /\b(esta semana|la semana|ultima semana|estos dias|ultimos dias)\b/;

export function digestWindowDays(question: string): number {
  return WEEK_ANCHOR.test(foldAccents(question)) ? 7 : 1;
}

/**
 * Palabras que no aportan tema: si lo único que sobra después de sacar la sección y las
 * palabras de panorama es relleno, el lector pidió la sección entera y no un asunto dentro.
 */
const SECTION_FILLERS = new Set([
  'a', 'al', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'en', 'sobre', 'para', 'por',
  'con', 'y', 'que', 'me', 'dame', 'pasame', 'mostrame', 'traeme', 'contame', 'decime', 'haceme', 'quiero', 'hay',
  'seccion', 'nota', 'notas', 'noticia', 'noticias', 'novedades', 'ultima', 'ultimas', 'ultimo', 'ultimos', 'todo',
  'toda', 'todos', 'todas', 'porfa', 'favor', 'nuevo', 'uruguay', 'uruguayas', 'uruguayos', 'montevideo',
  'nacional', 'nacionales', 'pais', 'actualidad', 'tema', 'temas',
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
/**
 * La sección real de una nota. El feed manda solo el primer segmento del slug, así que todas las
 * subsecciones de "informacion" —política, judiciales, policiales, sociedad— se guardaron como
 * "informacion" y ninguna se podía pedir por su nombre. La URL sí tiene el camino completo, y está
 * en el mismo registro: `/informacion/politica/cancilleria-…` da "informacion/politica".
 */
export function sectionFromUrl(url: string, fallback = ''): string {
  const match = /^https?:\/\/[^/]+\/(.+)$/.exec(url.trim());
  const segments = (match?.[1] ?? '').split('/').filter(Boolean);
  // El último segmento es el título de la nota, no una sección.
  const path = segments.slice(0, Math.max(0, segments.length - 1));
  if (!path.length) return fallback;
  return path.slice(0, 2).join('/');
}

export function digestSection(question: string, words: IntentWords = DEFAULT_INTENT_WORDS): DigestSection | undefined {
  const text = foldAccents(question);
  const section = namedSection(text, words.digestSections);
  if (!section) return undefined;
  const rest = stripWords(stripWords(stripWords(text, section.names), words.digestWords), words.digestToday);
  const left = rest.split(/[^a-z0-9]+/).filter((word) => word && !SECTION_FILLERS.has(word));
  return left.length ? undefined : section;
}

/**
 * Una repregunta sugerida tiene que poder responderse con notas publicadas. El modelo proponía
 * "¿Qué implicancias podría tener el financiamiento del casamiento de Trump en las relaciones
 * internacionales?" y el propio sistema la rechazaba como fuera de tema: le ofrecíamos al lector
 * una pregunta y después le decíamos que no. Esto descarta las especulativas antes de mostrarlas.
 */
const SPECULATIVE =
  /\b(podria|podrian|deberia|deberian|deberiamos|seria|serian|afectaria|influiria|impactaria|cambiaria|pasaria|implicancias|consecuencias futuras|a futuro|en el futuro|que opinas|que te parece|crees que|creen que|imagina|imaginate|hipotetic)/;

export function isAnswerableSuggestion(text: string): boolean {
  const folded = foldAccents(text).trim();
  if (folded.length < 8) return false;
  return !SPECULATIVE.test(folded);
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
/** Uruguay no tiene horario de verano desde 2015, pero se usa la zona y no un desfase fijo. */
export const MONTEVIDEO_TZ = 'America/Montevideo';

export function montevideoDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MONTEVIDEO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Fecha y hora en Montevideo para textos que lee una persona. Todo lo que corre en AWS está en
 * UTC, que es lo correcto para guardar, pero un correo que dice "12:43 UTC" a alguien que son las
 * 09:43 no sirve: hay que traducirlo en el borde.
 */
export function montevideoDateTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('es-UY', {
    timeZone: MONTEVIDEO_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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
