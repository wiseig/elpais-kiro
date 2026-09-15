import { describe, expect, it } from 'vitest';
import { isStance, scoreStances, type Stance } from '../src/stance';

const s = (objetivo: Stance['objetivo'], postura: Stance['postura'], cita = 'x'): Stance => ({ cita, objetivo, postura });

describe('scoreStances', () => {
  it('rechazar a la izquierda ubica al lector a la derecha', () => {
    // El caso real que el modelo devolvía invertido una y otra vez.
    const r = scoreStances([
      s('izquierda', 'rechaza', 'odio a la izquierda'),
      s('izquierda', 'rechaza', 'el frente amplio es una mafia'),
      s('izquierda', 'rechaza', 'por qué estos zurdos no se van del gobierno'),
      s('izquierda', 'rechaza', 'odio al gobierno de turno'),
      s('izquierda', 'rechaza', 'el rumbo de este gobierno nos va a hundir'),
    ]);
    expect(r.score).toBe(1);
    expect(r.bucket).toBe('derecha');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('apoyar a la izquierda ubica al lector a la izquierda', () => {
    const r = scoreStances([s('izquierda', 'apoya'), s('derecha', 'rechaza'), s('izquierda', 'apoya')]);
    expect(r.bucket).toBe('izquierda');
    expect(r.score).toBe(-1);
  });

  it('posturas contradictorias no dan señal, y no las llamamos "centro"', () => {
    // Rechazar a los dos lados podría ser centrismo o podría ser ruido, y no hay forma de
    // distinguirlos. Decir "sin señal" es lo honesto; decir "centro" sería inventar una postura.
    const r = scoreStances([s('izquierda', 'rechaza'), s('derecha', 'rechaza')]);
    expect(r.bucket).toBe('sin-señal');
    expect(r.confidence).toBe(0);
  });

  it('los objetivos sin tendencia no cuentan', () => {
    expect(scoreStances([s('ninguno', 'rechaza'), s('centro', 'apoya')]).bucket).toBe('sin-señal');
  });

  it('la confianza crece con la evidencia y se corta por la coherencia', () => {
    const pocas = scoreStances([s('izquierda', 'rechaza'), s('izquierda', 'rechaza')]);
    const muchas = scoreStances(Array.from({ length: 6 }, () => s('izquierda', 'rechaza')));
    expect(muchas.confidence).toBeGreaterThan(pocas.confidence);
    expect(muchas.confidence).toBeLessThanOrEqual(0.95);

    // Seis frases repartidas entre los dos lados no valen más que ninguna.
    const mezcla = scoreStances([
      ...Array.from({ length: 3 }, () => s('izquierda', 'rechaza')),
      ...Array.from({ length: 3 }, () => s('izquierda', 'apoya')),
    ]);
    expect(mezcla.confidence).toBe(0);
  });
});

describe('isStance', () => {
  it('rechaza lo que no tiene la forma esperada', () => {
    expect(isStance({ cita: 'x', objetivo: 'izquierda', postura: 'rechaza' })).toBe(true);
    expect(isStance({ cita: '', objetivo: 'izquierda', postura: 'rechaza' })).toBe(false);
    expect(isStance({ cita: 'x', objetivo: 'zurdos', postura: 'rechaza' })).toBe(false);
    expect(isStance({ cita: 'x', objetivo: 'izquierda', postura: 'odia' })).toBe(false);
    expect(isStance(null)).toBe(false);
  });
});
