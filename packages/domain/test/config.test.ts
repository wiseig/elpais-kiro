import { describe, expect, it } from 'vitest';
import { CONSENT_TEXT_VERSION_V1 } from '../src/consent/v1';
import { defaultConfig, effectiveIntensity, intensityLevel, validateConfig } from '../src/config';

describe('configuración global (sección 13)', () => {
  const config = defaultConfig(CONSENT_TEXT_VERSION_V1);

  it('arranca con personalización apagada', () => {
    expect(config.personalization.enabled).toBe(false);
    expect(config.personalization.intensity).toBe(0);
    expect(config.personalization.rolloutPercent).toBe(0);
  });

  it('valida y devuelve errores legibles', () => {
    const broken = { ...config, limits: { ...config.limits, onBudgetExceeded: 'explode' } };
    const result = validateConfig(broken);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('limits.onBudgetExceeded');
  });

  it('advierte cuando intensity supera hardMax', () => {
    const hot = { ...config, personalization: { ...config.personalization, intensity: 0.9 } };
    const result = validateConfig(hot);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('hardMax');
  });

  it('intensidad efectiva respeta hardMax y dimensiones', () => {
    const hot = { ...config, personalization: { ...config.personalization, intensity: 1 } };
    expect(effectiveIntensity(hot, 'topics')).toBe(0.7);
    expect(effectiveIntensity(hot, 'politicalLean')).toBe(0.5);
  });

  it('niveles de la sección 9.2', () => {
    expect(intensityLevel(0)).toBe(0);
    expect(intensityLevel(0.2)).toBe(1);
    expect(intensityLevel(0.5)).toBe(2);
    expect(intensityLevel(0.9)).toBe(3);
  });
});
