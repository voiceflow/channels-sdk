// A stand-in for GitLab's REST API, as a server on this machine: the real
// GitLab adapter talks to it as it talks to GitLab. It answers the calls a bot
// makes, records the comments the bot writes, and builds what GitLab sends a
// bot: a person's comment on an issue that mentions the bot, and their replies
// in the thread the bot's answer makes of that comment.
//
// The adapter is pointed here by its own settings: `apiUrl` (where it calls,
// `/api/v4` included), `token` (what it calls with) and `webhookSigningToken`
// (what GitLab signs with). Told no name for the bot, it asks who it is when it
// starts (`GET /user`), as it does on GitLab with those two credentials alone.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';

// Made up, and put together here so that nothing in this file reads as a key.
// A signing token is `whsec_` and 32 bytes in base64, as GitLab shows one.
const TOKEN = ['glpat', 'made-up-access-token'].join('-');
const signingToken = (words) => `whsec_${createHash('sha256').update(words).digest('base64')}`;
const SIGNING_TOKEN = signingToken('a made-up signing token');
const SOMEBODY_ELSES = signingToken("somebody else's signing token");

const WEB = 'https://gitlab.example.com';
const URL_ = 'https://bot.example.com/api/gitlab';
const PROJECT = { id: 4107, name: 'Support', path_with_namespace: 'acme/support', web_url: `${WEB}/acme/support` };
const ISSUE = { id: 90012, iid: 12, title: 'Where is my order?' };
// GitLab leaves a person's email out of what it sends unless they made it public.
const ADA = { id: 1001, name: 'Ada Lovelace', username: 'ada', avatar_url: null, email: '[REDACTED]' };
/** The bot is an account of its own, and the access token is that account's. */
const BOT = { id: 2002, username: 'acme-support', name: 'Acme Support', state: 'active', locked: false, avatar_url: null, web_url: `${WEB}/acme-support` };
/** GitLab takes 1,000,000 characters in a comment, and refuses a longer one. */
const LIMIT = 1_000_000;

const NOTES = new RegExp(`^/api/v4/projects/${PROJECT.id}/issues/${ISSUE.iid}(?:/discussions/([0-9a-f]+))?/notes$`);

/** A text's length as GitLab counts it: in characters, where JavaScript counts some (an emoji, say) as two. */
const characters = (text) => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

/** A time as GitLab writes it in a webhook (`2026-11-24 10:15:00 UTC`), where its API writes ISO 8601. */
const stamp = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

/** A comment as a person reads it. It is markdown as the bot wrote it: GitLab shows the mark after a backslash as itself. */
const read = (markdown) => String(markdown ?? '').replace(/\\([!-/:-@[-`{-~])/g, '$1');

export async function start() {
  const calls = [];
  let n = 500;
  /** The thread Ada and the bot are in: GitLab's ID for her first comment's discussion. None until she writes. */
  let discussion = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: '401 Unauthorized' });
      const path = new URL(req.url ?? '/', WEB).pathname;
      // Who the token is: asked once, as the adapter starts. Not a message.
      if (req.method === 'GET' && path === '/api/v4/user') return json(200, { ...BOT, bot: false });
      const at = NOTES.exec(path);
      if (req.method !== 'POST' || !at) return json(404, { error: '404 Not Found' });
      if (at[1] && at[1] !== discussion) return json(404, { message: '404 Discussion Not Found' });
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}
      if (typeof body.body !== 'string') return json(400, { error: 'body is missing' });
      const wrong = !body.body.trim() ? "can't be blank" : characters(body.body) > LIMIT ? `is too long (maximum is ${LIMIT} characters)` : null;
      if (wrong) return json(400, { message: `400 Bad request - Note {:note=>["${wrong}"]}` });
      calls.push({ method: req.method, path, body });
      const now = new Date().toISOString();
      // A comment in a thread is a "DiscussionNote"; one on the issue itself has no type.
      return json(201, {
        id: ++n,
        type: at[1] ? 'DiscussionNote' : null,
        body: body.body,
        author: BOT,
        created_at: now,
        updated_at: now,
        system: false,
        noteable_id: ISSUE.id,
        noteable_type: 'Issue',
        project_id: PROJECT.id,
        noteable_iid: ISSUE.iid,
        resolvable: false,
        confidential: false,
        internal: false,
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  /**
   * What GitLab sends for a new comment. It signs each one as Standard Webhooks
   * does: an HMAC-SHA256, keyed with the signing token's 32 bytes, over the
   * delivery's ID, its time and the body, in `webhook-signature` after `v1,`.
   */
  const delivery = (payload, token) => {
    const body = JSON.stringify(payload);
    const id = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(token.slice('whsec_'.length), 'base64');
    return new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'GitLab/19.0.0',
        'x-gitlab-event': 'Note Hook',
        'x-gitlab-instance': WEB,
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`,
      },
      body,
    });
  };
  /**
   * Ada's comment, with the bot mentioned as GitLab has it: `@` and its username, in the comment's own text.
   * Her first is a comment on the issue, which starts the conversation. The bot answers in a thread under it,
   * and what she writes next is a reply in that thread: the same discussion, so the same conversation.
   */
  const written = (text) => {
    const first = !discussion;
    discussion ??= createHash('sha1').update(randomUUID()).digest('hex');
    const id = ++n;
    const now = stamp(new Date().toISOString());
    return {
      object_kind: 'note',
      event_type: 'note',
      user: ADA,
      project_id: PROJECT.id,
      project: PROJECT,
      object_attributes: {
        id,
        note: `@${BOT.username} ${text}`,
        noteable_type: 'Issue',
        noteable_id: ISSUE.id,
        author_id: ADA.id,
        project_id: PROJECT.id,
        created_at: now,
        updated_at: now,
        system: false,
        internal: false,
        confidential: false,
        discussion_id: discussion,
        type: first ? null : 'DiscussionNote',
        action: 'create',
        url: `${PROJECT.web_url}/-/issues/${ISSUE.iid}#note_${id}`,
      },
      issue: { ...ISSUE, project_id: PROJECT.id, author_id: ADA.id, state: 'opened', confidential: false },
    };
  };

  return {
    adapter: { token: TOKEN, webhookSigningToken: SIGNING_TOKEN, apiUrl: `http://127.0.0.1:${server.address().port}/api/v4` },
    person: { id: String(ADA.id), name: ADA.name },
    maxTextLength: LIMIT,
    message: (text) => delivery(written(text), SIGNING_TOKEN),
    // Signed, but with a token that isn't the webhook's.
    forged: (text) => delivery(written(text), SOMEBODY_ELSES),
    sent() {
      // Every comment GitLab took. GitLab has no buttons: a comment is its text, and nothing else.
      return calls.splice(0).map((call) => ({ text: read(call.body.body), buttons: [], raw: call }));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
