import { useEffect, useState } from 'react';
import type { SourceItem } from '@pelp/domain';
import { formatDate, sectionLabel, toIsoDate } from '../lib/format';
import { speak, speechSupported, stopSpeaking, type SpeechState } from '../lib/speech';
import { useSourcePreview } from '../lib/preview';
import type { ApiClient } from '../lib/api';
import { ExternalIcon } from './Icons';

interface ThumbViewProps {
  imageUrl?: string;
  loading: boolean;
  section?: string;
  className?: string;
}

/**
 * Miniatura 16:9 de una nota: imagen con carga diferida, o un degradé suave con el nombre
 * de la sección mientras no hay imagen (ni la del corpus ni la de `/v1/preview`).
 */
export function SourceThumbView({ imageUrl, loading, section, className }: ThumbViewProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [imageUrl]);

  const showImage = Boolean(imageUrl) && !failed;
  const classes = ['source-thumb', className].filter(Boolean).join(' ');

  return (
    <span className={classes}>
      {showImage ? (
        <img
          className="source-thumb-img"
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="source-thumb-placeholder">
          <span className="source-thumb-placeholder-label">{section ? sectionLabel(section) : 'El País'}</span>
        </span>
      )}
      {loading && !showImage ? <span className="source-thumb-skeleton" aria-hidden="true" /> : null}
    </span>
  );
}

interface ThumbProps {
  item: SourceItem;
  api: ApiClient;
  className?: string;
}

/** `SourceThumbView` conectada al hook de previsualización: la usan las tarjetas de sugerencia. */
export function SourceThumb({ item, api, className }: ThumbProps) {
  const preview = useSourcePreview(api, item);
  return (
    <SourceThumbView imageUrl={preview.imageUrl} loading={preview.loading} section={item.section} className={className} />
  );
}

interface CardProps {
  item: SourceItem;
  api: ApiClient;
  onOpen: (url: string) => void;
}

/** Tarjeta de fuente de la tira "Fuentes": imagen, sección, título y bajada. */
export function SourcePreviewCard({ item, api, onOpen }: CardProps) {
  const preview = useSourcePreview(api, item);
  const date = formatDate(item.date);
  const iso = toIsoDate(item.date);
  const deck = item.deck ?? preview.deck;

  return (
    <li className="source-item">
      <a className="source-card" href={item.url} target="_blank" rel="noreferrer" onClick={() => onOpen(item.url)}>
        <SourceThumbView
          imageUrl={preview.imageUrl}
          loading={preview.loading}
          section={item.section}
          className="source-card-thumb"
        />
        <span className="source-card-body">
          <span className="source-card-top">
            {item.section ? <span className="source-chip">{sectionLabel(item.section)}</span> : null}
            <ExternalIcon className="source-card-ext" width={13} height={13} />
          </span>
          <span className="source-card-title">{item.title}</span>
          {date ? (
            <time className="source-card-date" dateTime={iso ?? undefined}>
              {date}
            </time>
          ) : null}
          {deck ? <span className="source-card-deck">{deck}</span> : null}
        </span>
      </a>
      <ListenButton item={item} api={api} />
    </li>
  );
}

/**
 * "Escuchar": lo dice la voz del navegador, así que no cuesta nada ni manda el texto a ningún
 * lado. Solo aparece si el navegador sabe hablar y si la fuente trae de qué nota viene: las
 * respuestas guardadas antes de esto no lo traen.
 */
function ListenButton({ item, api }: { item: SourceItem; api: ApiClient }) {
  const [state, setState] = useState<SpeechState>('idle');
  const puede = speechSupported();
  if (!item.articleId || !puede) return null;

  const detener = () => {
    stopSpeaking();
    setState('idle');
  };

  const escuchar = async () => {
    setState('loading');
    try {
      const script = await api.articleScript(item.articleId as string);
      setState('speaking');
      speak(script, { onEnd: () => setState('idle'), onError: () => setState('error') });
    } catch {
      setState('error');
    }
  };

  const hablando = state === 'speaking' || state === 'loading';
  return (
    <button
      type="button"
      className={hablando ? 'source-listen source-listen--active' : 'source-listen'}
      onClick={() => (hablando ? detener() : void escuchar())}
      aria-label={hablando ? `Dejar de escuchar ${item.title}` : `Escuchar ${item.title}`}
    >
      {state === 'loading' ? 'Preparando…' : state === 'speaking' ? 'Detener' : state === 'error' ? 'No se pudo leer' : 'Escuchar'}
    </button>
  );
}
