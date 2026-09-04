import type { Source } from './api';

/**
 * Datos simulados para el modo demo del prototipo.
 *
 * Permiten probar todo el flujo visual (pregunta → respuesta → fuentes)
 * sin tener el backend de Bedrock desplegado. Cuando la API real esté
 * disponible, alcanza con configurar VITE_API_URL con el endpoint verdadero
 * y el modo demo se desactiva solo.
 */

/**
 * Prefijo exacto del mensaje de "sin cobertura". Coincide con
 * NO_COVERAGE_MESSAGE del backend (backend/prompt.ts) para que la
 * clasificación funcione igual con datos reales.
 */
export const NO_COVERAGE_PREFIX = 'El País no publicó sobre esto en los últimos días';

/** Contenido de una respuesta demo (el `kind` lo calcula api.ts). */
interface DemoContent {
  answer: string;
  sources: Source[];
}

const HOY = new Date();

function diasAtras(dias: number): string {
  const fecha = new Date(HOY);
  fecha.setDate(fecha.getDate() - dias);
  return fecha.toISOString().slice(0, 10);
}

interface DemoEntry {
  match: RegExp;
  response: DemoContent;
}

const RESPUESTA_GENERICA: DemoContent = {
  answer:
    'El País publicó varias notas sobre la actualidad uruguaya en los últimos días. La cobertura reciente abarca economía, política y deportes, con seguimiento diario de los temas que marcan la agenda.\n\nPara una respuesta más precisa, probá con una pregunta puntual sobre un tema específico. Este es un prototipo en modo demostración: las respuestas se generan con datos de ejemplo.\n\nPodés leer la cobertura completa en El País.',
  sources: [
    {
      title: 'La agenda de la semana: los temas que marcan la actualidad',
      url: 'https://www.elpais.com.uy/informacion/agenda-semana',
      date: diasAtras(1),
      snippet:
        'Un repaso por los principales acontecimientos de los últimos días en Uruguay, con foco en economía, política y sociedad.',
    },
    {
      title: 'Resumen informativo: lo más leído de los últimos días',
      url: 'https://www.elpais.com.uy/informacion/resumen-informativo',
      date: diasAtras(2),
      snippet:
        'Las notas que concentraron la atención de los lectores durante la última semana en la edición digital.',
    },
  ],
};

const DEMO_ENTRIES: DemoEntry[] = [
  {
    match: /econ[oó]m|econom[ií]a|d[oó]lar|inflaci[oó]n|precio|tarifa|impuesto/i,
    response: {
      answer:
        'El equipo económico presentó esta semana los lineamientos del próximo presupuesto, con foco en contener el gasto y sostener las metas de inflación. La discusión giró en torno al equilibrio entre inversión pública y disciplina fiscal.\n\nEn paralelo, el dólar mostró leves oscilaciones y los analistas coincidieron en un escenario de relativa estabilidad para las próximas semanas, aunque advirtieron sobre la incertidumbre del contexto regional.\n\nPodés leer el análisis completo en El País.',
      sources: [
        {
          title: 'El Gobierno detalló los ejes del presupuesto quinquenal',
          url: 'https://www.elpais.com.uy/economia/presupuesto-quinquenal-ejes',
          date: diasAtras(1),
          snippet:
            'Las autoridades económicas explicaron las prioridades de gasto e inversión para el próximo período, con énfasis en la meta de inflación.',
        },
        {
          title: 'El dólar cerró estable en una semana de pocas variaciones',
          url: 'https://www.elpais.com.uy/economia/dolar-cierre-semanal',
          date: diasAtras(2),
          snippet:
            'La divisa se mantuvo en un rango acotado y los operadores prevén estabilidad en el corto plazo.',
        },
        {
          title: 'Analistas leen con cautela el contexto regional',
          url: 'https://www.elpais.com.uy/economia/contexto-regional-analisis',
          date: diasAtras(4),
          snippet:
            'Consultoras privadas advierten que la volatilidad de la región puede impactar en los precios internos.',
        },
      ],
    },
  },
  {
    match: /deporte|f[uú]tbol|selecci[oó]n|celeste|b[aá]squet|penarol|pe[nñ]arol|nacional/i,
    response: {
      answer:
        'La selección uruguaya cerró una nueva fecha de eliminatorias con un resultado que la mantiene entre los puestos de clasificación. El cuerpo técnico destacó el funcionamiento colectivo por encima de las individualidades.\n\nEn el plano local, el campeonato entró en una etapa decisiva con los principales candidatos separados por pocos puntos, lo que anticipa un cierre de temporada ajustado.\n\nSeguí la cobertura deportiva completa en El País.',
      sources: [
        {
          title: 'La selección sumó puntos clave en las eliminatorias',
          url: 'https://www.elpais.com.uy/deportes/eliminatorias-seleccion',
          date: diasAtras(2),
          snippet:
            'El combinado nacional mantuvo su lugar entre los clasificados tras la última fecha del torneo.',
        },
        {
          title: 'El campeonato local llega a su tramo decisivo',
          url: 'https://www.elpais.com.uy/deportes/campeonato-tramo-final',
          date: diasAtras(3),
          snippet:
            'Los principales candidatos definen el título en las últimas fechas, con diferencias mínimas en la tabla.',
        },
      ],
    },
  },
  {
    match: /pol[ií]tic|gobierno|presidente|parlamento|ministro|ley|congreso|elecci[oó]n/i,
    response: {
      answer:
        'El Parlamento avanzó esta semana en el tratamiento de varios proyectos de ley prioritarios para el Gobierno, en medio de un debate que expuso las diferencias entre oficialismo y oposición sobre el alcance de las reformas.\n\nDesde el Ejecutivo remarcaron la voluntad de buscar acuerdos, mientras que los partidos de oposición reclamaron mayor participación en la discusión de las iniciativas.\n\nPodés leer la crónica parlamentaria completa en El País.',
      sources: [
        {
          title: 'El oficialismo impulsa su agenda legislativa en el Parlamento',
          url: 'https://www.elpais.com.uy/informacion/agenda-legislativa-parlamento',
          date: diasAtras(1),
          snippet:
            'Los proyectos prioritarios del Gobierno comenzaron su tratamiento en comisiones con debate entre las bancadas.',
        },
        {
          title: 'La oposición reclama más espacio en la discusión de reformas',
          url: 'https://www.elpais.com.uy/informacion/oposicion-reformas-debate',
          date: diasAtras(3),
          snippet:
            'Los partidos opositores plantearon objeciones al ritmo de tratamiento de las iniciativas oficiales.',
        },
      ],
    },
  },
  {
    match: /clima|tiempo|lluvia|temperatura|pron[oó]stico|calor|fr[ií]o/i,
    response: {
      answer:
        'El instituto meteorológico anticipó para los próximos días una mejora en las condiciones del tiempo, con descenso de las probabilidades de lluvia y temperaturas más estables en gran parte del país.\n\nLas autoridades recordaron las recomendaciones habituales ante los cambios de temperatura y llamaron a seguir los avisos oficiales.\n\nConsultá el pronóstico completo en El País.',
      sources: [
        {
          title: 'Anticipan una mejora del tiempo para los próximos días',
          url: 'https://www.elpais.com.uy/informacion/pronostico-mejora-tiempo',
          date: diasAtras(1),
          snippet:
            'El organismo meteorológico prevé menor probabilidad de precipitaciones y temperaturas más estables.',
        },
      ],
    },
  },
  {
    // Frases para disparar el estado "sin cobertura" en la demo. Deben tener
    // al menos MIN_LENGTH (8) caracteres para pasar la validación del form.
    match: /sin cobertura|prueba vac[ií]a|tema inexistente|no publicado|xyzxyz|asdfasdf/i,
    response: {
      answer:
        'El País no publicó sobre esto en los últimos días. Puede tratarse de un tema fuera de la cobertura reciente o de una consulta demasiado específica.',
      sources: [],
    },
  },
];

/**
 * Devuelve una respuesta simulada según la pregunta. Elige la entrada cuya
 * expresión regular coincida con el texto; si ninguna coincide, usa una
 * respuesta genérica.
 */
export function demoAnswer(question: string): DemoContent {
  const entry = DEMO_ENTRIES.find(({ match }) => match.test(question));
  return entry ? entry.response : RESPUESTA_GENERICA;
}
