import { describe, expect, it } from 'vitest';
import { GOLDEN_SET, PHASE0_CASES, SYNTHETIC_PROFILES } from '../src/index';

describe('set dorado', () => {
  it('tiene al menos 8 casos con ids únicos y URLs de El País', () => {
    expect(PHASE0_CASES).toHaveLength(8);
    expect(new Set(GOLDEN_SET.cases.map((item) => item.id)).size).toBe(GOLDEN_SET.cases.length);
    for (const item of GOLDEN_SET.cases) {
      for (const url of item.expectedUrls) expect(url).toMatch(/^https:\/\/([a-z0-9-]+\.)?elpais\.com\.uy\//);
      if (!item.expectedCoverage) expect(item.expectedUrls).toHaveLength(0);
    }
  });

  it('los perfiles sintéticos son dos orientaciones opuestas por dos encuadres', () => {
    expect(SYNTHETIC_PROFILES).toHaveLength(4);
    const leans = new Set(SYNTHETIC_PROFILES.map((profile) => profile.politicalLean?.bucket));
    expect(leans).toEqual(new Set(['centro-izquierda', 'centro-derecha']));
  });
});
