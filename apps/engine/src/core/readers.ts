import type { Config, ConsentDecision, ReaderMode, ReaderProfile, ReaderRecord } from '@pelp/domain';
import { frameById } from '@pelp/domain';
import { rolloutBucket } from '@pelp/domain/node';
import type { MeResponse } from '@pelp/domain/api';
import type { Store } from './store';

export function readerMode(reader: ReaderRecord): ReaderMode {
  if (!reader.profile.terms.accepted) return 'undecided';
  return reader.profile.consent.personalization ? 'personalized' : 'neutral';
}

/** Puerta de entrada (8.4): sin términos aceptados o con texto nuevo, hay que decidir de nuevo. */
export function needsConsent(reader: ReaderRecord, config: Config): boolean {
  if (!reader.profile.terms.accepted) return true;
  if (config.consent.reshowOnVersionChange && reader.profile.terms.version !== config.consent.textVersion) return true;
  return false;
}

export async function resolveReader(store: Store, channel: string, channelUserHash: string, now: Date, config: Config): Promise<ReaderRecord> {
  const readerId = await store.findReaderIdByIdentity(channel, channelUserHash);
  if (readerId) {
    const reader = await store.getReader(readerId);
    if (reader) return reader;
  }
  return store.createReader(channel, channelUserHash, now, config.consent.textVersion);
}

export interface ConsentEvidence {
  channel: string;
  locale?: string;
  uaHash?: string;
  ipPrefixHash?: string;
  ageConfirmed?: boolean;
}

export class ConsentError extends Error {
  constructor(
    readonly code: 'stale_text_version' | 'age_required' | 'invalid_decision',
    message: string,
  ) {
    super(message);
    this.name = 'ConsentError';
  }
}

function emptyProfileFields(profile: ReaderProfile, now: Date): ReaderProfile {
  return {
    ...profile,
    topics: [],
    frames: [],
    style: { length: 'media', dataAffinity: 'media', tone: 'directo' },
    evidenceCount: 0,
    updatedAt: now.toISOString(),
    version: 0,
  };
}

/**
 * Registra una decisión (8.4): CONSENT# inmutable + actualización del lector.
 * Pasar a neutral borra el perfil inferido; pasar a personalizado arranca vacío.
 */
export async function recordDecision(
  store: Store,
  reader: ReaderRecord,
  decision: 'personalize' | 'neutral',
  textVersion: string,
  evidence: ConsentEvidence,
  config: Config,
  now: Date,
): Promise<ReaderRecord> {
  if (textVersion !== config.consent.textVersion) {
    throw new ConsentError('stale_text_version', 'El texto de términos cambió. Volvé a leerlo y decidí de nuevo.');
  }
  if (decision === 'personalize' && !evidence.ageConfirmed) {
    throw new ConsentError('age_required', `Para activar la personalización tenés que declarar ${config.consent.minAgePersonalization} años o más.`);
  }
  const previous = readerMode(reader);
  let recorded: ConsentDecision = decision;
  if (previous === 'personalized' && decision === 'neutral') recorded = 'switch-to-neutral';
  if (previous === 'neutral' && decision === 'personalize') recorded = 'switch-to-personalize';
  const at = now.toISOString();

  await store.putConsent(reader.profile.readerId, {
    decision: recorded,
    textVersion,
    channel: evidence.channel,
    at,
    ...(evidence.locale ? { locale: evidence.locale } : {}),
    ...(evidence.uaHash ? { uaHash: evidence.uaHash } : {}),
    ...(evidence.ipPrefixHash ? { ipPrefixHash: evidence.ipPrefixHash } : {}),
    ...(evidence.ageConfirmed !== undefined ? { ageConfirmed: evidence.ageConfirmed } : {}),
  });

  let profile: ReaderProfile = {
    ...reader.profile,
    terms: { accepted: true, version: textVersion, at },
    consent: {
      personalization: decision === 'personalize',
      sensitiveInference: decision === 'personalize',
      at,
      version: textVersion,
    },
  };
  let cohort = reader.cohort;
  if (decision === 'neutral') {
    profile = emptyProfileFields(profile, now);
    delete profile.politicalLean;
    cohort = undefined;
    await store.deleteProfileVersions(reader.profile.readerId);
  } else if (previous !== 'personalized') {
    profile = emptyProfileFields(profile, now);
    delete profile.politicalLean;
    cohort = rolloutBucket(reader.profile.readerId) < config.personalization.rolloutPercent ? 'personalized' : 'control';
  }
  const next: ReaderRecord = {
    ...reader,
    profile,
    lastActivityAt: at,
    lastChannel: evidence.channel,
    questionsSinceProfile: decision === 'neutral' ? 0 : reader.questionsSinceProfile,
    ...(cohort ? { cohort } : {}),
  };
  if (!cohort) delete next.cohort;
  await store.saveReader(next);
  return next;
}

/** "Por qué veo esto" en lenguaje llano (9.5). */
export function profileSummary(profile: ReaderProfile): string | undefined {
  if (profile.evidenceCount === 0 || (!profile.topics.length && !profile.frames.length)) return undefined;
  const topics = profile.topics
    .slice(0, 2)
    .map((topic) => topic.id.replace(/-/g, ' '))
    .join(' y ');
  const frames = profile.frames
    .slice(0, 2)
    .map((frame) => frameById(frame.id)?.label.toLowerCase() ?? frame.id)
    .join(' y ');
  const parts: string[] = [];
  if (topics) parts.push(`Sueles preguntar por ${topics}.`);
  if (frames) parts.push(`Te importan sobre todo ${frames}, y por eso empezamos las respuestas por ese ángulo.`);
  parts.push('Los hechos, las cifras y las notas citadas son los mismos para todos.');
  return parts.join(' ');
}

export function personalizationActive(reader: ReaderRecord, config: Config): boolean {
  return (
    config.personalization.enabled &&
    config.personalization.intensity > 0 &&
    readerMode(reader) === 'personalized' &&
    reader.cohort === 'personalized'
  );
}

export function meResponse(reader: ReaderRecord, config: Config): MeResponse {
  const mode = readerMode(reader);
  const summary = mode === 'personalized' ? profileSummary(reader.profile) : undefined;
  return {
    mode,
    needsConsent: needsConsent(reader, config),
    terms: { accepted: reader.profile.terms.accepted, version: reader.profile.terms.version, ...(reader.profile.terms.at ? { at: reader.profile.terms.at } : {}) },
    consent: {
      personalization: reader.profile.consent.personalization,
      sensitiveInference: reader.profile.consent.sensitiveInference,
      version: reader.profile.consent.version,
      ...(reader.profile.consent.at ? { at: reader.profile.consent.at } : {}),
    },
    ...(summary ? { profileSummary: summary } : {}),
    ...(reader.cohort ? { cohort: reader.cohort } : {}),
    personalizationActive: personalizationActive(reader, config),
    questionCount: reader.questionCount,
  };
}

/** Borrado físico (8.4): datos del lector, identidades y lápida anónima. */
export async function deleteReader(store: Store, reader: ReaderRecord, identities: { channel: string; hash: string }[], now: Date): Promise<{ deletedItems: number; strippedLogs: number }> {
  await store.putConsentTombstone(reader.profile.terms.version, reader.lastChannel, now);
  return store.deleteReaderData(reader.profile.readerId, identities);
}
