import { useEffect, useState } from 'react';
import type { ChannelEntry } from '@pelp/domain';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import type { ChannelTestResponse } from '../../shared/api';
import { PageHeader } from '../../shared/components/PageHeader';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Spinner } from '../../shared/components/Spinner';
import { Card } from '../../shared/components/Card';
import { Table, type Column } from '../../shared/components/Table';
import { Toggle } from '../../shared/components/Field';
import { Chip } from '../../shared/components/Chip';
import { Notice, useNotice } from '../../shared/components/Notice';
import { fmtDateTime, truncate } from '../../shared/format';

export default function CanalesPage() {
  const api = useApi();
  const channels = useAsync(() => api.channels(), [api]);
  const notice = useNotice();
  const [rows, setRows] = useState<ChannelEntry[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ChannelTestResponse>>({});

  useEffect(() => {
    if (channels.data) setRows(channels.data.items);
  }, [channels.data]);

  const dirty = rows !== null && channels.data !== undefined && JSON.stringify(rows) !== JSON.stringify(channels.data.items);

  const updateRow = (id: string, patch: Partial<ChannelEntry>) =>
    setRows((current) => current && current.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const updateLimits = (id: string, patch: Partial<ChannelEntry['limits']>) =>
    setRows((current) => current && current.map((row) => (row.id === id ? { ...row, limits: { ...row.limits, ...patch } } : row)));

  const save = async () => {
    if (!rows) return;
    setSaving(true);
    try {
      const response = await api.putChannels(rows);
      channels.setData(response);
      notice.show('success', 'Canales guardados.');
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    try {
      const result = await api.testChannel(id);
      setResults((current) => ({ ...current, [id]: result }));
    } catch (error) {
      setResults((current) => ({ ...current, [id]: { ok: false, detail: errorMessage(error) } }));
    } finally {
      setTesting(null);
    }
  };

  const columns: Column<ChannelEntry>[] = [
    { key: 'id', header: 'Canal', render: (row) => <strong>{row.id}</strong> },
    {
      key: 'enabled',
      header: 'Habilitado',
      align: 'center',
      render: (row) => <Toggle checked={row.enabled} onChange={(next) => updateRow(row.id, { enabled: next })} label={<span className="sr-only">Habilitado</span>} />,
    },
    {
      key: 'webhook',
      header: 'Webhook URL',
      render: (row) => (
        <input
          className="input"
          value={row.webhookUrl ?? ''}
          onChange={(event) => updateRow(row.id, { webhookUrl: event.target.value || undefined })}
          placeholder="https://…"
        />
      ),
    },
    {
      key: 'secret',
      header: 'Secreto',
      render: (row) => (row.secretArn ? <code title={row.secretArn}>{truncate(row.secretArn, 34)}</code> : <span className="muted">sin configurar</span>),
    },
    {
      key: 'perUser',
      header: 'Límite / hora',
      align: 'right',
      render: (row) => (
        <input
          className="input input--number"
          type="number"
          min={1}
          value={row.limits.perUserPerHour}
          onChange={(event) => updateLimits(row.id, { perUserPerHour: Number(event.target.value) })}
        />
      ),
    },
    {
      key: 'maxChars',
      header: 'Máx. caracteres',
      align: 'right',
      render: (row) => (
        <input
          className="input input--number"
          type="number"
          min={1}
          value={row.limits.maxMessageChars}
          onChange={(event) => updateLimits(row.id, { maxMessageChars: Number(event.target.value) })}
        />
      ),
    },
    { key: 'lastMessageAt', header: 'Último mensaje', nowrap: true, render: (row) => fmtDateTime(row.lastMessageAt) },
    {
      key: 'notes',
      header: 'Notas',
      render: (row) => <input className="input" value={row.notes ?? ''} onChange={(event) => updateRow(row.id, { notes: event.target.value || undefined })} />,
    },
    {
      key: 'test',
      header: '',
      render: (row) => {
        const result = results[row.id];
        return (
          <div className="btn-row">
            <button type="button" className="btn btn--small" onClick={() => void test(row.id)} disabled={testing === row.id}>
              {testing === row.id ? 'Probando…' : 'Enviar mensaje de prueba'}
            </button>
            {result && (
              <Chip tone={result.ok ? 'success' : 'danger'} title={result.detail}>
                {result.ok ? 'ok' : 'error'}
              </Chip>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Canales"
        description="Adaptadores registrados: habilitación, webhook, referencia al secreto (nunca el valor) y límites por lector."
        onRefresh={channels.reload}
        refreshing={channels.loading}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        }
      />
      <Notice notice={notice.notice} onClose={notice.clear} />
      {channels.error && <ErrorBox error={channels.error} onRetry={channels.reload} />}
      {channels.loading && !rows && <Spinner />}
      {rows && (
        <Card
          title={
            dirty ? (
              <>
                Canales <Chip tone="warning">cambios sin guardar</Chip>
              </>
            ) : (
              'Canales'
            )
          }
        >
          <Table columns={columns} rows={rows} rowKey={(row) => row.id} emptyText="Sin canales configurados." />
        </Card>
      )}
    </div>
  );
}
