import { describe, expect, it } from 'vitest';
import { sectionLabel } from '../src/sections';

describe('sectionLabel', () => {
  it('muestra la subsección cuando le dice algo al lector', () => {
    expect(sectionLabel('informacion/politica')).toBe('Política');
    expect(sectionLabel('informacion/policiales')).toBe('Policiales');
    expect(sectionLabel('informacion/educacion')).toBe('Educación');
    expect(sectionLabel('ovacion/futbol')).toBe('Fútbol');
    expect(sectionLabel('mundo/estados-unidos')).toBe('Estados Unidos');
  });

  it('cae al padre cuando la subsección es genérica u opaca', () => {
    expect(sectionLabel('negocios/noticias')).toBe('Negocios');
    expect(sectionLabel('tvshow/personajes')).toBe('TV Show');
    expect(sectionLabel('opinion/ecos')).toBe('Opinión');
    expect(sectionLabel('opinion/la-clave')).toBe('Opinión');
    expect(sectionLabel('bienestar/mente')).toBe('Bienestar');
    expect(sectionLabel('informacion/en-clave-pais')).toBe('Información');
  });

  it('acepta el primer nivel solo, mayúsculas y slugs desconocidos', () => {
    expect(sectionLabel('informacion')).toBe('Información');
    expect(sectionLabel('Ovacion/Futbol')).toBe('Fútbol');
    expect(sectionLabel('seccion-nueva/algo')).toBe('Seccion nueva');
    expect(sectionLabel('')).toBe('');
  });
});
