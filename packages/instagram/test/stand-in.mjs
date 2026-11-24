// A stand-in for Instagram's messaging API (Meta's Graph API, at
// graph.instagram.com), as a server on this machine: the real Instagram
// adapter talks to it as it talks to Instagram. It answers the calls a bot
// makes, records what the bot sends, and builds what Instagram sends a bot: a
// person's direct message, signed with the app's secret.
//
// The adapter has no setting for where it calls: Instagram's address is fixed
// in its code (GRAPH_API_BASE), and only the version after it can be set. So
// while a stand-in is up, `fetch` is wrapped for that one host, and a call to
// it comes here. Every other call goes on as it did. `close()` puts `fetch`
// back. The rest is the adapter's own settings: `accessToken` (what the bot
// proves itself with), `accountId` (the Instagram account the bot answers as),
// `appSecret` (what Instagram signs with) and `verifyToken` (what Instagram
// says back when a person enters the webhook's address on Meta's pages).
import { createHmac } from 'node:crypto';
import http from 'node:http';

const HOST = 'graph.instagram.com';
const APP_SECRET = ['made', 'up', 'instagram', 'app', 'secret'].join('-');
const VERIFY_TOKEN = ['made', 'up', 'verify', 'token'].join('-');
const ACCOUNT = { id: '2002', name: 'Acme Support', username: 'acme_support', profile_picture_url: 'https://cdn.example.com/acme.jpg' };
const ADA = { id: '1001', name: 'Ada Lovelace', username: 'ada', profile_pic: 'https://cdn.example.com/ada.jpg' };
const URL_ = 'https://bot.example.com/api/instagram';
/** Instagram takes 1,000 bytes of text in a message, counted as UTF-8, and 13 quick replies: it refuses more. */
const LIMIT = 1000;
const MAX_QUICK_REPLIES = 13;
/** What can be asked about an account, and about a person who wrote to it, as Instagram's reference lists them: it refuses a field the one asked about doesn't have. */
const FIELDS = {
  account: ['id', 'user_id', 'name', 'username', 'account_type', 'profile_picture_url'],
  person: ['id', 'name', 'username', 'profile_pic', 'is_verified_user'],
};

/**
 * The stand-ins that are up, each by its bot's access token. Instagram is one
 * address for every bot, and the token says whose call it is: two stand-ins
 * up at once (a test starts one to ask its limit, then another) each get
 * their own bot's calls.
 */
const up = new Map();
let started = 0;
/** `fetch` as it was before the first stand-in came up. */
let before = null;

/** A call to Instagram's address goes to the stand-in of the bot that made it. Any other call goes on untouched. */
function redirected(input, init) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== HOST || !up.size) return before(input, init);
  const token = /^Bearer (.+)$/.exec(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization') ?? '')?.[1];
  // A token no stand-in knows still gets an answer: the refusal Instagram gives it.
  const port = up.get(token) ?? [...up.values()].at(-1);
  const here = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
  return before(input instanceof Request ? new Request(here, input) : here, init);
}

/** A refusal as the Graph API words one: what was wrong, in `error`, with a status of 400. Its words start with the number, except for a token it doesn't know. */
const refusal = (code, message, more = {}) => ({
  error: {
    message: code === 190 ? message : `(#${code}) ${message}`,
    type: code === 190 ? 'OAuthException' : 'IGApiException',
    code,
    ...more,
    fbtrace_id: 'made-up',
  },
});

/** A message's words as a person reads them. A template's are its title and the line under it. */
function read(message) {
  const template = message.attachment?.type === 'template' ? message.attachment.payload : null;
  if (!template) return String(message.text ?? '');
  if (template.template_type === 'button') return String(template.text ?? '');
  return (template.elements ?? [])
    .flatMap((element) => [element.title, element.subtitle])
    .filter(Boolean)
    .join('\n');
}

/** The labels of what can be tapped: quick replies under a message, and a template's own buttons. */
function buttons(message) {
  const template = message.attachment?.type === 'template' ? message.attachment.payload : null;
  const own = template ? [...(template.buttons ?? []), ...(template.elements ?? []).flatMap((element) => element.buttons ?? [])] : [];
  return [...own, ...(message.quick_replies ?? [])].map((button) => button.title);
}

export async function start() {
  const accessToken = ['made', 'up', 'instagram', 'access', 'token', ++started].join('-');
  const calls = [];
  let n = 500;
  // Instagram lets a bot write only to a person who wrote to it in the last 24 hours.
  let wrote = false;

  /** Instagram's answer to one call: a status, and the JSON it says. */
  function answer(method, path, fields, body) {
    const at = /^\/v\d+\.\d+\/(\w+)(?:\/(\w+))?$/.exec(path);
    if (!at) return [400, refusal(100, 'Unsupported request')];
    const [, id, edge] = at;
    const account = id === ACCOUNT.id || id === 'me';
    if (method === 'GET' && !edge) {
      const node = account ? ACCOUNT : id === ADA.id ? ADA : null;
      if (!node) return [400, refusal(100, `Unsupported get request. Object with ID '${id}' does not exist`, { error_subcode: 33 })];
      const asked = fields ? fields.split(',') : ['id'];
      const unknown = asked.find((field) => !FIELDS[account ? 'account' : 'person'].includes(field));
      if (unknown) return [400, refusal(100, `Tried accessing nonexisting field (${unknown})`)];
      // The ID comes back whether or not it was asked for.
      return [200, Object.fromEntries([...asked, 'id'].filter((field) => field in node).map((field) => [field, node[field]]))];
    }
    if (method !== 'POST' || !account) return [400, refusal(100, 'Unsupported request')];
    // A file given to Instagram ahead of a message that shows it.
    if (edge === 'message_attachments') return [200, { attachment_id: `made-up-attachment-${++n}` }];
    if (edge !== 'messages') return [400, refusal(100, 'Unsupported request')];
    if (body.recipient?.id !== ADA.id) return [400, refusal(100, 'No matching user found', { error_subcode: 2018001 })];
    if (!wrote) return [400, refusal(10, 'This message is sent outside of allowed window.', { error_subcode: 2534022 })];
    // "Typing…" and "seen": shown to the person, and no message.
    if (body.sender_action) return [200, { recipient_id: ADA.id }];
    const message = body.message;
    if (!message || typeof message !== 'object') return [400, refusal(100, 'The parameter message is required')];
    if (Buffer.byteLength(String(message.text ?? ''), 'utf8') > LIMIT)
      return [400, refusal(100, `Length of param message[text] must be less than or equal to ${LIMIT}`)];
    if ((message.quick_replies ?? []).length > MAX_QUICK_REPLIES)
      return [400, refusal(100, `Param message[quick_replies] has too many elements: the most is ${MAX_QUICK_REPLIES}`)];
    if (!message.attachment && !String(message.text ?? '').trim()) return [400, refusal(100, 'The parameter message[text] or message[attachment] is required')];
    return [200, { recipient_id: ADA.id, message_id: `made-up-mid-${++n}` }];
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}
      const known = req.headers.authorization === `Bearer ${accessToken}`;
      const [status, value] = known
        ? answer(req.method, url.pathname, url.searchParams.get('fields'), body)
        : [400, refusal(190, 'Invalid OAuth access token - Cannot parse access token')];
      calls.push({ method: req.method, path: url.pathname, body, status });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (!up.size) {
    before = globalThis.fetch;
    globalThis.fetch = redirected;
  }
  up.set(accessToken, server.address().port);

  /**
   * What Instagram posts to a bot's webhook. It writes every character outside
   * ASCII as \uXXXX, and signs those bytes with the app's secret: the
   * signature goes in a header, as hex.
   */
  const post = (event, secret = APP_SECRET) => {
    const json = JSON.stringify({ object: 'instagram', entry: [{ time: Date.now(), id: ACCOUNT.id, messaging: [event] }] });
    const body = json.replace(/[\u0080-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}` },
      body,
    });
  };
  // Instagram says who wrote by ID alone: a name is asked for separately, in a call of the bot's own.
  const written = (text) => ({ sender: { id: ADA.id }, recipient: { id: ACCOUNT.id }, timestamp: Date.now(), message: { mid: `made-up-mid-${++n}`, text } });

  return {
    adapter: { accessToken, accountId: ACCOUNT.id, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
    // No name: the adapter gives the person's ID where their name would be, and never asks Instagram for it.
    person: { id: ADA.id },
    maxTextLength: LIMIT,
    // Instagram shows text as it was sent: Markdown's marks would be read as asterisks and brackets.
    literal: true,
    message(text) {
      wrote = true;
      return post(written(text));
    },
    // Signed, but by somebody who doesn't have the app's secret.
    forged: (text) => post(written(text), ['somebody', 'elses', 'secret'].join('-')),
    sent() {
      // A message Instagram refused never reached the person: it isn't one the bot sent.
      return calls
        .splice(0)
        .filter((call) => call.method === 'POST' && /\/messages$/.test(call.path) && call.status === 200 && call.body.message)
        .map((call) => ({ text: read(call.body.message), buttons: buttons(call.body.message), raw: call }));
    },
    close: () =>
      new Promise((resolve) => {
        up.delete(accessToken);
        if (!up.size && globalThis.fetch === redirected) globalThis.fetch = before;
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
