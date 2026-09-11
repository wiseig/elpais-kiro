import { Fragment, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../cx';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  nowrap?: boolean;
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  /** Contenido que se despliega debajo de la fila al hacer clic. */
  expandable?: (row: T) => ReactNode;
  emptyText?: string;
  maxHeight?: number | string;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
  caption?: string;
}

const INTERACTIVE = 'button, a, input, select, textarea, label, summary';

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  expandable,
  emptyText = 'Sin resultados.',
  maxHeight,
  dense,
  rowClassName,
  caption,
}: TableProps<T>) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const clickable = Boolean(onRowClick || expandable);

  const activate = (row: T, key: string) => {
    if (expandable) setExpanded((current) => (current === key ? null : key));
    onRowClick?.(row);
  };

  const handleClick = (event: MouseEvent<HTMLTableRowElement>, row: T, key: string) => {
    if (!clickable) return;
    const target = event.target;
    if (target instanceof Element && target.closest(INTERACTIVE)) return;
    activate(row, key);
  };

  const handleKey = (event: KeyboardEvent<HTMLTableRowElement>, row: T, key: string) => {
    if (!clickable || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(row, key);
    }
  };

  const wrapStyle: CSSProperties | undefined = maxHeight !== undefined ? { maxHeight } : undefined;

  return (
    <div className="table-wrap" style={wrapStyle}>
      <table className={cx('table', dense && 'table--dense', clickable && 'table--clickable')}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={{ width: column.width, textAlign: column.align }} className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="table__empty">
                {emptyText}
              </td>
            </tr>
          )}
          {rows.map((row, index) => {
            const key = rowKey(row, index);
            const isOpen = expandable !== undefined && expanded === key;
            return (
              <Fragment key={key}>
                <tr
                  className={cx(rowClassName?.(row), isOpen && 'table__row--open')}
                  onClick={(event) => handleClick(event, row, key)}
                  onKeyDown={(event) => handleKey(event, row, key)}
                  tabIndex={clickable ? 0 : undefined}
                  aria-expanded={expandable ? isOpen : undefined}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      style={{ textAlign: column.align }}
                      className={cx(column.nowrap && 'nowrap', column.className)}
                    >
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
                {isOpen && expandable && (
                  <tr className="table__expanded">
                    <td colSpan={columns.length}>{expandable(row)}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
