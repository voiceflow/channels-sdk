// The relay end to end: Chat SDK's real Telegram adapter against a stand-in
// for each bot, two Voiceflow agents behind fakes, and one state store shared
// by every connection, as on a real relay. What it pins: connections never see
// each other's conversations or passes, a connection changes only with its own
// token, the relay never writes to an agent, and nothing it answers or reports
// carries a credential.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PASS_VARIABLE, passKey, readPass, TOOL_CALL_HEADER } from '@voiceflow/channels-sdk';
import { open, setConnectionDisabled } from '../dist/index.js';
import { KEY_A, KEY_B, PROJECT_A, PROJECT_B, world } from './helpers/world.mjs';

const toolCall = (url, pass, tool) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pass}`, [TOOL_CALL_HEADER]: '1' },
    body: JSON.stringify({ tool, input: {} }),
  });

test('two agents talking to the same person never share a conversation', async (t) => {
  const w = await world();
  t.after(w.close);
  const a = await w.connect(KEY_A, PROJECT_A);
  const b = await w.connect(KEY_B, PROJECT_B);
  assert.equal(a.response.status, 201);
  assert.equal(b.response.status, 201);

  // Both bots see Ada in the same Telegram chat, so both threads are `telegram:1001`.
  assert.equal((await w.send(w.to(a.hook, a.platform.message('hello A')))).status, 200);
  assert.equal((await w.send(w.to(b.hook, b.platform.message('hello B')))).status, 200);
  assert.equal((await w.send(w.to(a.hook, a.platform.message('again A')))).status, 200);

  // A session each, with each agent's own key, and A's second turn carries on A's.
  assert.deepEqual(
    w.runtime.sessions.map((s) => s.authorization),
    [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`],
  );
  assert.deepEqual(
    w.runtime.interacts.map((i) => i.sessionKey),
    ['sk-1', 'sk-2', 'sk-1'],
  );
  const toA = (await a.platform.sent()).map((s) => s.text).join('\n');
  const toB = (await b.platform.sent()).map((s) => s.text).join('\n');
  assert.match(toA, new RegExp(`Agent ${PROJECT_A} heard hello A[\\s\\S]*Agent ${PROJECT_A} heard again A`));
  assert.doesNotMatch(toA, new RegExp(PROJECT_B));
  assert.match(toB, new RegExp(`Agent ${PROJECT_B} heard hello B`));
  assert.doesNotMatch(toB, new RegExp(PROJECT_A));
  assert.deepEqual(w.errors, []);
});

test("each connection signs its turns' passes with a key of its own, never its Voiceflow API key", async (t) => {
  const calls = [];
  let relay;
  let hooks;
  const w = await world({
    answer: async (_action, call, project) => {
      // As the agent's server tool does mid-turn: the pass to this connection's address, then to the other's.
      const pass = call.variables[PASS_VARIABLE];
      const here = project === PROJECT_A ? hooks.a : hooks.b;
      const there = project === PROJECT_A ? hooks.b : hooks.a;
      const own = await relay.fetch(toolCall(here, pass, 'whoami'));
      const other = await relay.fetch(toolCall(there, pass, 'whoami'));
      calls.push({ project, pass, own: { status: own.status, body: await own.json() }, other: other.status });
      return [w.text('done')];
    },
  });
  t.after(w.close);
  relay = w.relay;
  const a = await w.connect(KEY_A, PROJECT_A);
  const b = await w.connect(KEY_B, PROJECT_B);
  hooks = { a: a.hook, b: b.hook };

  await w.send(w.to(a.hook, a.platform.message('who am I?')));
  await w.send(w.to(b.hook, b.platform.message('who am I?')));

  assert.equal(calls.length, 2);
  for (const [call, apiKey, id] of [
    [calls[0], KEY_A, a.created.id],
    [calls[1], KEY_B, b.created.id],
  ]) {
    assert.equal(call.own.status, 200);
    assert.equal(call.own.body.ok, true);
    assert.equal(call.own.body.result, 'thread telegram:1001');
    // The other connection's address doesn't take it, though the thread's ID is the same there.
    assert.equal(call.other, 401);
    // Not signed with the API key, the core's default: with the connection's own key, sealed in its record.
    assert.equal(readPass(passKey(apiKey), call.pass), null);
    const { toolSecret } = open(w.keys, id, w.store.records.get(id).sealed);
    assert.ok(toolSecret.length >= 32);
    assert.notEqual(readPass(passKey(toolSecret), call.pass), null);
  }
});

test('the relay never writes to an agent: it reads the project once, to check the key', async (t) => {
  const w = await world();
  t.after(w.close);
  const a = await w.connect(KEY_A, PROJECT_A);
  await w.send(w.to(a.hook, a.platform.message('hello')));
  await w.send(w.api('PATCH', `/v1alpha1/connections/${a.created.id}`, { token: a.created.token, body: { voiceflow: { apiKey: KEY_A } } }));
  assert.deepEqual(
    w.apiCalls().map((c) => `${c.method} ${c.path}`),
    [`GET /v1/stable/project/${PROJECT_A}`, `GET /v1/stable/project/${PROJECT_A}`],
  );
});

test("adding a connection takes a key that can read the agent's project, and keeps nothing readable", async (t) => {
  const w = await world();
  t.after(w.close);

  // B's key for A's project: refused, and nothing is kept.
  const refused = await w.connect(KEY_B, PROJECT_A);
  assert.equal(refused.response.status, 401);
  assert.equal(refused.created.error.code, 'key_refused');
  assert.equal(w.store.records.size, 0);

  const a = await w.connect(KEY_A, PROJECT_A);
  assert.equal(a.response.status, 201);
  assert.match(a.created.token, /^vfr_[A-Za-z0-9_-]{43}$/);
  assert.match(a.created.id, /^c_[A-Za-z0-9_-]{22}$/);
  assert.equal(a.created.hook, undefined);
  assert.equal(a.hook, `https://channels.example.com/v1/hooks/${a.created.id}/telegram`);
  assert.equal(a.created.workspaceID, 'ws-a');

  // Neither the answer nor the record holds the key, the bot's credentials or the token.
  const { botToken, secretToken } = a.platform.adapter;
  const answered = JSON.stringify({ ...a.created, token: undefined });
  const kept = JSON.stringify([...w.store.records.values()]);
  for (const secret of [KEY_A, botToken, secretToken]) {
    assert.ok(!answered.includes(secret));
    assert.ok(!kept.includes(secret));
  }
  assert.ok(!kept.includes(a.created.token));
});

test("a connection's channels take exactly their credentials, and an error names fields, never values", async (t) => {
  const w = await world();
  t.after(w.close);
  const post = async (body) => {
    const response = await w.send(w.api('POST', '/v1alpha1/connections', { body }));
    return { status: response.status, body: await response.json() };
  };
  const voiceflow = { apiKey: KEY_A, projectID: PROJECT_A };
  const telegram = { botToken: 'made-up-token-value', secretToken: 'made-up-secret-value', apiUrl: 'http://127.0.0.1:9' };

  const unknown = await post({ voiceflow, channels: { slack: { botToken: 'x' } } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_channel');

  const extra = await post({ voiceflow, channels: { telegram: { ...telegram, webhookUrl: 'https://elsewhere.example.com' } } });
  assert.equal(extra.status, 400);
  assert.ok(!JSON.stringify(extra.body).includes('elsewhere'));

  const missing = await post({ voiceflow, channels: { telegram: { botToken: 'made-up-token-value' } } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /secretToken/);
  assert.ok(!JSON.stringify(missing.body).includes('made-up-token-value'));

  // Nothing beyond what a connection takes: not Voiceflow's address, not another field.
  const elsewhere = await post({ voiceflow: { ...voiceflow, runtimeURL: 'https://elsewhere.example.com' } });
  assert.equal(elsewhere.status, 400);
  assert.equal((await post({ voiceflow, disabled: false })).status, 400);
  for (const body of [
    {},
    { voiceflow: { apiKey: KEY_A } },
    { voiceflow: { apiKey: KEY_A, projectID: '../../v1/other' } },
    { voiceflow: { ...voiceflow, environment: 'a/b' } },
  ]) {
    assert.equal((await post(body)).status, 400);
  }
  const bad = await w.send(new Request('https://channels.example.com/v1alpha1/connections', { method: 'POST', body: 'not json' }));
  assert.equal(bad.status, 400);
  assert.equal(w.store.records.size, 0);
});

test('a connection is read, changed or deleted only with its own token', async (t) => {
  const w = await world();
  t.after(w.close);
  const a = await w.connect(KEY_A, PROJECT_A);
  const b = await w.connect(KEY_B, PROJECT_B);
  const path = `/v1alpha1/connections/${a.created.id}`;
  const status = async (request) => (await w.send(request)).status;

  // No token, another connection's, or a made-up one: the same answer as no connection at all.
  assert.equal(await status(w.api('GET', path)), 404);
  assert.equal(await status(w.api('GET', path, { token: b.created.token })), 404);
  assert.equal(await status(w.api('GET', path, { token: `vfr_${'x'.repeat(43)}` })), 404);
  assert.equal(await status(w.api('GET', '/v1alpha1/connections/c_nothingherenothinghere', { token: a.created.token })), 404);
  const shown = await w.send(w.api('GET', path, { token: a.created.token }));
  assert.equal(shown.status, 200);
  assert.equal((await shown.json()).projectID, PROJECT_A);

  const before = structuredClone(w.store.records.get(a.created.id));
  assert.equal(await status(w.api('PATCH', path, { token: b.created.token, body: { voiceflow: { environment: 'development' } } })), 404);
  assert.equal(await status(w.api('DELETE', path, { token: b.created.token })), 404);
  // Its project doesn't change, and a new key has to read it.
  assert.equal(await status(w.api('PATCH', path, { token: a.created.token, body: { voiceflow: { projectID: PROJECT_B } } })), 400);
  assert.equal(await status(w.api('PATCH', path, { token: a.created.token, body: { voiceflow: { apiKey: KEY_B } } })), 401);
  assert.deepEqual(w.store.records.get(a.created.id), before);

  const changed = await w.send(w.api('PATCH', path, { token: a.created.token, body: { voiceflow: { environment: 'development' } } }));
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).environment, 'development');
  assert.equal(w.store.records.get(a.created.id).revision, before.revision + 1);

  // A new token, and the old one stops working.
  const renewed = await w.send(w.api('POST', `${path}/token`, { token: a.created.token }));
  assert.equal(renewed.status, 200);
  const { token } = await renewed.json();
  assert.notEqual(token, a.created.token);
  assert.equal(await status(w.api('GET', path, { token: a.created.token })), 404);
  assert.equal(await status(w.api('GET', path, { token })), 200);

  assert.equal(await status(w.api('DELETE', path, { token })), 204);
  assert.equal(await status(w.api('GET', path, { token })), 404);
  assert.equal((await w.send(w.to(a.hook, a.platform.message('hello')))).status, 404);
  // The other connection is as it was.
  assert.equal(await status(w.api('GET', `/v1alpha1/connections/${b.created.id}`, { token: b.created.token })), 200);
});

test("the operator's switch turns one connection off at once, and leaves the others", async (t) => {
  const w = await world();
  t.after(w.close);
  const a = await w.connect(KEY_A, PROJECT_A);
  const b = await w.connect(KEY_B, PROJECT_B);
  await w.send(w.to(a.hook, a.platform.message('hello')));
  assert.equal(w.runtime.interacts.length, 1);

  assert.equal(await w.relay.setDisabled(a.created.id, true), true);
  assert.equal((await w.send(w.to(a.hook, a.platform.message('still there?')))).status, 404);
  assert.equal(w.runtime.interacts.length, 1);
  assert.equal((await w.send(w.to(b.hook, b.platform.message('hello')))).status, 200);
  assert.equal(w.runtime.interacts.length, 2);
  // Its owner can't turn it back on.
  const path = `/v1alpha1/connections/${a.created.id}`;
  assert.equal((await w.send(w.api('PATCH', path, { token: a.created.token, body: { disabled: false } }))).status, 400);
  assert.equal(w.store.records.get(a.created.id).disabled, true);

  assert.equal(await w.relay.setDisabled(a.created.id, false), true);
  assert.equal((await w.send(w.to(a.hook, a.platform.message('back?')))).status, 200);
  assert.equal(w.runtime.interacts.length, 3);
  assert.equal(await w.relay.setDisabled('c_nothingherenothinghere', true), false);

  // From a script, on the store alone: the running relay, with A's bot made, stops answering for it.
  assert.equal(await setConnectionDisabled(w.store, a.created.id, true), true);
  assert.equal((await w.send(w.to(a.hook, a.platform.message('and now?')))).status, 404);
  assert.equal(w.runtime.interacts.length, 3);
});

test("a webhook that isn't from the platform is refused, and an address with no connection says nothing", async (t) => {
  const w = await world();
  t.after(w.close);
  const a = await w.connect(KEY_A, PROJECT_A);
  assert.equal((await w.send(w.to(a.hook, a.platform.forged('hello')))).status, 401);
  assert.equal((await w.send(w.to(a.hook.replace('/telegram', '/slack'), a.platform.message('hello')))).status, 404);
  assert.equal((await w.send(w.to(`https://channels.example.com/v1/hooks/c_nothingherenothinghere/telegram`, a.platform.message('hello')))).status, 404);
  assert.equal((await w.send(w.api('GET', '/'))).status, 404);
  assert.equal(w.runtime.interacts.length, 0);
});

test('what a connection reports is cleaned of its credentials', async (t) => {
  const w = await world({
    answer: () => {
      throw new Error(`the runtime echoed ${KEY_A} and ${w.botToken}`);
    },
  });
  t.after(w.close);
  const a = await w.connect(KEY_A, PROJECT_A);
  w.botToken = a.platform.adapter.botToken;
  await w.send(w.to(a.hook, a.platform.message('hello')));
  assert.ok(w.errors.length >= 1);
  for (const { error, context } of w.errors) {
    assert.equal(context.connection, a.created.id);
    assert.ok(!error.message.includes(KEY_A), error.message);
    assert.ok(!error.message.includes(w.botToken), error.message);
  }
  assert.match(w.errors.map((e) => e.error.message).join('\n'), /the runtime echoed/);
});
