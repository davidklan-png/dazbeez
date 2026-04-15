import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet as listContactsRoute } from '../functions/admin/contacts';
import { onRequestDelete as deleteContactRoute } from '../functions/admin/contacts/[id]';
import {
  onRequestGet as getVCardRoute,
  onRequestPut as updateVCardRoute,
} from '../functions/admin/vcard';
import { createEnv, createFakeD1Database, createFakeDbState, createPagesContext } from './helpers';

test('admin contacts route requires authorization', async () => {
  const env = createEnv();
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/admin/contacts',
    env,
  });

  const response = await listContactsRoute(context as never);

  assert.equal(response.status, 401);
});

test('admin contacts route returns contacts and per-card metrics', async () => {
  const dbState = createFakeDbState(
    [{ token: 'card-1', label: 'card-1' }],
    {
      contacts: [
        {
          token: 'card-1',
          name: 'Casey Contact',
          email: 'casey@example.com',
          source: 'manual',
        },
      ],
    },
  );
  dbState.taps.push(
    { id: 1, token: 'card-1', cf_country: 'JP', cf_city: 'Tokyo', user_agent: 'UA-1' },
    { id: 2, token: 'card-1', cf_country: 'JP', cf_city: 'Tokyo', user_agent: 'UA-2' },
  );

  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/admin/contacts?token=card-1',
    headers: {
      Authorization: 'Bearer admin-secret',
    },
    env,
  });

  const response = await listContactsRoute(context as never);
  const payload = await response.json() as {
    token: string;
    metrics: Array<{ token: string; tap_count: number; contact_count: number; conversion_rate: number }>;
    contacts: Array<{ email: string; sources: string[] }>;
    events: Array<{ email: string; source: string }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.token, 'card-1');
  assert.equal(payload.contacts.length, 1);
  assert.equal(payload.contacts[0].email, 'casey@example.com');
  assert.deepEqual(payload.contacts[0].sources, ['manual']);
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].source, 'manual');
  assert.equal(payload.metrics[0].tap_count, 2);
  assert.equal(payload.metrics[0].contact_count, 1);
  assert.equal(payload.metrics[0].conversion_rate, 0.5);
});

test('admin contacts route returns every method used for the same contact', async () => {
  const dbState = createFakeDbState(
    [{ token: 'card-1', label: 'card-1' }],
    {
      contacts: [
        {
          token: 'card-1',
          name: 'Casey Contact',
          email: 'casey@example.com',
          source: 'linkedin',
        },
      ],
    },
  );
  dbState.contactMethods.push({
    id: 2,
    contact_id: 1,
    method: 'manual',
  });
  dbState.contactEvents.push({
    id: 2,
    contact_id: 1,
    token: 'card-1',
    source: 'manual',
    name: 'Casey Contact',
    email: 'casey@example.com',
    created_at: '2026-04-13 00:00:11',
  });

  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/admin/contacts?token=card-1',
    headers: {
      Authorization: 'Bearer admin-secret',
    },
    env,
  });

  const response = await listContactsRoute(context as never);
  const payload = await response.json() as {
    contacts: Array<{ sources: string[] }>;
    events: Array<{ source: string }>;
  };

  assert.equal(response.status, 200);
  assert.deepEqual(payload.contacts[0].sources.sort(), ['linkedin', 'manual']);
  assert.deepEqual(payload.events.map((event) => event.source).sort(), ['linkedin', 'manual']);
});

test('admin delete route removes a contact', async () => {
  const dbState = createFakeDbState(
    [{ token: 'card-1', label: 'card-1' }],
    {
      contacts: [
        {
          id: 7,
          token: 'card-1',
          name: 'Casey Contact',
          email: 'casey@example.com',
          source: 'manual',
        },
      ],
    },
  );
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/admin/contacts/7',
    method: 'DELETE',
    headers: {
      'x-admin-key': 'admin-secret',
    },
    params: {
      id: '7',
    },
    env,
  });

  const response = await deleteContactRoute(context as never);
  const payload = await response.json() as { deleted: boolean; contact: { id: number } };

  assert.equal(response.status, 200);
  assert.equal(payload.deleted, true);
  assert.equal(payload.contact.id, 7);
  assert.equal(dbState.contacts.length, 0);
  assert.equal(dbState.contactMethods.length, 0);
  assert.equal(dbState.contactEvents.length, 0);
});

test('admin vcard route returns the current profile', async () => {
  const env = createEnv();
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/admin/vcard',
    headers: {
      Authorization: 'Bearer admin-secret',
    },
    env,
  });

  const response = await getVCardRoute(context as never);
  const payload = await response.json() as { fullName: string; fileName: string };

  assert.equal(response.status, 200);
  assert.equal(payload.fullName, 'David Klan');
  assert.equal(payload.fileName, 'david-klan.vcf');
});

test('admin vcard route updates the profile', async () => {
  const dbState = createFakeDbState();
  const env = createEnv({
    DB: createFakeD1Database(dbState),
  });
  const { context } = createPagesContext({
    url: 'https://hi.dazbeez.com/admin/vcard',
    method: 'PUT',
    headers: {
      Authorization: 'Bearer admin-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fullName: 'David Klan Consulting',
      organization: 'Dazbeez Labs',
      fileName: 'david-klan-consulting',
    }),
    env,
  });

  const response = await updateVCardRoute(context as never);
  const payload = await response.json() as {
    saved: boolean;
    profile: { fullName: string; organization: string; fileName: string };
  };

  assert.equal(response.status, 200);
  assert.equal(payload.saved, true);
  assert.equal(payload.profile.fullName, 'David Klan Consulting');
  assert.equal(payload.profile.organization, 'Dazbeez Labs');
  assert.equal(payload.profile.fileName, 'david-klan-consulting.vcf');
  assert.equal(dbState.vcardProfile.full_name, 'David Klan Consulting');
  assert.equal(dbState.vcardProfile.organization, 'Dazbeez Labs');
  assert.equal(dbState.vcardProfile.file_name, 'david-klan-consulting.vcf');
});
