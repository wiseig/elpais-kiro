/**
 * Historial local de conversaciones (para el riel de "Recientes" y el panel de Historial):
 * vive en localStorage bajo `pelp.history`, separado por token de sesión, y se descarta al
 * borrar los datos o al cambiar de token. Una conversación se persiste recién cuando tiene
 * al menos un intercambio, para no mostrar entradas vacías en la lista.
 */
import type { Answer } from '@pelp/domain';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'answer'; id: string; answer: Answer }
  | { kind: 'error'; id: string; message: string; retryText: string | null };

export interface ConversationSummary {
  id: string;
  conversationId: string | undefined;
  title: string;
  updatedAt: number;
  /** Cantidad de preguntas del lector en esta conversación (para el panel de Historial). */
  questionCount: number;
}

export interface ConversationRecord {
  id: string;
  conversationId: string | undefined;
  title: string;
  updatedAt: number;
  items: ChatItem[];
}

const KEY = 'pelp.history';
const MAX_CONVERSATIONS = 30;
const MAX_ITEMS_PER_CONVERSATION = 200;
const MAX_TITLE_LENGTH = 48;

interface StoredHistory {
  token: string;
  conversations: ConversationRecord[];
}

function isChatItem(value: unknown): value is ChatItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { kind?: unknown; id?: unknown };
  if (typeof item.id !== 'string') return false;
  return item.kind === 'user' || item.kind === 'answer' || item.kind === 'error';
}

function isConversationRecord(value: unknown): value is ConversationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ConversationRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.updatedAt === 'number' &&
    Array.isArray(record.items)
  );
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(token: string | null): ConversationRecord[] {
  const store = storage();
  if (!store || !token) return [];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const data = parsed as Partial<StoredHistory>;
    if (data.token !== token || !Array.isArray(data.conversations)) return [];
    return data.conversations
      .filter(isConversationRecord)
      .map((record) => ({ ...record, items: record.items.filter(isChatItem) }));
  } catch {
    return [];
  }
}

function writeAll(token: string | null, conversations: ConversationRecord[]): void {
  const store = storage();
  if (!store || !token) return;
  try {
    if (conversations.length === 0) {
      store.removeItem(KEY);
      return;
    }
    const trimmed = conversations
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
      .map((record) => ({ ...record, items: record.items.slice(-MAX_ITEMS_PER_CONVERSATION) }));
    const payload: StoredHistory = { token, conversations: trimmed };
    store.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Cuota llena o almacenamiento bloqueado: el historial vive solo en esta pestaña.
  }
}

function titleFrom(items: ChatItem[]): string {
  const firstUser = items.find((item) => item.kind === 'user');
  const text = firstUser && firstUser.kind === 'user' ? firstUser.text.trim() : '';
  if (!text) return 'Nueva conversación';
  if (text.length <= MAX_TITLE_LENGTH) return text;
  return `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/** Identificador local y estable para una conversación nueva (no depende del servidor). */
export function newConversationId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Lista de conversaciones recientes, más nueva primero. */
export function listConversations(token: string | null): ConversationSummary[] {
  return readAll(token)
    .map(({ id, conversationId, title, updatedAt, items }) => ({
      id,
      conversationId,
      title,
      updatedAt,
      questionCount: items.reduce((count, item) => (item.kind === 'user' ? count + 1 : count), 0),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConversation(token: string | null, id: string): ConversationRecord | null {
  return readAll(token).find((record) => record.id === id) ?? null;
}

/** Guarda (o actualiza) una conversación. No hace nada si todavía no tiene mensajes. */
export function saveConversation(
  token: string | null,
  id: string,
  patch: { conversationId: string | undefined; items: ChatItem[] },
): void {
  if (patch.items.length === 0) return;
  const conversations = readAll(token);
  const index = conversations.findIndex((record) => record.id === id);
  const existing = index >= 0 ? conversations[index] : undefined;
  const record: ConversationRecord = {
    id,
    conversationId: patch.conversationId,
    title: existing?.title ?? titleFrom(patch.items),
    updatedAt: Date.now(),
    items: patch.items,
  };
  if (index >= 0) conversations[index] = record;
  else conversations.push(record);
  writeAll(token, conversations);
}

export function removeConversation(token: string | null, id: string): void {
  writeAll(token, readAll(token).filter((record) => record.id !== id));
}

/** Borra todo el historial local (todas las conversaciones de este token). */
export function clearHistory(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    // Nada que hacer.
  }
}

/**
 * Borra las conversaciones guardadas para este token puntual (acción "Borrar todo el
 * historial" del panel de Historial). A diferencia de `clearHistory`, no hace nada si el
 * token no coincide con el dueño de los datos guardados.
 */
export function clearConversations(token: string | null): void {
  if (!token) return;
  const store = storage();
  if (!store) return;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    const stored = typeof parsed === 'object' && parsed !== null ? (parsed as Partial<StoredHistory>).token : undefined;
    if (stored === token) store.removeItem(KEY);
  } catch {
    // Entrada corrupta: no hay nada consistente que borrar para este token.
  }
}
