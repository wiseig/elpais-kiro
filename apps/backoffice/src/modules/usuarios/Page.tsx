import { useState, type FormEvent } from 'react';
import type { AdminUser } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { fmtDateTime } from '../../shared/format';
import { Card } from '../../shared/components/Card';
import { Chip } from '../../shared/components/Chip';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Field } from '../../shared/components/Field';
import { Notice, useNotice } from '../../shared/components/Notice';
import { PageHeader } from '../../shared/components/PageHeader';
import { Spinner } from '../../shared/components/Spinner';
import { Table, type Column } from '../../shared/components/Table';

const STATUS: Record<AdminUser['status'], { label: string; tone: 'success' | 'warning' | 'danger' | undefined; hint: string }> = {
  activo: { label: 'activo', tone: 'success', hint: 'Entra con su contraseña.' },
  invitado: { label: 'invitado', tone: 'warning', hint: 'Le llegó la invitación y todavía no entró por primera vez.' },
  debe_resetear: { label: 'debe resetear', tone: 'warning', hint: 'Tiene que elegir una contraseña nueva con el código que le llegó por mail.' },
  sin_confirmar: { label: 'sin confirmar', tone: 'warning', hint: 'La cuenta existe pero no se verificó el correo.' },
  otro: { label: 'otro', tone: undefined, hint: '' },
};

export default function UsuariosPage() {
  const api = useApi();
  const list = useAsync(() => api.users(), [api]);
  const notice = useNotice();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AdminUser | null>(null);

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await action();
      notice.show('success', success);
      list.reload();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    const target = email.trim();
    if (!target) return;
    await run('new', () => api.createUser(target), `Se le mandó la invitación a ${target}. Le llega una contraseña temporal por mail.`);
    setEmail('');
  };

  const actor = list.data?.actor ?? '';
  const adminGroup = list.data?.adminGroup ?? 'admin';

  const columns: Column<AdminUser>[] = [
    {
      key: 'email',
      header: 'Cuenta',
      render: (row) => (
        <span className="cell-text">
          <strong>{row.email}</strong>
          {row.email.toLowerCase() === actor.toLowerCase() && <Chip tone="primary">vos</Chip>}
          {!row.groups.includes(adminGroup) && <Chip tone="danger">sin el grupo {adminGroup}</Chip>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Estado',
      render: (row) => (
        <span className="cell-text">
          {row.enabled ? <Chip tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Chip> : <Chip tone="danger">deshabilitada</Chip>}
          {STATUS[row.status].hint && <span className="muted small">{STATUS[row.status].hint}</span>}
        </span>
      ),
    },
    { key: 'created', header: 'Alta', nowrap: true, render: (row) => (row.createdAt ? fmtDateTime(row.createdAt) : <span className="muted">—</span>) },
    {
      key: 'actions',
      header: 'Acciones',
      align: 'right',
      render: (row) => {
        const self = row.email.toLowerCase() === actor.toLowerCase();
        return (
          <div className="btn-row btn-row--end">
            {row.status === 'invitado' ? (
              <button
                type="button"
                className="btn btn--small"
                disabled={busy === row.username}
                onClick={() => void run(row.username, () => api.resendInvite(row.username), `Se reenvió la invitación a ${row.email}.`)}
              >
                Reenviar invitación
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--small"
                disabled={busy === row.username}
                onClick={() =>
                  void run(row.username, () => api.resetUserPassword(row.username), `A ${row.email} le llega un código para elegir contraseña nueva.`)
                }
              >
                Resetear contraseña
              </button>
            )}
            <button
              type="button"
              className={row.enabled ? 'btn btn--small btn--danger-outline' : 'btn btn--small'}
              disabled={busy === row.username || (self && row.enabled)}
              title={self && row.enabled ? 'No podés deshabilitar tu propia cuenta.' : undefined}
              onClick={() =>
                void run(
                  row.username,
                  () => api.setUserEnabled(row.username, !row.enabled),
                  row.enabled ? `${row.email} ya no puede entrar.` : `${row.email} vuelve a tener acceso.`,
                )
              }
            >
              {row.enabled ? 'Deshabilitar' : 'Habilitar'}
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger-outline"
              disabled={busy === row.username || self}
              title={self ? 'No podés borrar tu propia cuenta.' : undefined}
              onClick={() => setRemoving(row)}
            >
              Borrar
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Usuarios"
        description="Quién puede entrar al backoffice. Las cuentas viven en el pool de Cognito de Preguntale a El País, separado del de Daily Brief."
        onRefresh={list.reload}
        refreshing={list.loading}
      />
      <Notice notice={notice.notice} onClose={notice.clear} />

      <Card
        title="Invitar a alguien"
        description={`Se crea la cuenta en el grupo ${adminGroup} y Cognito le manda una contraseña temporal por mail. La primera vez que entre le va a pedir una nueva.`}
      >
        <form className="filters" onSubmit={(event) => void invite(event)}>
          <Field label="Correo" className="filters__wide">
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="nombre@elpais.com.uy"
              autoComplete="off"
            />
          </Field>
          <button type="submit" className="btn btn--primary" disabled={busy === 'new' || !email.trim()}>
            {busy === 'new' ? 'Invitando…' : 'Invitar'}
          </button>
        </form>
      </Card>

      <Card title="Cuentas">
        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.loading && !list.data && <Spinner />}
        {list.data && <Table columns={columns} rows={list.data.items} rowKey={(row) => row.username} emptyText="Todavía no hay cuentas." />}
      </Card>

      {removing && (
        <ConfirmDialog
          open
          danger
          title={`Borrar a ${removing.email}`}
          message={
            <p>
              La cuenta se borra del pool y pierde el acceso enseguida. Si es algo temporal, conviene deshabilitarla en vez de borrarla.
            </p>
          }
          confirmLabel="Borrar"
          reason="required"
          busy={busy === removing.username}
          onCancel={() => setRemoving(null)}
          onConfirm={(reason) => {
            const target = removing;
            setRemoving(null);
            void run(target.username, () => api.deleteUser(target.username, reason), `Se borró la cuenta de ${target.email}.`);
          }}
        />
      )}
    </div>
  );
}
