import { useState, type FormEvent } from 'react';
import type { MailingList, MailingSubscription } from '@pelp/domain/api';
import { useApi } from '../../shared/ApiContext';
import { useAsync } from '../../shared/useAsync';
import { errorMessage } from '../../shared/errors';
import { Card } from '../../shared/components/Card';
import { Chip } from '../../shared/components/Chip';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { Empty } from '../../shared/components/Empty';
import { ErrorBox } from '../../shared/components/ErrorBox';
import { Field } from '../../shared/components/Field';
import { Notice, useNotice } from '../../shared/components/Notice';
import { PageHeader } from '../../shared/components/PageHeader';
import { Spinner } from '../../shared/components/Spinner';
import { Table, type Column } from '../../shared/components/Table';

interface ListCardProps {
  list: MailingList;
  busy: string | null;
  onAdd: (key: string, email: string) => Promise<void>;
  onRemove: (list: MailingList, subscription: MailingSubscription) => void;
}

function ListCard({ list, busy, onAdd, onRemove }: ListCardProps) {
  const [email, setEmail] = useState('');
  const confirmed = list.subscriptions.filter((item) => item.confirmed).length;
  const pending = list.subscriptions.length - confirmed;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const target = email.trim();
    if (!target) return;
    await onAdd(list.key, target);
    setEmail('');
  };

  const columns: Column<MailingSubscription>[] = [
    { key: 'email', header: 'Correo', render: (row) => row.email },
    {
      key: 'state',
      header: 'Estado',
      render: (row) =>
        row.confirmed ? (
          <Chip tone="success">recibe</Chip>
        ) : (
          <span className="cell-text">
            <Chip tone="warning">sin confirmar</Chip>
            <span className="muted small">Le llegó un mail de AWS y tiene que apretar «Confirm subscription».</span>
          </span>
        ),
    },
    {
      key: 'actions',
      header: 'Acciones',
      align: 'right',
      render: (row) =>
        row.subscriptionArn ? (
          <button type="button" className="btn btn--small btn--danger-outline" disabled={busy === list.key} onClick={() => onRemove(list, row)}>
            Sacar
          </button>
        ) : (
          <span className="muted small">Se puede sacar recién cuando confirme</span>
        ),
    },
  ];

  return (
    <Card
      title={
        <>
          {list.label}{' '}
          {confirmed === 0 ? <Chip tone="danger">nadie recibe</Chip> : <Chip tone="success">{confirmed} reciben</Chip>}
          {pending > 0 && <Chip tone="warning">{pending} sin confirmar</Chip>}
        </>
      }
      description={list.description}
    >
      {!list.topicArn ? (
        <Empty text="Esta lista no tiene destino configurado en la infraestructura." />
      ) : (
        <>
          <Table columns={columns} rows={list.subscriptions} rowKey={(row) => row.subscriptionArn ?? row.email} emptyText="Nadie en la lista." dense />
          <form className="filters" onSubmit={(event) => void submit(event)}>
            <Field label="Agregar correo" className="filters__wide">
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="nombre@elpais.com.uy"
                autoComplete="off"
              />
            </Field>
            <button type="submit" className="btn btn--primary" disabled={busy === list.key || !email.trim()}>
              {busy === list.key ? 'Agregando…' : 'Agregar'}
            </button>
          </form>
        </>
      )}
    </Card>
  );
}

export default function NotificacionesPage() {
  const api = useApi();
  const lists = useAsync(() => api.mailingLists(), [api]);
  const notice = useNotice();
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ list: MailingList; subscription: MailingSubscription } | null>(null);

  const add = async (key: string, email: string) => {
    setBusy(key);
    try {
      await api.subscribeToList(key, email);
      notice.show('success', `AWS le mandó a ${email} un pedido de confirmación. Hasta que lo acepte no recibe nada.`);
      lists.reload();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (list: MailingList, subscription: MailingSubscription) => {
    setBusy(list.key);
    try {
      await api.unsubscribeFromList(list.key, subscription.subscriptionArn ?? '', subscription.email);
      notice.show('success', `${subscription.email} ya no recibe ${list.label.toLocaleLowerCase('es')}.`);
      lists.reload();
    } catch (error) {
      notice.show('error', errorMessage(error));
    } finally {
      setBusy(null);
      setRemoving(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Listas de correo"
        description="A quién le llega cada envío del producto. Antes esto vivía solo en la infraestructura y no había forma de verlo."
        onRefresh={lists.reload}
        refreshing={lists.loading}
      />
      <Notice notice={notice.notice} onClose={notice.clear} />

      {lists.error && <ErrorBox error={lists.error} onRetry={lists.reload} />}
      {lists.loading && !lists.data && <Spinner />}
      {lists.data?.lists.map((list) => (
        <ListCard key={list.key} list={list} busy={busy} onAdd={add} onRemove={(target, subscription) => setRemoving({ list: target, subscription })} />
      ))}

      {removing && (
        <ConfirmDialog
          open
          danger
          title={`Sacar a ${removing.subscription.email}`}
          message={<p>Deja de recibir los envíos de {removing.list.label.toLocaleLowerCase('es')}. Se puede volver a agregar cuando quieras.</p>}
          confirmLabel="Sacar"
          busy={busy === removing.list.key}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing.list, removing.subscription)}
        />
      )}
    </div>
  );
}
