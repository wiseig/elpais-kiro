/**
 * Renderizador mínimo y seguro de markdown "liviano": construye nodos React (nunca HTML crudo).
 * Soporta: párrafos separados por línea en blanco, **negrita**, listas simples, encabezados `#`
 * y tablas con `|`. Alcanza para el texto de consentimiento y los Términos (Apéndice A).
 */
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface InlineOptions {
  /** Frases que se convierten en enlaces; las rutas internas (empiezan con "/") navegan en la SPA. */
  links?: Record<string, string>;
}

const BOLD = /\*\*(.+?)\*\*/g;
const BULLET = /^[-*•]\s+/;
const ORDERED = /^\d+[.)]\s+/;
const HEADING = /^(#{1,3})\s+(.+)$/;

function renderLink(to: string, label: string, key: string): ReactNode {
  if (to.startsWith('/')) {
    return (
      <Link key={key} to={to}>
        {label}
      </Link>
    );
  }
  return (
    <a key={key} href={to} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function linkify(segment: string, options: InlineOptions, keyPrefix: string): ReactNode[] {
  const links = options.links;
  if (!links || segment.length === 0) return [segment];
  const entries = Object.entries(links);
  const out: ReactNode[] = [];
  let rest = segment;
  let index = 0;
  while (rest.length > 0) {
    let best: { phrase: string; to: string; at: number } | null = null;
    for (const [phrase, to] of entries) {
      const at = rest.indexOf(phrase);
      if (at !== -1 && (best === null || at < best.at)) best = { phrase, to, at };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.at > 0) out.push(rest.slice(0, best.at));
    out.push(renderLink(best.to, best.phrase, `${keyPrefix}-l${index}`));
    index += 1;
    rest = rest.slice(best.at + best.phrase.length);
  }
  return out;
}

/** Texto de una línea con **negritas** y enlaces opcionales. */
export function renderInline(text: string, options: InlineOptions = {}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(BOLD)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(...linkify(text.slice(last, start), options, `t${index}`));
    nodes.push(
      <strong key={`b${index}`}>{linkify(match[1] ?? '', options, `bi${index}`)}</strong>,
    );
    last = start + match[0].length;
    index += 1;
  }
  if (last < text.length) nodes.push(...linkify(text.slice(last), options, `t${index}`));
  return nodes;
}

/** Divide en bloques separados por líneas en blanco. */
export function splitBlocks(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function renderTextBlock(block: string, key: number, options: InlineOptions): ReactNode {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 1 && lines.every((line) => BULLET.test(line))) {
    return (
      <ul key={key}>
        {lines.map((line, i) => (
          <li key={i}>{renderInline(line.replace(BULLET, ''), options)}</li>
        ))}
      </ul>
    );
  }
  if (lines.length > 1 && lines.every((line) => ORDERED.test(line))) {
    return (
      <ol key={key}>
        {lines.map((line, i) => (
          <li key={i}>{renderInline(line.replace(ORDERED, ''), options)}</li>
        ))}
      </ol>
    );
  }
  return (
    <p key={key}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? <br /> : null}
          {renderInline(line, options)}
        </Fragment>
      ))}
    </p>
  );
}

/** Párrafos (y listas) con negritas. Usado para el texto de consentimiento y las respuestas. */
export function renderParagraphs(text: string, options: InlineOptions = {}): ReactNode[] {
  return splitBlocks(text).map((block, i) => renderTextBlock(block, i, options));
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-*:?$/.test(cell)) && cells.some((cell) => cell.includes('-'));
}

function renderTable(lines: string[], key: number): ReactNode {
  const rows = lines.map(splitRow).filter((cells) => !isSeparatorRow(cells));
  const [head, ...body] = rows;
  if (!head) return null;
  return (
    <div className="table-wrap" key={key}>
      <table>
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th key={i} scope="col">
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((cells, r) => (
            <tr key={r}>
              {cells.map((cell, c) =>
                c === 0 ? (
                  <th key={c} scope="row">
                    {renderInline(cell)}
                  </th>
                ) : (
                  <td key={c}>{renderInline(cell)}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Documento completo: encabezados `#`, tablas, párrafos y listas. */
export function renderDocument(text: string, options: InlineOptions = {}): ReactNode[] {
  return splitBlocks(text).map((block, i) => {
    const lines = block.split('\n').map((line) => line.trim());
    if (lines.length === 1) {
      const heading = HEADING.exec(block);
      if (heading) {
        const level = heading[1]?.length ?? 1;
        const content = renderInline(heading[2] ?? '', options);
        if (level === 1) return <h1 key={i}>{content}</h1>;
        if (level === 2) return <h2 key={i}>{content}</h2>;
        return <h3 key={i}>{content}</h3>;
      }
    }
    if (lines.every((line) => line.startsWith('|'))) return renderTable(lines, i);
    return renderTextBlock(block, i, options);
  });
}

/** Si el primer bloque es una línea entera en negrita, la separa como título. */
export function extractLeadingTitle(text: string): { title: string | null; body: string } {
  const blocks = splitBlocks(text);
  const first = blocks[0];
  const match = first ? /^\*\*([^*]+)\*\*$/.exec(first) : null;
  if (match && match[1]) {
    return { title: match[1].trim(), body: blocks.slice(1).join('\n\n') };
  }
  return { title: null, body: text };
}
