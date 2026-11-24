// A stand-in for Messenger, as a server on this machine: the real Messenger
// adapter talks to it as it talks to Meta's Graph API. It answers the calls a
// Page's bot makes (who the Page is, the Send API, a person's profile),
// records what the bot sends, and builds what Meta sends a bot: a person's
// message to the Page, signed with the app's secret.
//
// The adapter has no setting for where it calls: `https://graph.facebook.com`
// is written into it. So while a stand-in runs, `globalThis.fetch` is wrapped
// for that one host, and a call to it goes to this server instead. Every other
// call goes on as it was, and `close()` puts the fetch back.
import { createHmac } from 'node:crypto';
import http from 'node:http';

const GRAPH_HOST = 'graph.facebook.com';
// Made up, and put together from parts so that nothing here reads as a real key.
const APP_SECRET = ['made', 'up', 'messenger', 'app', 'secret'].join('-');
const SOMEONE_ELSES_SECRET = ['made', 'up', 'secret', 'of', 'another', 'app'].join('-');
const PAGE_TOKEN = ['made', 'up', 'page', 'access', 'token'].join('-');
const VERIFY_TOKEN = ['made', 'up', 'verify', 'token'].join('-');
const PAGE = { id: '100200300400500', name: 'Acme Support' };
/** Ada, as the Page knows her: by an ID that is hers for this Page only. A message says no more of her than that. */
const ADA = { id: '7300112233445566', first_name: 'Ada', last_name: 'Lovelace' };
const URL_ = 'https://bot.example.com/api/messenger';
/** Messenger takes 2,000 characters in a message's text: it refuses a longer one. */
const LIMIT = 2000;

/** The stand-ins running now, each by its Page's token, which is how Meta tells one Page's call from another's. */
const running = new Map();
/** The fetch that was there before the first stand-in wrapped it. */
let outer;
let wrapped = false;
let started = 0;

/** `fetch`, with a call to the Graph API sent to the stand-in whose token it carries. A token nobody has goes to the last one started, which refuses it. */
function redirected(input, init) {
  let url;
  try {
    url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  } catch {}
  if (!running.size || url?.hostname !== GRAPH_HOST) return outer(input, init);
  const origin = running.get(url.searchParams.get('access_token')) ?? [...running.values()].at(-1);
  const here = `${origin}${url.pathname}${url.search}`;
  return outer(input instanceof Request ? new Request(here, input) : here, init);
}

/**
 * A body as Meta writes it: every character outside ASCII as `\u` and four lowercase hex digits, and `/` as `\/`.
 * The signature is over these bytes, so an adapter that read the JSON and wrote it again before checking would refuse it.
 */
const wire = (value) =>
  JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u0080-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

const hmac = (algorithm, secret, body) => createHmac(algorithm, secret).update(body, 'utf8').digest('hex');

export async function start() {
  const token = `${PAGE_TOKEN}-${++started}`;
  const calls = [];
  let n = 500;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify(value));
      };
      const refuse = (message, code, more = {}) => json(400, { error: { message, type: 'OAuthException', code, ...more, fbtrace_id: `made-up-trace-${++n}` } });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const given = url.searchParams.get('access_token') ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (given !== token) return refuse('Invalid OAuth access token - Cannot parse access token', 190);
      // The version is in the address (`/v21.0/me/messages`), and the Page can be named `me` or by its ID.
      const node = /^\/v\d+\.\d+\/(.+)$/.exec(url.pathname)?.[1]?.replace(new RegExp(`^${PAGE.id}(?=/|$)`), 'me');
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}

      if (req.method === 'GET' && node === 'me') return json(200, { name: PAGE.name, id: PAGE.id });
      if (req.method === 'GET' && node === ADA.id)
        return json(200, { first_name: ADA.first_name, last_name: ADA.last_name, profile_pic: 'https://example.com/ada.png', id: ADA.id });
      if (req.method === 'POST' && node === 'me/messages') {
        calls.push({ method: req.method, path: node, body });
        // A Page can write only to somebody who has written to it.
        if (body.recipient?.id !== ADA.id) return refuse('(#100) No matching user found', 100, { error_subcode: 2018001 });
        // "Typing" and "seen" are told to the person's app, and are no message.
        if (body.sender_action) return json(200, { recipient_id: ADA.id });
        const text = body.message?.text;
        if (typeof text === 'string' && text.length > LIMIT) return refuse(`(#100) Length of param message[text] must be less than or equal to ${LIMIT}`, 100);
        if (!text && !body.message?.attachment) return refuse('(#100) Message cannot be empty, must provide valid attachment or text', 100);
        return json(200, { recipient_id: ADA.id, message_id: `m_made-up-${++n}` });
      }
      return refuse(
        `Unsupported ${req.method?.toLowerCase()} request. Object with ID '${node}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`,
        100,
        { type: 'GraphMethodException', error_subcode: 33 },
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (!wrapped) {
    outer = globalThis.fetch;
    globalThis.fetch = redirected;
    wrapped = true;
  }
  running.set(token, `http://127.0.0.1:${server.address().port}`);

  // Meta signs the body with the app's secret, and says so twice: with SHA-256, which the adapter checks, and with SHA-1, as it did first.
  const post = (text, secret) => {
    const at = Date.now();
    const body = wire({
      object: 'page',
      entry: [
        {
          id: PAGE.id,
          time: at,
          messaging: [{ sender: { id: ADA.id }, recipient: { id: PAGE.id }, timestamp: at, message: { mid: `m_made-up-${++n}`, text } }],
        },
      ],
    });
    return new Request(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': `sha1=${hmac('sha1', secret, body)}`,
        'x-hub-signature-256': `sha256=${hmac('sha256', secret, body)}`,
      },
      body,
    });
  };

  return {
    adapter: { appSecret: APP_SECRET, pageAccessToken: token, verifyToken: VERIFY_TOKEN },
    // No name: a message carries the person's ID alone, and their name is another call (the profile, above).
    person: { id: ADA.id },
    maxTextLength: LIMIT,
    // Messenger shows text as it was sent: Markdown's marks would be read as asterisks and brackets.
    literal: true,
    message: (text) => post(text, APP_SECRET),
    // Signed, but with a secret that isn't the app's: what anybody who knows the address could send.
    forged: (text) => post(text, SOMEONE_ELSES_SECRET),
    sent() {
      return calls
        .splice(0)
        .filter((call) => call.body.message)
        .map((call) => {
          // Messenger shows a message's text as it was sent, marks and all. A template shows its title, its words and its buttons.
          const { text, attachment } = call.body.message;
          const template = attachment?.type === 'template' ? attachment.payload : undefined;
          const shown = template?.template_type === 'generic' ? (template.elements ?? []) : template ? [template] : [];
          return {
            text: template
              ? shown
                  .flatMap((part) => [part.title, part.subtitle, part.text])
                  .filter(Boolean)
                  .join('\n')
              : String(text ?? ''),
            buttons: shown.flatMap((part) => part.buttons ?? []).map((button) => button.title),
            raw: call,
          };
        });
    },
    close: () =>
      new Promise((resolve) => {
        running.delete(token);
        // Put back only what this put there: a fetch somebody wrapped since stays, and passes everything on.
        if (!running.size && globalThis.fetch === redirected) {
          globalThis.fetch = outer;
          wrapped = false;
        }
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
