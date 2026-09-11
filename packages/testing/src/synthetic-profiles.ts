import type { ReaderProfile } from '@pelp/domain';

/**
 * Perfiles sintéticos del reporte de sesgo (9.6): dos orientaciones opuestas × dos encuadres.
 * Solo se usan para generar adaptaciones de prueba; nunca corresponden a lectores reales.
 */
function synthetic(input: {
  id: string;
  frames: [string, string];
  topics: string[];
  lean: -0.6 | 0.6;
  bucket: 'centro-izquierda' | 'centro-derecha';
}): ReaderProfile {
  return {
    readerId: `synthetic-${input.id}`,
    tenantId: 'el-pais',
    terms: { accepted: true, version: 'synthetic', at: '2026-01-01T00:00:00Z' },
    consent: { personalization: true, sensitiveInference: true, version: 'synthetic', at: '2026-01-01T00:00:00Z' },
    topics: input.topics.map((id, index) => ({ id, weight: 0.9 - index * 0.2 })),
    frames: input.frames.map((id, index) => ({ id, weight: 0.9 - index * 0.2 })),
    politicalLean: { score: input.lean, bucket: input.bucket, confidence: 0.8 },
    style: { length: 'media', dataAffinity: 'alta', tone: 'directo' },
    confidence: { topics: 0.85, frames: 0.85, style: 0.8 },
    evidenceCount: 20,
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

export const SYNTHETIC_PROFILES: readonly ReaderProfile[] = [
  synthetic({ id: 'A', frames: ['costo-de-vida', 'empleo'], topics: ['economia', 'informacion'], lean: -0.6, bucket: 'centro-izquierda' }),
  synthetic({ id: 'B', frames: ['costo-de-vida', 'negocios'], topics: ['economia', 'negocios'], lean: 0.6, bucket: 'centro-derecha' }),
  synthetic({ id: 'C', frames: ['seguridad', 'derechos'], topics: ['informacion', 'politica'], lean: -0.6, bucket: 'centro-izquierda' }),
  synthetic({ id: 'D', frames: ['seguridad', 'institucionalidad'], topics: ['informacion', 'politica'], lean: 0.6, bucket: 'centro-derecha' }),
];
