import { describe, expect, it } from 'vitest';
import { esPreguntaConSustancia } from '../src/lib/voice-filter';

describe('esPreguntaConSustancia', () => {
  it('acepta preguntas reales, cortas o largas', () => {
    expect(esPreguntaConSustancia('¿Cómo cerró el dólar?')).toBe(true);
    expect(esPreguntaConSustancia('Peñarol Nacional')).toBe(true);
    expect(esPreguntaConSustancia('¿Qué pasó con el Frigorífico Tacuarembó?')).toBe(true);
  });

  it('descarta lo que el reconocimiento saca del ruido: sílabas, muletillas, una palabra al pasar', () => {
    for (const ruido of ['eh', 'mmm', 'sí', 'ok', 'dale', 'bueno', 'ah sí', 'no no', 'hola', 'ya']) {
      expect(esPreguntaConSustancia(ruido)).toBe(false);
    }
    expect(esPreguntaConSustancia('')).toBe(false);
  });
});
