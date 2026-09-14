import { useMemo, useState } from 'react';
import type { AuditRecord } from '@pelp/domain';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { csvFilename, downloadCsv, toCsv } from '../../shared/csv';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Field } from '../../shared/components/Field';
import { Table, type Column } from '../../shared/components/Table';
import { DaysSelector } from '../../shared/components/Tabs';
import { JsonDiff } from '../../shared/components/JsonDiff';
import { JsonView } from '../../shared/components/JsonView';
import { Empty } from '../../shared/components/Empty';
import { fmtDateTime, fmtInt, prettyJson } from '../../shared/format';

function AuditDetail({ row }: { row: AuditRecord }) {
  if (row.before !== undefined && row.after !== undefined) {
    return <JsonDiff before={prettyJson(row.before)} after={prettyJson(row.after)} beforeLabel="Antes" afterLabel="Después" />;
  }
  if (row.after !== undefined) {
    return (
      <>
        <h4 className="h4">Después</h4>
        <JsonView value={row.after} />
      </>
    );
  }
  if (row.before !== undefined) {
    return (
      <>
        <h4 className="h4">Antes</h4>
        <JsonView value={row.before} />
      </>
    );
  }
  return <Empty text="Sin detalle adicional para esta acción." />;
}

const COLUMNS: Column<AuditRecord>[] = [
  { key: 'at', header: 'Fecha', nowrap: true, render: (row) => fmtDateTime(row.at) },
  { key: 'actor', header: 'Quién', render: (row) => row.actor },
  { key: 'action', header: 'Acción', render: (row) => <code>{row.action}</code> },
  { key: 'target', header: 'Objetivo', render: (row) => row.target || <span className="muted">—</span> },
  { key: 'reason', header: 'Motivo', render: (row) => row.reason || <span className="muted">—</span> },
];

export default function AuditoriaPage() {
  const api = useApi();
  const [days, setDays] = useState(7);
  const list = useAsync(() => api.audit(days, 500), [api, days]);
  const [q, setQ] = useState('');

  const items = useMemo(() => {
    const sorted = list.data ? [...list.data.items].sort((a, b) => b.at.localeCompare(a.at)) : [];
    const needle = q.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter(
      (row) =>
        row.actor.toLowerCase().includes(needle) ||
        row.action.toLowerCase().includes(needle) ||
        (row.target ?? '').toLowerCase().includes(needle) ||
        (row.reason ?? '').toLowerCase().includes(needle),
    );
  }, [list.data, q]);

  const exportCsv = () => {
    const rows = items.map((row) => [row.at, row.actor, row.action, row.target ?? '', row.reason ?? '', prettyJson(row.before), prettyJson(row.after)]);
    downloadCsv(csvFilename(`auditoria-${days}d`), toCsv(['fecha', 'quien', 'accion', 'objetivo', 'motivo', 'antes', 'despues'], rows));
  };

  return (
    <div className="page">
      <PageHeader
        title="Auditoría"
        description="Toda acción de administración: quién, qué, cuándo y el antes/después."
        onRefresh={list.reload}
        refreshing={list.loading}
        actions={
          <>
            <DaysSelector value={days} onChange={setDays} options={[1, 7, 30, 90]} />
            <button type="button" className="btn" onClick={exportCsv} disabled={items.length === 0}>
              Exportar CSV
            </button>
          </>
        }
      />

      <Card title="Filtros">
        <div className="filters">
          <Field label="Texto" className="filters__wide" hint="Filtra por quién, acción, objetivo o motivo.">
            <input className="input" type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Buscar…" />
          </Field>
        </div>
      </Card>

      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Spinner />}

      <Card title={`Acciones (${fmtInt(items.length)})`}>
        {list.data && (
          <Table
            columns={COLUMNS}
            rows={items}
            rowKey={(row) => row.id}
            expandable={(row) => <AuditDetail row={row} />}
            emptyText="Sin acciones registradas en el período."
            dense
            maxHeight="65vh"
          />
        )}
      </Card>
    </div>
  );
}
