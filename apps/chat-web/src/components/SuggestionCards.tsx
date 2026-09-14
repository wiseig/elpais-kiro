import type { SuggestionCard } from '@pelp/domain/api';
import { formatDate, sectionLabel } from '../lib/format';
import type { ApiClient } from '../lib/api';
import { SourceThumb } from './SourcePreview';

interface Props {
  cards: SuggestionCard[];
  items: string[];
  api: ApiClient;
  onSend: (question: string) => void;
}

const MAX_CARDS = 4;

/** Línea "Sección · fecha" (o "Tendencia"/"Nota reciente" sin fuente) para una tarjeta de sugerencia. */
function captionFor(card: SuggestionCard): string {
  if (!card.source) return card.kind === 'trending' ? 'Tendencia' : 'Nota reciente';
  return [sectionLabel(card.source.section), formatDate(card.source.date)].filter(Boolean).join(' · ');
}

/**
 * Fila de hasta 4 tarjetas de sugerencia de la portada: arriba la pregunta y su "Sección ·
 * fecha", abajo la imagen de la nota que la respalda (o un degradé con la sección si no hay).
 */
export function SuggestionCards({ cards, items, api, onSend }: Props) {
  if (cards.length > 0) {
    return (
      <div className="suggestion-grid">
        {cards.slice(0, MAX_CARDS).map((card, index) => (
          <button
            type="button"
            key={`${card.question}-${index}`}
            className="suggestion-card"
            onClick={() => onSend(card.question)}
          >
            <span className="suggestion-top">
              <span className="suggestion-question">{card.question}</span>
              <span className="suggestion-caption">{captionFor(card)}</span>
            </span>
            {card.source ? (
              <SourceThumb item={card.source} api={api} className="suggestion-thumb" />
            ) : (
              <span className="source-thumb suggestion-thumb">
                <span className="source-thumb-placeholder">
                  <span className="source-thumb-placeholder-label">
                    {card.kind === 'trending' ? 'Tendencia' : 'El País'}
                  </span>
                </span>
              </span>
            )}
          </button>
        ))}
      </div>
    );
  }

  if (items.length > 0) {
    return (
      <div className="suggestion-grid">
        {items.slice(0, MAX_CARDS).map((question) => (
          <button
            type="button"
            key={question}
            className="suggestion-card suggestion-card--text"
            onClick={() => onSend(question)}
          >
            <span className="suggestion-top">
              <span className="suggestion-question">{question}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  return null;
}
