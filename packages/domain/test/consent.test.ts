import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSENT_TEXT_V1, CONSENT_TEXT_VERSION_V1, TERMS_TEXT_V1 } from '../src/consent/v1';
import { sha256Hex } from '../src/node';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('texto de consentimiento (Apéndice A)', () => {
  it('el string embebido coincide con consent/v1.md', () => {
    const md = readFileSync(path.join(here, '../consent/v1.md'), 'utf8');
    expect(CONSENT_TEXT_V1).toBe(md);
  });

  it('textVersion es el sha256 del texto mostrado', () => {
    expect(sha256Hex(CONSENT_TEXT_V1)).toBe(CONSENT_TEXT_VERSION_V1);
    expect(CONSENT_TEXT_VERSION_V1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('los términos completos coinciden con consent/terms-v1.md', () => {
    const md = readFileSync(path.join(here, '../consent/terms-v1.md'), 'utf8');
    expect(TERMS_TEXT_V1).toBe(md);
  });

  it('menciona las dos opciones y la edad mínima', () => {
    expect(CONSENT_TEXT_V1).toContain('Con personalización');
    expect(CONSENT_TEXT_V1).toContain('Sin personalización');
    expect(CONSENT_TEXT_V1).toContain('18 años');
  });
});
