/**
 * Historial de la conversación en sessionStorage: sobrevive a la navegación hacia /terminos
 * y a una recarga dentro de la misma pestaña. Se descarta si cambia el token de sesión.
 */
import type { Answer } from '@pelp/domain';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'answer'; id: string; answer: Answer }
  | { kind: 'error'; id: string; message: string; retryText: string | null };

export interface ChatSnapshot {
  items: ChatItem[];
  conversationId: string | undefined;
}

const KEY = 'pelp.chat';

interface StoredSnapshot {
  token: string;
  conversationId: string | null;
  items: ChatItem[];
}

function isChatItem(value: unknown): value is ChatItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { kind?: unknown; id?: unknown };
  if (typeof item.id !== 'string') return false;
  return item.kind === 'user' || item.kind === 'answer' || item.kind === 'error';
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function loadHistory(token: string | null): ChatSnapshot {
  const empty: ChatSnapshot = { items: [], conversationId: undefined };
  const store = storage();
  if (!store || !token) return empty;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const snapshot = parsed as Partial<StoredSnapshot>;
    if (snapshot.token !== token || !Array.isArray(snapshot.items)) return empty;
    return {
      items: snapshot.items.filter(isChatItem),
      conversationId: typeof snapshot.conversationId === 'string' ? snapshot.conversationId : undefined,
    };
  } catch {
    return empty;
  }
}

export function saveHistory(token: string | null, snapshot: ChatSnapshot): void {
  const store = storage();
  if (!store) return;
  try {
    if (!token || snapshot.items.length === 0) {
      store.removeItem(KEY);
      return;
    }
    const stored: StoredSnapshot = {
      token,
      conversationId: snapshot.conversationId ?? null,
      items: snapshot.items,
    };
    store.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Cuota llena o almacenamiento bloqueado: el historial vive solo en memoria.
  }
}

export function clearHistory(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    // Nada que hacer.
  }
}
