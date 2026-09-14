import type { ConversationTurn, ReaderProfile, RetrievedChunk, SourceItem } from '@pelp/domain';
import { frameById, intensityLevel } from '@pelp/domain';

/** Renderiza los fragmentos como datos (no instrucciones) para el prompt canónico. */
export function renderChunks(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, position) => {
      const index = chunk.index ?? position + 1;
      const safe = chunk.text.replace(/<\/?FRAGMENTO[^>]*>/gi, '');
      return `<FRAGMENTO n="${index}" titulo="${escapeAttr(chunk.title)}" fecha="${chunk.date}" seccion="${escapeAttr(chunk.section)}">
${safe}
</FRAGMENTO>`;
    })
    .join('\n\n');
}

export function buildCanonicalUserMessage(
  question: string,
  chunks: RetrievedChunk[],
  today: string,
  /** Aviso de desfase: la pregunta pide algo actual y las notas son viejas (6.3). */
  dateNotice?: string,
  /** Pedido de panorama: los fragmentos son la tapa del día, no una búsqueda por tema. */
  digestNotice?: string,
): string {
  const notice = dateNotice ? `\n<AVISO_DE_FECHA>\n${dateNotice}\n</AVISO_DE_FECHA>\n` : '';
  const digest = digestNotice ? `\n<PEDIDO_DEL_DIA>\n${digestNotice}\n</PEDIDO_DEL_DIA>\n` : '';
  return `Fecha de hoy: ${today}.
${notice}${digest}
<FRAGMENTOS>
${renderChunks(chunks)}
</FRAGMENTOS>

<PREGUNTA>
${question}
</PREGUNTA>`;
}

export function buildRewriteUserMessage(turns: ConversationTurn[], question: string): string {
  const history = turns
    .map((turn) => `${turn.role === 'user' ? 'Lector' : 'Asistente'}: ${turn.text}`)
    .join('\n');
  return `<CONVERSACION>
${history}
</CONVERSACION>

<NUEVA_PREGUNTA>
${question}
</NUEVA_PREGUNTA>`;
}

export function buildOffTopicUserMessage(question: string): string {
  return `<PREGUNTA>
${question}
</PREGUNTA>`;
}

export interface ProfileForPrompt {
  topics: { id: string; weight: number }[];
  frames: { id: string; weight: number }[];
  style: ReaderProfile['style'];
  politicalLean?: ReaderProfile['politicalLean'];
}

/** Perfil en lenguaje llano y sin etiquetas partidarias; solo las dimensiones habilitadas. */
export function renderProfile(profile: ProfileForPrompt): string {
  const topics = profile.topics
    .slice(0, 5)
    .map((topic) => `${topic.id} (${topic.weight.toFixed(2)})`)
    .join(', ');
  const frames = profile.frames
    .slice(0, 4)
    .map((frame) => `${frameById(frame.id)?.label ?? frame.id} (${frame.weight.toFixed(2)})`)
    .join(', ');
  const lines = [
    `Temas que sigue: ${topics || 'sin señal'}`,
    `Encuadres que le importan: ${frames || 'sin señal'}`,
    `Estilo preferido: largo ${profile.style.length}, afinidad con datos ${profile.style.dataAffinity}, tono ${profile.style.tone}`,
  ];
  if (profile.politicalLean && profile.politicalLean.bucket !== 'sin-señal') {
    lines.push(`Orientación general (solo para elegir encuadre): ${profile.politicalLean.bucket}`);
  }
  return lines.join('\n');
}

export function buildAdaptationUserMessage(input: {
  question: string;
  canonical: string;
  sources: SourceItem[];
  profile: ProfileForPrompt;
  intensity: number;
}): string {
  const level = intensityLevel(input.intensity);
  const sources = input.sources.map((source, index) => `${index + 1}. ${source.title} (${source.date}) ${source.url}`).join('\n');
  return `Nivel de adaptación: ${level} (intensidad ${input.intensity.toFixed(2)}).

<PERFIL>
${renderProfile(input.profile)}
</PERFIL>

<PREGUNTA>
${input.question}
</PREGUNTA>

<RESPUESTA_ORIGINAL>
${input.canonical}
</RESPUESTA_ORIGINAL>

<FUENTES>
${sources || '(sin fuentes)'}
</FUENTES>`;
}

export function buildVerifierUserMessage(input: {
  canonical: string;
  adapted: string;
  canonicalSources: SourceItem[];
  adaptedSources: SourceItem[];
}): string {
  const list = (sources: SourceItem[]) => sources.map((source) => source.url).join('\n') || '(sin fuentes)';
  return `<ORIGINAL>
${input.canonical}
</ORIGINAL>
<FUENTES_ORIGINAL>
${list(input.canonicalSources)}
</FUENTES_ORIGINAL>

<ADAPTADA>
${input.adapted}
</ADAPTADA>
<FUENTES_ADAPTADA>
${list(input.adaptedSources)}
</FUENTES_ADAPTADA>`;
}

export interface ProfilerEvidence {
  questions: { at: string; text: string }[];
  clicks: { title?: string; section?: string; at: string }[];
  feedback: { vote: 'up' | 'down'; comment?: string; at: string }[];
}

export function buildProfilerUserMessage(evidence: ProfilerEvidence): string {
  const questions = evidence.questions.map((question) => `- [${question.at.slice(0, 10)}] ${question.text}`).join('\n');
  const clicks = evidence.clicks.map((click) => `- [${click.at.slice(0, 10)}] ${click.title ?? '(sin título)'} · ${click.section ?? ''}`).join('\n');
  const feedback = evidence.feedback
    .map((item) => `- [${item.at.slice(0, 10)}] ${item.vote === 'up' ? '👍' : '👎'} ${item.comment ?? ''}`)
    .join('\n');
  return `<PREGUNTAS>
${questions || '(ninguna)'}
</PREGUNTAS>

<NOTAS_ABIERTAS>
${clicks || '(ninguna)'}
</NOTAS_ABIERTAS>

<FEEDBACK>
${feedback || '(ninguno)'}
</FEEDBACK>`;
}

export function buildBiasJudgeUserMessage(versions: { label: string; text: string }[]): string {
  return versions.map((version) => `<VERSION id="${version.label}">\n${version.text}\n</VERSION>`).join('\n\n');
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
