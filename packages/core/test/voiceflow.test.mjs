import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceflowClient, traceEvents } from '../dist/index.js';

function memorySessions() {
  let key = null;
  return {
    get: async () => key,
    set: async (k) => {
      key = k;
    },
    delete: async () => {
      key = null;
    },
    peek: () => key,
  };
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
  assert.deepEqual(
    rt.calls.map((c) => c.url.replace('https://general-runtime.voiceflow.com', '')),
    ['/v4/project/p1/environment/development/session', '/v4/interact', '/v4/interact'],
  );
  assert.equal(rt.calls[0].headers.authorization, 'Bearer VF.SERVICE.key');
  assert.deepEqual(rt.calls[0].body, { userID: 'slack:C1:1' });
  assert.equal(rt.calls[1].headers.authorization, 'sk-1');
  assert.deepEqual(rt.calls[1].body.config.excludeTypes, ['block', 'path', 'flow', 'debug', 'log']);
});

test('a session the runtime no longer has is replaced, so a conversation left idle carries on', async () => {
  // Voiceflow answers 404 when there is no active session for the key: one that ended while the thread sat idle.
  for (const stream of [false, true]) {
    let n = 0;
    const rt = runtime((url) => {
      if (url.endsWith('/session')) return ok({ sessionKey: `sk-${++n}` });
      if (rt.calls.at(-1).headers.authorization === 'sk-idle') return ok({ message: 'No active session' }, 404);
      return stream ? new Response('event: end\ndata: {}\n\n', { status: 200 }) : ok({ traces: [] });
    });
    const sessions = memorySessions();
    await sessions.set('sk-idle');
    const client = createVoiceflowClient({ apiKey: 'k', projectID: 'p1', fetch: rt.fetch });
    const input = { userID: 'u', action: { type: 'text', payload: 'still there?' }, sessions };
    if (stream) for await (const _ of (await client.stream(input)).traces);
    else await client.turn(input);
    assert.equal(sessions.peek(), 'sk-1', stream ? 'streamed' : 'whole');
    assert.equal(rt.calls.filter((c) => c.url.endsWith('/session')).length, 1, 'one new session');
    assert.equal(rt.calls.at(-1).headers.authorization, 'sk-1', 'and the turn is sent again with it');
  }
  // A runtime that has no session for the new key either is a failure, not a loop.
  const rt = runtime((url) => (url.endsWith('/session') ? ok({ sessionKey: 'sk-new' }) : ok({ message: 'No active session' }, 404)));
  const sessions = memorySessions();
  await sessions.set('sk-idle');
  const client = createVoiceflowClient({ apiKey: 'k', projectID: 'p1', fetch: rt.fetch });
  await assert.rejects(
    client.turn({ userID: 'u', action: { type: 'text', payload: 'x' }, sessions }),
    (e) => e.code === 'voiceflow_http' && /404/.test(e.message),
  );
  assert.equal(rt.calls.filter((c) => c.url.endsWith('/session')).length, 1);
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
  const credits = runtime((url) =>
    url.endsWith('/session') ? ok({ sessionKey: 'sk' }) : ok({ traces: [{ type: 'debug', payload: { type: 'credit_limit_reached' } }] }, 402),
  );
  const r = await createVoiceflowClient({ apiKey: 'k', projectID: 'p', fetch: credits.fetch }).turn({
    userID: 'u',
    action: { type: 'launch' },
    sessions: memorySessions(),
  });
  assert.equal(r.outOfCredits, true);

  const broken = runtime((url) => (url.endsWith('/session') ? ok({ sessionKey: 'sk' }) : ok({ error: 'boom' }, 500)));
  await assert.rejects(
    createVoiceflowClient({ apiKey: 'k', projectID: 'p', fetch: broken.fetch }).turn({ userID: 'u', action: { type: 'launch' }, sessions: memorySessions() }),
    (e) => e.code === 'voiceflow_http',
  );

  const refused = runtime(() => ok({ message: 'bad key' }, 401));
  await assert.rejects(
    createVoiceflowClient({ apiKey: 'k', projectID: 'p', fetch: refused.fetch }).turn({ userID: 'u', action: { type: 'launch' }, sessions: memorySessions() }),
    (e) => e.code === 'voiceflow_http' && /session/.test(e.message),
  );
});

const sseBody = (text, split = 7) => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Split mid-line and mid-character, as a network would.
      for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
      controller.close();
    },
  });
};
const collect = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};

test('server-sent events become traces: bare or wrapped, CRLF or LF, comments ignored, stopped at end', async () => {
  const text =
    ': keep-alive\r\n\r\n' +
    'event: trace\r\nid: 1\r\ndata: {"type":"text","payload":{"message":"héllo"}}\r\n\r\n' +
    'event: trace\ndata: {"event":"trace","data":{"type":"completion","payload":{"state":"start","messageID":"a"}}}\n\n' +
    'event: state\ndata: {"stack":[]}\n\n' +
    'event: end\ndata: {}\n\n' +
    'event: trace\ndata: {"type":"text","payload":{"message":"after the end"}}\n\n';
  const traces = await collect(traceEvents(sseBody(text)));
  assert.deepEqual(
    traces.map((t) => t.type),
    ['text', 'completion'],
  );
  assert.equal(traces[0].payload.message, 'héllo');
});

test('a streamed turn asks for completion events and reads the stream', async () => {
  const rt = runtime((url) =>
    url.endsWith('/session')
      ? ok({ sessionKey: 'sk-1' })
      : new Response('event: trace\ndata: {"type":"text","payload":{"message":"hi"}}\n\nevent: end\ndata: {}\n\n', { status: 200 }),
  );
  const client = createVoiceflowClient({ apiKey: 'VF.SERVICE.key', projectID: 'p1', fetch: rt.fetch });
  const result = await client.stream({ userID: 'u', action: { type: 'text', payload: 'a' }, sessions: memorySessions() });
  assert.equal(result.outOfCredits, false);
  assert.deepEqual(
    (await collect(result.traces)).map((t) => t.payload.message),
    ['hi'],
  );
  const call = rt.calls.at(-1);
  assert.match(call.url, /\/v4\/interact\/stream$/);
  assert.equal(call.headers.accept, 'text/event-stream');
  assert.equal(call.body.config.completionEvents, true);
});

test('a streamed turn out of credits returns the explaining traces; a refused session is replaced once', async () => {
  let interacts = 0;
  const rt = runtime((url) => {
    if (url.endsWith('/session')) return ok({ sessionKey: `sk-${rt.calls.filter((c) => c.url.endsWith('/session')).length}` });
    interacts += 1;
    return interacts === 1 ? ok({}, 401) : ok({ traces: [{ type: 'debug', payload: { message: 'out of credits' } }] }, 402);
  });
  const sessions = memorySessions();
  const client = createVoiceflowClient({ apiKey: 'VF.SERVICE.key', projectID: 'p1', fetch: rt.fetch });
  const result = await client.stream({ userID: 'u', action: { type: 'text', payload: 'a' }, sessions });
  assert.equal(result.outOfCredits, true);
  assert.deepEqual(
    (await collect(result.traces)).map((t) => t.type),
    ['debug'],
  );
  assert.equal(sessions.peek(), 'sk-2');
});
