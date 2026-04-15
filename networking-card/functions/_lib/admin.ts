import type { Env } from './env';

export function isAuthorizedAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_KEY) {
    return false;
  }

  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length) === env.ADMIN_API_KEY;
  }

  return request.headers.get('x-admin-key') === env.ADMIN_API_KEY;
}

export function unauthorizedAdminResponse(): Response {
  return Response.json(
    { error: 'Unauthorized' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer',
      },
    },
  );
}
