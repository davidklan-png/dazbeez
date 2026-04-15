import type { Env } from '../_lib/env';
import { isAuthorizedAdmin, unauthorizedAdminResponse } from '../_lib/admin';
import { getVCardProfile, upsertVCardProfile } from '../_lib/db';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (!isAuthorizedAdmin(context.request, context.env)) {
    return unauthorizedAdminResponse();
  }

  const profile = await getVCardProfile(context.env.DB);
  return Response.json(profile);
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  if (!isAuthorizedAdmin(context.request, context.env)) {
    return unauthorizedAdminResponse();
  }

  let payload: unknown;
  try {
    payload = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object') {
    return Response.json({ error: 'Expected a vCard profile object' }, { status: 400 });
  }

  const profile = await upsertVCardProfile(
    context.env.DB,
    payload as Record<string, string>,
  );

  return Response.json({
    saved: true,
    profile,
  });
};
