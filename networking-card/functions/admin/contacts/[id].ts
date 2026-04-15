import type { Env } from '../../_lib/env';
import { isAuthorizedAdmin, unauthorizedAdminResponse } from '../../_lib/admin';
import { deleteContactById, getContactById } from '../../_lib/db';

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  if (!isAuthorizedAdmin(context.request, context.env)) {
    return unauthorizedAdminResponse();
  }

  const raw = context.params.id;
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: 'Invalid contact id' }, { status: 400 });
  }

  const existing = await getContactById(context.env.DB, id);
  if (!existing) {
    return Response.json({ error: 'Contact not found' }, { status: 404 });
  }

  await deleteContactById(context.env.DB, id);

  return Response.json({
    deleted: true,
    contact: existing,
  });
};
