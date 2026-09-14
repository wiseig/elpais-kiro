import { describe, expect, it } from 'vitest';
import { DEFAULT_INTENT_WORDS, addDays, isGreeting, dayToEpoch, daysBetweenDays, describeDay, digestSection, futureDayOffset, isDigestRequest, isTimeSensitive, needsRewrite, normalizeQuestion } from '../src/normalize';
import { isUlid, ulid, ulidTime } from '../src/ulid';
import { hasMetaTalk, isAllowedUrl, startsWithNoCoverage, validateAnswerText, withoutClosingInvitation } from '../src/validators';
import { questionHash } from '../src/node';

describe('normalización', () => {
  it('iguala variantes de puntuación y mayúsculas', () => {
    expect(normalizeQuestion('¿Cuánto sube UTE?')).toBe('cuánto sube ute');
    expect(normalizeQuestion('cuanto sube UTE!!  ')).toBe('cuanto sube ute');
    expect(questionHash('¿Cuánto sube UTE?')).toBe(questionHash('cuánto sube ute'));
  });

  it('decide cuándo reescribir (6.4)', () => {
    expect(needsRewrite('¿y qué dijo el ministro?', false)).toBe(true);
    expect(needsRewrite('¿Qué medidas anunció el gobierno sobre el transporte esta semana?', false)).toBe(false);
    expect(needsRewrite('¿Qué medidas anunció el gobierno sobre eso esta semana?', false)).toBe(true);
    expect(needsRewrite('cualquier cosa', true)).toBe(true);
    // Sin historial, un tema suelto no se reescribe: lo resolvía el modelo inventando contexto.
    expect(needsRewrite('Valentina Cancela', false)).toBe(false);
    expect(needsRewrite('Ataque Facultad Medicina', false)).toBe(false);
    expect(needsRewrite('¿y eso?', false)).toBe(true);
  });

  it('convierte días de Montevideo a epoch', () => {
    expect(dayToEpoch('2026-09-11')).toBe(Math.floor(Date.parse('2026-09-11T03:00:00Z') / 1000));
  });
});

describe('ulid', () => {
  it('genera ids válidos y ordenables por tiempo', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(isUlid(a)).toBe(true);
    expect(ulidTime(a)).toBe(1_000_000);
    expect(a < b).toBe(true);
  });
});

describe('validadores de salida', () => {
  const hosts = ['www.elpais.com.uy', 'elpais.com.uy'];
  it('solo acepta URLs de El País', () => {
    expect(isAllowedUrl('https://www.elpais.com.uy/informacion/nota', hosts)).toBe(true);
    expect(isAllowedUrl('https://elpais.com/espana', hosts)).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)', hosts)).toBe(false);
  });
  it('detecta meta-charla', () => {
    expect(hasMetaTalk('Según el fragmento, el dólar subió.')).toBe(true);
    expect(hasMetaTalk('Como IA no puedo opinar.')).toBe(true);
    expect(hasMetaTalk('El dólar cerró estable este viernes.')).toBe(false);
  });
  it('reporta párrafos y URLs ajenas', () => {
    const issues = validateAnswerText('a\n\nb\n\nc\n\nd https://google.com', { maxParagraphs: 3, allowedUrlHosts: hosts });
    expect(issues.map((issue) => issue.code)).toEqual(['too_many_paragraphs', 'foreign_url']);
  });
  it('reconoce la frase de sin cobertura', () => {
    expect(startsWithNoCoverage('El País no publicó sobre esto en los últimos días. Temas cercanos: …')).toBe(true);
    // El modelo suele reescribir la frase con el tema adentro: también cuenta como sin cobertura.
    expect(startsWithNoCoverage('El País no publicó sobre Diego Acosta y Lara en los últimos días.')).toBe(true);
    expect(startsWithNoCoverage('el pais no ha publicado notas sobre eso')).toBe(true);
    expect(startsWithNoCoverage('El País publicó que el femicida fue condenado a 10 años.')).toBe(false);
  });
});

describe('preguntas ancladas al presente', () => {
  it('reconoce las que dependen del día', () => {
    for (const q of [
      '¿Cómo va a estar el tiempo el finde?',
      '¿Cómo cerró el dólar hoy?',
      '¿Qué tiempo hace ahora en Montevideo?',
      '¿Llueve mañana?',
      '¿Qué pasó esta semana con el transporte?',
      '¿Cuál es el precio actual del boleto?',
    ]) expect(isTimeSensitive(q)).toBe(true);
  });

  it('no marca las preguntas sobre hechos pasados', () => {
    for (const q of [
      '¿Qué pasó con los trabajadores del Frigorífico Tacuarembó?',
      '¿Quién era Valentina Cancela?',
      '¿Qué dijo el MTOP sobre la reforma del transporte?',
    ]) expect(isTimeSensitive(q)).toBe(false);
  });

  it('mide el desfase en días entre hoy y la nota', () => {
    expect(daysBetweenDays('2026-09-13', '2026-09-04')).toBe(9);
    expect(daysBetweenDays('2026-09-13', '2026-09-13')).toBe(0);
    expect(daysBetweenDays('2026-09-13', 'nada')).toBe(0);
  });
});

describe('días futuros', () => {
  it('reconoce cuándo la pregunta pide un día que todavía no llegó', () => {
    expect(futureDayOffset('Tiempo para mañana')).toBe(1);
    expect(futureDayOffset('¿Y pasado mañana?')).toBe(2);
    expect(futureDayOffset('¿Qué se viene la próxima semana?')).toBe(1);
    // "esta mañana" y "de la mañana" son hoy, no mañana.
    expect(futureDayOffset('¿Qué pasó esta mañana?')).toBeUndefined();
    expect(futureDayOffset('El accidente de la mañana')).toBeUndefined();
    expect(futureDayOffset('¿Cómo está el tiempo hoy?')).toBeUndefined();
  });

  it('nombra los días con su fecha y suma días sin correrse', () => {
    expect(describeDay('2026-09-13')).toBe('domingo 13 de setiembre');
    expect(describeDay(addDays('2026-09-13', 1))).toBe('lunes 14 de setiembre');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(describeDay('nada')).toBe('nada');
  });
});

describe('isDigestRequest', () => {
  it('reconoce los pedidos de panorama del día', () => {
    for (const text of [
      'Haceme un resumen de las noticias del día de hoy',
      '¿Qué hay de nuevo hoy?',
      'resumen del día',
      'titulares',
      '¿Qué pasó hoy?',
      'Dame las últimas noticias',
      'portada',
    ]) {
      expect(isDigestRequest(text), text).toBe(true);
    }
  });

  it('toma las listas de la configuración: una palabra agregada alcanza', () => {
    const frase = 'La posta de hoy';
    expect(isDigestRequest(frase)).toBe(false);
    expect(
      isDigestRequest(frase, { ...DEFAULT_INTENT_WORDS, digestWords: [...DEFAULT_INTENT_WORDS.digestWords, 'la posta'] }),
    ).toBe(true);
    // Un verbo desconocido cuenta como tema hasta que se lo agrega a los marcadores de pedido.
    const conVerbo = { ...DEFAULT_INTENT_WORDS, digestWords: [...DEFAULT_INTENT_WORDS.digestWords, 'la posta'] };
    expect(isDigestRequest('Tirame la posta de hoy', conVerbo)).toBe(false);
    expect(
      isDigestRequest('Tirame la posta de hoy', { ...conVerbo, questionMarkers: [...conVerbo.questionMarkers, 'tirame'] }),
    ).toBe(true);
  });

  it('reconoce "qué está pasando" con y sin alcance geográfico', () => {
    for (const text of [
      'Que está pasando esta tarde?',
      '¿Qué está pasando esta tarde en Uruguay?',
      '¿Qué está pasando hoy?',
      '¿Qué hay hoy?',
      'Que pasa ahora?',
    ]) {
      expect(isDigestRequest(text), text).toBe(true);
    }
  });

  it('no manda al panorama lo que tiene asunto propio aunque nombre el día', () => {
    for (const text of [
      '¿Qué está pasando en el puerto?',
      '¿Qué pasa ahora con el dólar?',
      '¿Qué pasó hoy con Peñarol?',
      '¿Qué hay de nuevo sobre la Udelar?',
    ]) {
      expect(isDigestRequest(text), text).toBe(false);
    }
  });

  it('deja pasar las consultas que tienen tema propio', () => {
    for (const text of [
      'Resumen del partido de Peñarol',
      'resumen de las noticias de Peñarol',
      '¿Qué pasó con los trabajadores del Frigorífico Tacuarembó?',
      'Valentina Cancela',
      '¿Cómo va a estar el tiempo mañana?',
    ]) {
      expect(isDigestRequest(text), text).toBe(false);
    }
  });
});

describe('digestSection', () => {
  it('reconoce el pedido de una sección del diario', () => {
    const casos: [string, string][] = [
      ['Resumen de judiciales', 'judiciales'],
      ['resumen de judiciales', 'judiciales'],
      ['policiales', 'policiales'],
      ['Titulares de policiales', 'policiales'],
      ['¿Qué hay de nuevo en deportes?', 'deportes'],
      ['dame las últimas noticias de economía', 'economia'],
      ['en clave país', 'en clave pais'],
      ['novedades de espectáculos', 'espectaculos'],
    ];
    for (const [texto, esperado] of casos) {
      expect(digestSection(texto)?.names[0], texto).toBe(esperado);
      expect(isDigestRequest(texto), texto).toBe(true);
    }
  });

  it('no toma por sección la consulta que nombra una y pregunta por un tema', () => {
    for (const texto of [
      'Resumen de la política de vivienda',
      '¿Cómo está la economía uruguaya?',
      '¿Qué dijo el ministro de Salud sobre las vacunas?',
      'resumen del juicio a Penadés',
    ]) {
      expect(digestSection(texto), texto).toBeUndefined();
    }
  });

  it('las secciones salen de la configuración, no del código', () => {
    const texto = 'resumen de agro';
    expect(digestSection(texto)).toBeUndefined();
    const words = { ...DEFAULT_INTENT_WORDS, digestSections: [{ names: ['agro', 'campo'], match: ['informacion/agro'] }] };
    expect(digestSection(texto, words)?.match).toEqual(['informacion/agro']);
  });
});

describe('withoutClosingInvitation', () => {
  it('saca el cierre de cortesía, que no está en ninguna fuente', () => {
    expect(withoutClosingInvitation('La Cancillería pidió evitar el stand. Podés leer la nota completa en El País.')).toBe(
      'La Cancillería pidió evitar el stand.',
    );
    expect(withoutClosingInvitation('Texto.\n\nLeé la cobertura completa en El País.')).toBe('Texto.');
    expect(withoutClosingInvitation('Hubo paro. Seguí la cobertura en El País.')).toBe('Hubo paro.');
  });

  it('no toca lo que sí es información ni se come la respuesta entera', () => {
    expect(withoutClosingInvitation('Una nota de El País dice que subió el boleto.')).toBe('Una nota de El País dice que subió el boleto.');
    expect(withoutClosingInvitation('El País no publicó sobre esto en los últimos días.')).toBe('El País no publicó sobre esto en los últimos días.');
    expect(withoutClosingInvitation('Podés leer la nota completa en El País.')).toBe('Podés leer la nota completa en El País.');
  });
});

describe('isGreeting', () => {
  it('reconoce el saludo suelto', () => {
    for (const text of ['hola', 'Hola!', 'buenas', 'buenas buenas', '¿Cómo va?', 'buen día', 'Buenas tardes', 'que tal', 'Hey']) {
      expect(isGreeting(text), text).toBe(true);
    }
  });

  it('un saludo con pregunta adentro se responde normal', () => {
    for (const text of ['hola, ¿qué pasó en el puerto?', 'buenas, contame del dólar', '¿Cómo va el conflicto portuario?']) {
      expect(isGreeting(text), text).toBe(false);
    }
  });

  it('sale de la configuración, como el resto de las listas', () => {
    expect(isGreeting('qué hacele')).toBe(false);
    expect(isGreeting('qué hacele', { ...DEFAULT_INTENT_WORDS, greetings: [...DEFAULT_INTENT_WORDS.greetings, 'que hacele'] })).toBe(true);
  });
});
