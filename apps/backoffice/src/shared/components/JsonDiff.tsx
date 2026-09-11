import { useMemo, useState } from 'react';
import { diffLines, diffSummary, type DiffOp } from '../diff';
import { cx } from '../cx';

interface JsonDiffProps {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  /** Líneas de contexto alrededor de cada cambio antes de colapsar. */
  context?: number;
}

type Row = { kind: 'op'; op: DiffOp; index: number } | { kind: 'fold'; count: number; index: number };

function foldRows(ops: DiffOp[], context: number, expanded: boolean): Row[] {
  if (expanded) return ops.map((op, index) => ({ kind: 'op', op, index }));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) keep[k] = true;
  });
  const rows: Row[] = [];
  let hidden = 0;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (hidden > 0) {
        rows.push({ kind: 'fold', count: hidden, index });
        hidden = 0;
      }
      rows.push({ kind: 'op', op, index });
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) rows.push({ kind: 'fold', count: hidden, index: ops.length });
  return rows;
}

/** Diff línea a línea entre dos textos (JSON ya formateado). */
export function JsonDiff({ before, after, beforeLabel = 'Actual', afterLabel = 'Editado', context = 3 }: JsonDiffProps) {
  const [expanded, setExpanded] = useState(false);
  const ops = useMemo(() => diffLines(before, after), [before, after]);
  const summary = useMemo(() => diffSummary(ops), [ops]);
  const rows = useMemo(() => foldRows(ops, context, expanded), [ops, context, expanded]);

  if (summary.added === 0 && summary.removed === 0) {
    return <p className="muted">Sin diferencias entre {beforeLabel.toLowerCase()} y {afterLabel.toLowerCase()}.</p>;
  }

  return (
    <div className="diff">
      <div className="diff__summary">
        <span>
          {beforeLabel} → {afterLabel}
        </span>
        <span className="diff__count diff__count--add">+{summary.added}</span>
        <span className="diff__count diff__count--del">−{summary.removed}</span>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Ocultar contexto' : 'Ver todo'}
        </button>
      </div>
      <pre className="diff__body">
        {rows.map((row) =>
          row.kind === 'fold' ? (
            <span key={`fold-${row.index}`} className="diff__line diff__line--fold">
              … {row.count} {row.count === 1 ? 'línea sin cambios' : 'líneas sin cambios'}
            </span>
          ) : (
            <span key={row.index} className={cx('diff__line', `diff__line--${row.op.type}`)}>
              <span className="diff__sign" aria-hidden="true">
                {row.op.type === 'add' ? '+' : row.op.type === 'del' ? '−' : ' '}
              </span>
              {row.op.text || ' '}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
