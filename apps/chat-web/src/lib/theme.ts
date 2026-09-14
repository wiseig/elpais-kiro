/**
 * Selección de tema (9.x, pedido del owner): "system" (por defecto, sigue
 * `prefers-color-scheme`), "light" u "dark". Se persiste en localStorage bajo `pelp.theme`
 * y se aplica seteando `document.documentElement.dataset.theme`. `index.html` ya corre un
 * script en línea con esta misma lógica para fijar el atributo antes del primer pintado
 * (evita el flash de tema claro); este módulo es la fuente de verdad después de eso.
 */
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeState {
  /** Lo que eligió la persona (o "system" si nunca eligió). */
  preference: ThemePreference;
  /** El tema efectivamente aplicado ("system" ya resuelto). */
  resolved: ResolvedTheme;
}

const STORAGE_KEY = 'pelp.theme';
const LIGHT_THEME_COLOR = '#004f88';
const DARK_THEME_COLOR = '#0b1220';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredPreference(): ThemePreference {
  const stored = storage()?.getItem(STORAGE_KEY) ?? null;
  return isThemePreference(stored) ? stored : 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference;
}

function applyToDocument(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', resolved === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
}

let state: ThemeState = { preference: readStoredPreference(), resolved: resolve(readStoredPreference()) };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function setState(next: ThemeState): void {
  state = next;
  applyToDocument(next.resolved);
  notify();
}

// Mientras la preferencia sea "system", seguí los cambios del sistema operativo en vivo.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemChange = () => {
    if (state.preference === 'system') setState({ preference: 'system', resolved: resolve('system') });
  };
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', handleSystemChange);
  } else {
    // Safari viejo: sin addEventListener en MediaQueryList.
    media.addListener(handleSystemChange);
  }
}

// Alinea el DOM con el estado inicial (por si el script en línea de index.html no corrió,
// por ejemplo en pruebas o previews sin ese HTML).
applyToDocument(state.resolved);

function getSnapshot(): ThemeState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Cambia y persiste la preferencia de tema ("system" | "light" | "dark"). */
export function setThemePreference(preference: ThemePreference): void {
  try {
    storage()?.setItem(STORAGE_KEY, preference);
  } catch {
    // Sin almacenamiento disponible: el cambio vive solo en esta pestaña.
  }
  setState({ preference, resolved: resolve(preference) });
}

/** Alterna entre claro y oscuro como elección explícita (botón rápido del riel). */
export function toggleTheme(): void {
  setThemePreference(state.resolved === 'dark' ? 'light' : 'dark');
}

/** Hook reactivo: re-renderiza el componente cuando cambia el tema (elegido o del sistema). */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
