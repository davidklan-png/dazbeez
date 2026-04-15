import type { Env } from '../_lib/env';
import { isAuthorizedAdmin, unauthorizedAdminResponse } from '../_lib/admin';
import { listCardMetrics, listContactEvents, listContacts } from '../_lib/db';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (!isAuthorizedAdmin(context.request, context.env)) {
    return unauthorizedAdminResponse();
  }

  const url = new URL(context.request.url);
  const token = url.searchParams.get('token');

  const [contacts, metrics, events] = await Promise.all([
    listContacts(context.env.DB, token),
    listCardMetrics(context.env.DB, token),
    listContactEvents(context.env.DB, token),
  ]);

  return Response.json({
    token: token ?? null,
    metrics: metrics.map((metric) => ({
      ...metric,
      conversion_rate: metric.tap_count > 0
        ? Number((metric.contact_count / metric.tap_count).toFixed(3))
        : 0,
    })),
    contacts,
    events,
  });
};
