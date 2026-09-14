import type { SuggestionCard } from '@pelp/domain/api';
import type { ApiClient } from '../lib/api';
import { RotatingPrompt } from './RotatingPrompt';
import { SuggestionCards } from './SuggestionCards';

interface Props {
  cards: SuggestionCard[];
  items: string[];
  api: ApiClient;
  onSend: (question: string) => void;
}

/** Portada estilo Gemini: saludo con gradiente, línea rotativa de ejemplos y sugerencias del día. */
export function Home({ cards, items, api, onSend }: Props) {
  const hasSuggestions = cards.length > 0 || items.length > 0;
  return (
    <section className="home">
      <h1 className="home-hero">Hola.</h1>
      <RotatingPrompt items={items} onSend={onSend} />
      {hasSuggestions ? (
        <div className="home-suggestions">
          <p className="suggestions-label">Sugerencias de hoy</p>
          <SuggestionCards cards={cards} items={items} api={api} onSend={onSend} />
        </div>
      ) : null}
    </section>
  );
}
