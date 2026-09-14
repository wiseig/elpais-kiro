import { GetTopicAttributesCommand, ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import type { MailingList, MailingListsResponse } from '@pelp/domain/api';
import { HttpError, audit, type AdminContext } from '../context';

/** Las dos listas de correo del producto. La clave es la que usa el front en la URL. */
const LISTS: { key: string; label: string; description: string; envVar: string }[] = [
  {
    key: 'redaccion',
    label: 'Redacción',
    description: 'Reciben el resumen de preguntas frecuentes y huecos editoriales que se manda desde Tendencias.',
    envVar: 'NEWSROOM_TOPIC_ARN',
  },
  {
    key: 'alarmas',
    label: 'Alarmas',
    description: 'Reciben los avisos automáticos: errores del motor, presupuesto pasado, fallas de sincronización.',
    envVar: 'ALERTS_TOPIC_ARN',
  },
];

function topicArn(ctx: AdminContext, key: string): { arn: string; label: string } {
  const entry = LISTS.find((item) => item.key === key);
  if (!entry) throw new HttpError(404, 'Esa lista no existe.', 'not_found');
  const arn = ctx.env[entry.envVar];
  if (!arn) throw new HttpError(501, `La lista «${entry.label}» no tiene destino configurado (${entry.envVar}).`, 'not_configured');
  return { arn, label: entry.label };
}

async function readList(ctx: AdminContext, entry: (typeof LISTS)[number]): Promise<MailingList> {
  const arn = ctx.env[entry.envVar] ?? '';
  const base: MailingList = { key: entry.key, label: entry.label, description: entry.description, topicArn: arn, subscriptions: [] };
  if (!arn) return base;
  const subscriptions: MailingList['subscriptions'] = [];
  let token: string | undefined;
  do {
    const page = await ctx.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, ...(token ? { NextToken: token } : {}) }));
    for (const item of page.Subscriptions ?? []) {
      if (item.Protocol !== 'email' && item.Protocol !== 'email-json') continue;
      // Mientras no confirman, SNS devuelve «PendingConfirmation» en vez de un ARN.
      const pending = !item.SubscriptionArn || !item.SubscriptionArn.startsWith('arn:');
      subscriptions.push({ email: item.Endpoint ?? '', confirmed: !pending, ...(pending ? {} : { subscriptionArn: item.SubscriptionArn ?? '' }) });
    }
    token = page.NextToken;
  } while (token && subscriptions.length < 200);
  subscriptions.sort((a, b) => a.email.localeCompare(b.email, 'es'));
  return { ...base, subscriptions };
}

export async function mailingLists(ctx: AdminContext): Promise<MailingListsResponse> {
  const lists = await Promise.all(LISTS.map((entry) => readList(ctx, entry)));
  return { lists };
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Poné una dirección de correo válida.', 'invalid_email');
  return email;
}

/** Alta: SNS le manda un pedido de confirmación y la dirección queda pendiente hasta que acepta. */
export async function subscribe(ctx: AdminContext, key: string, body: { email?: unknown }): Promise<MailingListsResponse> {
  const { arn, label } = topicArn(ctx, key);
  const email = normalizeEmail(body.email);
  const current = await ctx.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn }));
  if ((current.Subscriptions ?? []).some((item) => item.Endpoint?.toLowerCase() === email)) {
    throw new HttpError(409, `${email} ya está en la lista de ${label.toLocaleLowerCase('es')}.`, 'already_exists');
  }
  await ctx.sns.send(new SubscribeCommand({ TopicArn: arn, Protocol: 'email', Endpoint: email, ReturnSubscriptionArn: true }));
  await audit(ctx, 'mailing.subscribe', `${key}:${email}`);
  return mailingLists(ctx);
}

export async function unsubscribe(ctx: AdminContext, key: string, body: { subscriptionArn?: unknown; email?: unknown }): Promise<MailingListsResponse> {
  const { arn } = topicArn(ctx, key);
  const subscriptionArn = typeof body.subscriptionArn === 'string' ? body.subscriptionArn : '';
  if (!subscriptionArn.startsWith(arn)) throw new HttpError(400, 'Esa suscripción no pertenece a la lista.', 'bad_request');
  await ctx.sns.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
  await audit(ctx, 'mailing.unsubscribe', `${key}:${typeof body.email === 'string' ? body.email : subscriptionArn}`);
  return mailingLists(ctx);
}

/** Sirve para avisar en Tendencias a cuánta gente le va a llegar el envío. */
export async function newsroomCount(ctx: AdminContext): Promise<number> {
  const arn = ctx.env.NEWSROOM_TOPIC_ARN;
  if (!arn) return 0;
  const attributes = await ctx.sns.send(new GetTopicAttributesCommand({ TopicArn: arn })).catch(() => undefined);
  return Number(attributes?.Attributes?.SubscriptionsConfirmed ?? 0);
}
