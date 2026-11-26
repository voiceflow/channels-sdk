// The Postgres store, against Postgres itself (PGlite, in this process): the
// statements make its table, a write names the revision it read, a list pages
// through everything, and what a row holds in the clear is nothing secret.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createMemoryState } from '@chat-adapter/state-memory';
import { PGlite } from '@electric-sql/pglite';
import { fakeVoiceflowApi } from '@voiceflow/channels-sdk/testing';
import { connectionStoreStatements, createRelay, parseKeys, postgresConnectionStore, seal } from '../dist/index.js';

const keys = parseKeys(`k1:${randomBytes(32).toString('base64')}`);

async function database() {
  const db = new PGlite();
  // Run twice: a migration can run again.
  for (const statement of [...connectionStoreStatements, ...connectionStoreStatements]) await db.query(statement);
  return db;
}

const record = (id, more = {}) => ({
  id,
  projectID: 'p1',
  workspaceID: 'w1',
  environment: 'production',
  channels: ['slack'],
  disabled: false,
  tokenHash: 'ab'.repeat(32),
  sealed: seal(keys, id, { apiKey: 'VF.DM.made-up' }),
  revision: 1,
  createdAt: '2026-11-26T00:00:00.000Z',
  updatedAt: '2026-11-26T00:00:00.000Z',
  ...more,
});

test('a record comes back as it went in, and a write names the revision it read', async (t) => {
  const db = await database();
  t.after(() => db.close());
  const store = postgresConnectionStore(db);
  await store.create(record('c_1'));
  assert.deepEqual(await store.get('c_1'), record('c_1', { sealed: (await store.get('c_1')).sealed }));
  assert.equal(await store.get('c_none'), null);
  await assert.rejects(store.create(record('c_1')));

  const next = { ...(await store.get('c_1')), channels: ['slack', 'telegram'], disabled: true, revision: 2, updatedAt: '2026-11-27T00:00:00.000Z' };
  assert.equal(await store.update(next, 1), true);
  // Another writer that read revision 1 loses.
  assert.equal(await store.update({ ...next, environment: 'development', revision: 2 }, 1), false);
  assert.deepEqual(await store.get('c_1'), next);
  assert.equal(await store.update(record('c_none'), 1), false);

  await store.delete('c_1');
  assert.equal(await store.get('c_1'), null);
});

test('a list pages through every record, in ID order', async (t) => {
  const db = await database();
  t.after(() => db.close());
  const store = postgresConnectionStore(db);
  const ids = Array.from({ length: 1003 }, (_, i) => `c_${String(i).padStart(4, '0')}`);
  await db.query('begin');
  for (const id of [...ids].reverse()) await store.create(record(id));
  await db.query('commit');
  const listed = [];
  for await (const r of store.list()) listed.push(r.id);
  assert.deepEqual(listed, ids);
});

test("a connection's row holds nothing secret in the clear", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const project = { id: '6a0000000000000000000a0a', name: 'Agent', workspaceID: 'ws' };
  const apiKey = 'VF.DM.aaaaaaaaaaaaaaaaaaaaaaaa.made-up-key';
  const api = fakeVoiceflowApi({ project, apiKey });
  const relay = createRelay({
    publicURL: 'https://channels.example.com',
    store: postgresConnectionStore(db),
    keys,
    state: createMemoryState(),
    channels: { slack: { credentials: ['botToken', 'signingSecret'], channel: () => ({ slug: 'slack' }) } },
    voiceflow: { fetch: api.fetch },
  });
  const botToken = 'xoxb-made-up-bot-token';
  const signingSecret = 'made-up-signing-secret';
  const response = await relay.fetch(
    new Request('https://channels.example.com/v1alpha1/connections', {
      method: 'POST',
      body: JSON.stringify({ voiceflow: { apiKey, projectID: project.id }, channels: { slack: { botToken, signingSecret } } }),
    }),
  );
  assert.equal(response.status, 201);
  const { token } = await response.json();
  const { rows } = await db.query('select row_to_json(c)::text as row from channels_relay_connections c');
  assert.equal(rows.length, 1);
  for (const secret of [apiKey, botToken, signingSecret, token]) assert.ok(!rows[0].row.includes(secret));
  assert.match(rows[0].row, /"channels":\["slack"\]/);
});
