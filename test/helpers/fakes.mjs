// Test doubles, picked by shape: a fake Slack Web API, signed Slack requests,
// and a fake Voiceflow runtime. Secrets here are test-only values.
import http from 'node:http';
import { createHmac } from 'node:crypto';

export const SIGNING_SECRET = 'test-signing-secret';
export const BOT_TOKEN = 'xoxb-test-token';

/** A local Slack Web API that records every call. */
export async function startFakeSlack() {
  const calls = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const type = req.headers['content-type'] || '';
    const body = type.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    for (const k of ['blocks', 'attachments']) if (typeof body[k] === 'string') body[k] = JSON.parse(body[k]);
    const method = req.url.replace(/^\/+/, '').replace(/^api\//, '').split('?')[0];
    calls.push({ method, body });
    const ts = `1700000${String(++n).padStart(3, '0')}.000100`;
    const answer =
      method === 'auth.test' ? { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1' }
      // The bot resolves to its Slack username, as a real workspace answers for a bot user.
      : method === 'users.info' && body.user === 'UBOT' ? { ok: true, user: { id: 'UBOT', name: 'voiceflow', real_name: 'voiceflow', is_bot: true, profile: { display_name: 'voiceflow' } } }
      : method === 'users.info' ? { ok: true, user: { id: body.user, name: 'person', real_name: 'A Person', profile: {} } }
      : method === 'conversations.info' ? { ok: true, channel: { id: body.channel, name: 'general', is_im: false } }
      : method === 'chat.postMessage' ? { ok: true, ts, channel: body.channel, message: { ts, text: body.text } }
      : { ok: true };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    apiUrl: `http://127.0.0.1:${port}/api/`,
    calls,
    posts: () => calls.filter((c) => c.method === 'chat.postMessage'),
    close: () => new Promise((r) => server.close(r)),
  };
}

function sign(raw, secret, ts) {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
}

/** A Slack Events API request, signed the way Slack signs it. */
export function slackEvent(event, { secret = SIGNING_SECRET } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({
    type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: `Ev${Math.random().toString(36).slice(2)}`,
    event_time: Number(ts), event, authorizations: [{ user_id: 'UBOT', is_bot: true }],
  });
  return new Request('http://localhost/api/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(raw, secret, ts) },
    body: raw,
  });
}

/** A Slack interactivity request (a button click), form-encoded and signed. */
export function slackAction(payload, { secret = SIGNING_SECRET } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return new Request('http://localhost/api/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(raw, secret, ts) },
    body: raw,
  });
}

/**
 * A fake Voiceflow runtime as a `fetch`. `answer(action, call)` returns the
 * traces for each interact call. Records sessions and interact calls.
 */
export function fakeVoiceflow(answer) {
  const sessions = [];
  const interacts = [];
  let n = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/\/v4\/project\/[^/]+\/environment\/[^/]+\/session$/.test(url)) {
      const sessionKey = `sk-${++n}`;
      sessions.push({ url, userID: body.userID, authorization: init.headers.authorization, sessionKey });
      return new Response(JSON.stringify({ sessionKey }), { status: 200 });
    }
    if (url.endsWith('/v4/interact')) {
      const call = { sessionKey: init.headers.authorization, action: body.action, variables: body.variables, config: body.config };
      interacts.push(call);
      return new Response(JSON.stringify({ traces: answer(body.action, call) }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, sessions, interacts };
}

/** Collects waitUntil promises so a test can wait for the bot to finish. */
export function waiter() {
  const pending = [];
  return {
    options: { waitUntil: (p) => pending.push(p) },
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}
