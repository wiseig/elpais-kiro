import { contentWords } from '@pelp/domain';

/** Muletillas y confirmaciones que el reconocimiento suelta solas y que no son una pregunta. */
const RELLENO = new Set(['si', 'sí', 'no', 'eh', 'ah', 'mm', 'mmm', 'ajá', 'aja', 'ok', 'okey', 'dale', 'bueno', 'claro', 'ya', 'hola', 'chau', 'gracias']);

/**
 * ¿Esto es algo que vale la pena mandar como pregunta? Descarta lo que el reconocimiento saca del
 * ruido de fondo: sílabas sueltas, muletillas, una palabra al pasar. Pide al menos una palabra con
 * carga y algo de largo, o dos palabras con carga.
 */
export function esPreguntaConSustancia(texto: string): boolean {
  const limpio = texto.trim();
  if (limpio.length < 4) return false;
  const palabras = limpio.toLowerCase().split(/\s+/).filter(Boolean);
  if (palabras.every((palabra) => RELLENO.has(palabra.replace(/[¿?¡!.,]/g, '')))) return false;
  const carga = contentWords(limpio).size;
  return carga >= 2 || (carga >= 1 && limpio.length >= 12);
}
