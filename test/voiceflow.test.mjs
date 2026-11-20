import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceflowClient } from '../dist/index.js';

function memorySessions() {
  let key = null;
  return { get: async () => key, set: async (k) => { key = k; }, delete: async () => { key = null; }, peek: () => key };
}

function runtime(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return handler(url, init, calls.length);
  };
  return { fetch, calls };
}

const ok = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('starts a session once and reuses it for the next turn', async () => {
  const rt = runtime((url) => (url.endsWith('/session') ? ok({ sessionKey: 'sk-1' }) : ok({ traces: [{ type: 'text', payload: { message: 'hi' } }] })));
  const client = createVoiceflowClient({ apiKey: 'VF.SERVICE.key', projectID: 'p1', environment: 'development', fetch: rt.fetch });
  const sessions = memorySessions();
  await client.turn({ userID: 'slack:C1:1', action: { type: 'text', payload: 'a' }, sessions });
  const second = await client.turn({ userID: 'slack:C1:1', action: { type: 'text', payload: 'b' }, sessions });
  assert.equal(second.traces[0].payload.message, 'hi');
  assert.deepEqual(rt.calls.map((c) => c.url.replace('https://general-runtime.voiceflow.com', '')), [
    '/v4/project/p1/environment/development/session', '/v4/interact', '/v4/interact',
  ]);
  assert.equal(rt.calls[0].headers.authorization, 'Bearer VF.SERVICE.key');
  assert.deepEqual(rt.calls[0].body, { userID: 'slack:C1:1' });
  assert.equal(rt.calls[1].headers.authorization, 'sk-1');
  assert.deepEqual(rt.calls[1].body.config.excludeTypes, ['block', 'path', 'flow', 'debug', 'log']);
});

test('a rejected session key is replaced once', async () => {
  let n = 0;
  const rt = runtime((url) => {
    if (url.endsWith('/session')) return ok({ sessionKey: `sk-${++n}` });
    return rt.calls.at(-1).headers.authorization === 'sk-old' ? ok({}, 401) : ok({ traces: [] });
  });
  const sessions = memorySessions();
  await sessions.set('sk-old');
  const client = createVoiceflowClient({ apiKey: () => 'key-from-a-function', projectID: 'p1', fetch: rt.fetch });
  await client.turn({ userID: 'u', action: { type: 'text', payload: 'a' }, sessions });
  assert.equal(sessions.peek(), 'sk-1');
  assert.equal(rt.calls.find((c) => c.url.endsWith('/session')).headers.authorization, 'Bearer key-from-a-function');
  assert.match(rt.calls[1].url, /\/environment\/production\/session$/);
});

test('out of credits returns the explaining traces; other errors throw with a code', async () => {
  const credits = runtime((url) => (url.endsWith('/session') ? ok({ sessionKey: 'sk' }) : ok({ traces: [{ type: 'debug', payload: { type: 'credit_limit_reached' } }] }, 402)));
  const r = await createVoiceflowClient({ apiKey: 'k', projectID: 'p', fetch: credits.fetch }).turn({ userID: 'u', action: { type: 'launch' }, sessions: memorySessions() });
  assert.equal(r.outOfCredits, true);

  const broken = runtime((url) => (url.endsWith('/session') ? ok({ sessionKey: 'sk' }) : ok({ error: 'boom' }, 500)));
  await assert.rejects(createVoiceflowClient({ apiKey: 'k', projectID: 'p', fetch: broken.fetch }).turn({ userID: 'u', action: { type: 'launch' }, sessions: memorySessions() }), (e) => e.code === 'voiceflow_http');

  const refused = runtime(() => ok({ message: 'bad key' }, 401));
  await assert.rejects(createVoiceflowClient({ apiKey: 'k', projectID: 'p', fetch: refused.fetch }).turn({ userID: 'u', action: { type: 'launch' }, sessions: memorySessions() }), (e) => e.code === 'voiceflow_http' && /session/.test(e.message));
});
