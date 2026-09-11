import type { SourceItem } from '@pelp/domain';
import { formatDate, toIsoDate } from '../lib/format';
import { ExternalIcon } from './Icons';

interface Props {
  item: SourceItem;
  onOpen: (url: string) => void;
}

/** Tarjeta de fuente: enlace a la nota original en una pestaña nueva. */
export function SourceCard({ item, onOpen }: Props) {
  const date = formatDate(item.date);
  const iso = toIsoDate(item.date);
  return (
    <li className="source-item">
      <a
        className="source-card"
        href={item.url}
        target="_blank"
        rel="noreferrer"
        onClick={() => onOpen(item.url)}
      >
        <span className="source-title">
          {item.title}
          <ExternalIcon className="source-ext" width={14} height={14} />
        </span>
        <span className="source-meta">
          {item.section ? <span className="source-section">{item.section}</span> : null}
          {date ? <time dateTime={iso ?? undefined}>{date}</time> : null}
        </span>
      </a>
    </li>
  );
}
