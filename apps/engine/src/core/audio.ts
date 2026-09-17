import type { AudioMode, AudioPlan, Config } from '@pelp/domain';
import { AUDIO_SCRIPT_VERSION, audioScript, bodyFromMarkdown } from '@pelp/domain';
import { sha256Hex } from '@pelp/domain/node';
import type { AudioStoreGateway, CorpusBodyGateway, SpeechGateway } from './gateways';
import type { Logger } from './log';
import type { Store } from './store';

export interface AudioDeps {
  store: Store;
  corpusBody?: CorpusBodyGateway | undefined;
  audioStore?: AudioStoreGateway | undefined;
  speech?: SpeechGateway | undefined;
  log: Logger;
}

export interface AudioResult {
  articleId: string;
  title: string;
  url: string;
  date: string;
  section: string;
  plan: AudioPlan;
  chars: number;
  truncated: boolean;
  /** Presente con `mode=script`: el texto para que lo diga el cliente. */
  script?: string;
  /** Presente con `mode=audio`: enlace firmado al MP3 ya guardado. */
  audioUrl?: string;
  voice?: string;
  engine?: string;
  /** Si el MP3 ya existía. En false se acaba de sintetizar y se cobró una vez. */
  cached?: boolean;
}

export class AudioError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * La clave del audio guardado. Lleva el hash del contenido de la nota, la voz, el motor y la
 * versión del guion: si la nota se corrige o se cambia la voz, se sintetiza de nuevo; si no,
 * nunca. Va bajo `audio/`, fuera del prefijo que indexa la Knowledge Base.
 */
export function audioKey(articleId: string, contentHash: string, voice: string, engine: string): string {
  const fingerprint = sha256Hex([contentHash, voice, engine, AUDIO_SCRIPT_VERSION].join('|')).slice(0, 16);
  return `audio/${articleId}/${fingerprint}.mp3`;
}

/**
 * Lectura en voz de una nota. Con `mode=script` devuelve el texto y no cuesta nada: lo dice el
 * navegador de quien escucha. Con `mode=audio` devuelve un enlace al MP3, que se sintetiza la
 * primera vez y se reutiliza siempre.
 */
export async function articleAudio(
  deps: AudioDeps,
  config: Config,
  input: { articleId: string; plan: AudioPlan; mode: AudioMode },
): Promise<AudioResult> {
  if (!config.audio.enabled) throw new AudioError(503, 'La lectura en voz está apagada.', 'audio_disabled');

  const record = await deps.store.getCorpusIndex(input.articleId);
  if (!record || record.removed) throw new AudioError(404, 'Nota no encontrada.', 'not_found');

  const markdown = await deps.corpusBody?.read(record.s3Key).catch(() => undefined);
  if (!markdown) throw new AudioError(404, 'No se pudo leer el texto de la nota.', 'not_found');

  const script = audioScript(
    { title: record.title, deck: record.deck, body: bodyFromMarkdown(markdown) },
    config.audio.maxChars,
  );
  if (!script.text) throw new AudioError(404, 'La nota no tiene texto para leer.', 'not_found');

  const base: AudioResult = {
    articleId: record.articleId,
    title: record.title,
    url: record.url,
    date: record.date,
    section: record.section,
    plan: input.plan,
    chars: script.chars,
    truncated: script.truncated,
  };

  if (input.mode === 'script') return { ...base, script: script.text };

  const plan = config.audio.plans[input.plan];
  if (!deps.audioStore || !deps.speech) throw new AudioError(503, 'La síntesis de voz no está disponible.', 'audio_unavailable');

  const key = audioKey(record.articleId, record.contentHash, plan.voice, plan.engine);
  const ttl = config.audio.urlTtlMinutes * 60;
  if (await deps.audioStore.exists(key)) {
    deps.log.info('audio.cache_hit', { articleId: record.articleId, plan: input.plan });
    return { ...base, audioUrl: await deps.audioStore.signedUrl(key, ttl), voice: plan.voice, engine: plan.engine, cached: true };
  }

  deps.log.info('audio.synthesize', { articleId: record.articleId, plan: input.plan, voice: plan.voice, engine: plan.engine, chars: script.chars });
  const bytes = await deps.speech.synthesize({ text: script.text, voice: plan.voice, engine: plan.engine });
  if (!bytes.length) throw new AudioError(502, 'No se pudo generar el audio.', 'audio_failed');
  await deps.audioStore.put(key, bytes, 'audio/mpeg');
  return { ...base, audioUrl: await deps.audioStore.signedUrl(key, ttl), voice: plan.voice, engine: plan.engine, cached: false };
}

/**
 * Lectura en voz de una respuesta generada. Es lo que el lector tiene delante: si la respuesta se
 * adaptó a su perfil, se lee la adaptada y no la canónica. Se guarda igual que el audio de una
 * nota, con la huella del texto adentro de la clave: una respuesta no cambia, así que se sintetiza
 * una sola vez.
 */
export async function answerAudio(
  deps: AudioDeps,
  config: Config,
  input: { answerId: string; text: string; plan: AudioPlan; mode: AudioMode },
): Promise<{ answerId: string; plan: AudioPlan; chars: number; script?: string; audioUrl?: string; voice?: string; engine?: string; cached?: boolean }> {
  if (!config.audio.enabled) throw new AudioError(503, 'La lectura en voz está apagada.', 'audio_disabled');
  const text = input.text.trim().slice(0, config.audio.maxChars);
  if (!text) throw new AudioError(404, 'La respuesta no tiene texto para leer.', 'not_found');

  const base = { answerId: input.answerId, plan: input.plan, chars: text.length };
  if (input.mode === 'script') return { ...base, script: text };

  const plan = config.audio.plans[input.plan];
  if (!deps.audioStore || !deps.speech) throw new AudioError(503, 'La síntesis de voz no está disponible.', 'audio_unavailable');

  const fingerprint = sha256Hex([sha256Hex(text), plan.voice, plan.engine, AUDIO_SCRIPT_VERSION].join('|')).slice(0, 16);
  const key = `audio/answers/${input.answerId}/${fingerprint}.mp3`;
  const ttl = config.audio.urlTtlMinutes * 60;
  if (await deps.audioStore.exists(key)) {
    deps.log.info('audio.answer_cache_hit', { answerId: input.answerId, plan: input.plan });
    return { ...base, audioUrl: await deps.audioStore.signedUrl(key, ttl), voice: plan.voice, engine: plan.engine, cached: true };
  }

  deps.log.info('audio.answer_synthesize', { answerId: input.answerId, plan: input.plan, voice: plan.voice, engine: plan.engine, chars: text.length });
  const bytes = await deps.speech.synthesize({ text, voice: plan.voice, engine: plan.engine });
  if (!bytes.length) throw new AudioError(502, 'No se pudo generar el audio.', 'audio_failed');
  await deps.audioStore.put(key, bytes, 'audio/mpeg');
  return { ...base, audioUrl: await deps.audioStore.signedUrl(key, ttl), voice: plan.voice, engine: plan.engine, cached: false };
}
