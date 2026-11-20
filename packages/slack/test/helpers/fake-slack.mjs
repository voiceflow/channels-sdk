// Slack test doubles, picked by shape: a fake Slack Web API and signed Slack
// requests. The fake Voiceflow runtime comes from @voiceflow/channels-sdk/testing.
// Secrets here are test-only values.

import { createHmac } from 'node:crypto';
import http from 'node:http';

export const SIGNING_SECRET = 'test-signing-secret';
export const BOT_TOKEN = 'xoxb-test-token';

/**
 * A local Slack Web API that records every call, with its answer. `refuse(method, body)`
 * can return an error answer (`{ ok: false, error }`) to refuse a call, as Slack does.
 * `replies(body)` returns a thread's messages for `conversations.replies`; `answer(method, body)`
 * can answer any other method.
 */
export async function startFakeSlack({ refuse, replies, answer: answerWith } = {}) {
  const calls = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const type = req.headers['content-type'] || '';
    const body = type.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    for (const k of ['blocks', 'attachments', 'chunks', 'prompts', 'view', 'document_content', 'bookmark']) {
      if (typeof body[k] === 'string' && /^[[{]/.test(body[k])) body[k] = JSON.parse(body[k]);
    }
    const method = req.url
      .replace(/^\/+/, '')
      .replace(/^api\//, '')
      .split('?')[0];
    const call = { method, body };
    calls.push(call);
    const ts = `1700000${String(++n).padStart(3, '0')}.000100`;
    const answer =
      refuse?.(method, body) ??
      answerWith?.(method, body) ??
      (method === 'auth.test'
        ? { ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1', team: 'Test', url: 'https://test.slack.com/' }
        : // The bot resolves to its Slack username, as a real workspace answers for a bot user.
          method === 'users.info' && body.user === 'UBOT'
          ? { ok: true, user: { id: 'UBOT', name: 'voiceflow', real_name: 'voiceflow', is_bot: true, profile: { display_name: 'voiceflow' } } }
          : method === 'users.info'
            ? {
                ok: true,
                user: {
                  id: body.user,
                  name: 'person',
                  real_name: 'A Person',
                  tz: 'America/Toronto',
                  profile: { title: 'Head of Support', email: 'person@example.com' },
                },
              }
            : method === 'conversations.replies'
              ? { ok: true, messages: replies?.(body) ?? [], has_more: false }
              : method === 'conversations.info'
                ? { ok: true, channel: { id: body.channel, name: 'general', is_im: false } }
                : method === 'chat.postMessage'
                  ? { ok: true, ts, channel: body.channel, message: { ts, text: body.text } }
                  : method === 'chat.startStream'
                    ? { ok: true, ts, channel: body.channel }
                    : method === 'chat.appendStream' || method === 'chat.stopStream' || method === 'chat.update'
                      ? { ok: true, ts: body.ts, channel: body.channel }
                      : { ok: true });
    call.answer = answer;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    apiUrl: `http://127.0.0.1:${port}/api/`,
    calls,
    /** Every message Slack accepted (a refused post is in `calls`, not here). */
    posts: () => calls.filter((c) => c.method === 'chat.postMessage' && c.answer?.ok),
    updates: () => calls.filter((c) => c.method === 'chat.update'),
    /** Calls to one Web API method. */
    of: (method) => calls.filter((c) => c.method === method),
    /** Every native stream, read back the way Slack assembles it: its text, its task updates and its closing blocks. */
    streams: () => {
      const byTs = new Map();
      for (const c of calls) {
        if (!['chat.startStream', 'chat.appendStream', 'chat.stopStream'].includes(c.method)) continue;
        const key = c.method === 'chat.startStream' ? `start-${calls.indexOf(c)}` : null;
        const stream = key ? { text: '', tasks: [], blocks: [], stopped: false, start: c.body } : [...byTs.values()].at(-1);
        if (key) byTs.set(key, stream);
        if (typeof c.body.markdown_text === 'string') stream.text += c.body.markdown_text;
        for (const chunk of c.body.chunks ?? []) {
          if (chunk.type === 'markdown_text') stream.text += chunk.text;
          else if (chunk.type === 'task_update') stream.tasks.push({ id: chunk.id, title: chunk.title, status: chunk.status });
        }
        if (c.method === 'chat.stopStream') {
          stream.stopped = true;
          stream.blocks = c.body.blocks ?? [];
        }
      }
      return [...byTs.values()];
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

function sign(raw, secret, ts) {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
}

/** A Slack Events API request, signed the way Slack signs it. */
export function slackEvent(event, { secret = SIGNING_SECRET } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({
    type: 'event_callback',
    team_id: 'T1',
    api_app_id: 'A1',
    event_id: `Ev${Math.random().toString(36).slice(2)}`,
    event_time: Number(ts),
    event,
    authorizations: [{ user_id: 'UBOT', is_bot: true }],
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

/** A Slack slash command, form-encoded and signed. */
export function slackCommand(params, { secret = SIGNING_SECRET } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = new URLSearchParams({ team_id: 'T1', api_app_id: 'A1', trigger_id: 'trig', ...params }).toString();
  return new Request('http://localhost/api/slack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(raw, secret, ts) },
    body: raw,
  });
}
