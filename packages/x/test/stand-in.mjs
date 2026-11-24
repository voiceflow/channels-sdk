// A stand-in for X's API, as a server on this machine: the real X adapter
// talks to it as it talks to X. It answers the calls a bot account makes,
// records the direct messages the bot sends, and builds what X sends a bot:
// an account-activity event for a person's direct message, signed as X signs.
//
// The conversation is a direct message, the simplest place the bot answers
// every message: in public it answers only a post that mentions it.
//
// X also checks a webhook's address itself, when it is registered and every
// hour after: a GET with a `crc_token` to sign. The adapter answers that, and
// no test here asks it, so this builds none.
//
// The adapter is pointed here by its own settings: `apiBaseUrl` (where it
// calls), `consumerSecret` (the app's secret X signs every event with) and
// `userAccessToken` (a static token for the bot account, sent with each call).
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';

// Made up, and put together from parts so that no one piece reads as a real key.
const CONSUMER_SECRET = ['made', 'up', 'x', 'consumer', 'secret'].join('-');
const SOMEONE_ELSES_SECRET = ['not', 'the', 'apps', 'consumer', 'secret'].join('-');
const ACCESS_TOKEN = ['made', 'up', 'x', 'user', 'access', 'token'].join('-');
const BOT = { id: '900000000000000001', name: 'Acme Support', username: 'acme_support' };
const ADA = { id: '900000000000000002', name: 'Ada Lovelace', username: 'ada' };
const URL_ = 'https://bot.example.com/api/x';
/** X takes 10,000 characters in a direct message: it refuses a longer one. */
const LIMIT = 10000;

/** X signs an event with the app's consumer secret: an HMAC-SHA256 of the body as sent, in base64, after `sha256=`. */
const signature = (body, secret) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('base64')}`;

/** A conversation between two people is named by both their IDs, the lower first. */
const conversationOf = (a, b) => (BigInt(a) < BigInt(b) ? `${a}-${b}` : `${b}-${a}`);

export async function start() {
  const calls = [];
  let n = 500;
  const id = () => `90000000000000${++n}`;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      const problem = (status, title, detail) => json(status, { title, detail, type: 'about:blank', status });
      const invalid = (message) =>
        json(400, {
          errors: [{ message }],
          title: 'Invalid Request',
          detail: 'One or more parameters to your request was invalid.',
          type: 'https://api.twitter.com/2/problems/invalid-request',
        });
      // Every call is the bot account's, by its token.
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return problem(401, 'Unauthorized', 'Unauthorized');
      const { pathname } = new URL(req.url ?? '/', 'http://x');
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}

      // At start-up the adapter asks who the bot is: its ID tells the bot's own messages from a person's.
      if (req.method === 'GET' && pathname === '/2/users/me') return json(200, { data: BOT });

      // A direct message to one person, named in the address by their ID.
      const to = /^\/2\/dm_conversations\/with\/(\d+)\/messages$/.exec(pathname);
      if (req.method === 'POST' && to) {
        // Only Ada is on this X: a message to anyone else has nobody to read it.
        if (to[1] !== ADA.id) return problem(404, 'Not Found', `Could not find user with id: [${to[1]}].`);
        const hasText = typeof body.text === 'string' && body.text.length > 0;
        if (!hasText && !body.attachments?.length) return invalid('A message needs text or an attachment.');
        if (hasText && body.text.length > LIMIT) return invalid(`The text of a direct message can be at most ${LIMIT} characters.`);
        // Only what X took is a message the person sees.
        calls.push({ method: req.method, path: pathname, to: to[1], body });
        return json(201, { data: { dm_conversation_id: conversationOf(BOT.id, to[1]), dm_event_id: id() } });
      }

      // Nothing else is part of a conversation in direct messages (a public post, a like, a picture's upload).
      return problem(404, 'Not Found', `This stand-in has no ${req.method} ${pathname}.`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  /** What X sends when a person writes to the bot: a `dm.received` event with the message, and who is in it. */
  const event = (text, secret) => {
    const body = JSON.stringify({
      data: {
        event_type: 'dm.received',
        event_uuid: randomUUID(),
        filter: { user_id: BOT.id },
        tag: 'made-up',
        payload: {
          direct_message_events: [
            {
              type: 'message_create',
              id: id(),
              created_timestamp: String(Date.now()),
              message_create: {
                target: { recipient_id: BOT.id },
                sender_id: ADA.id,
                message_data: { text, entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] } },
              },
            },
          ],
          users: { [ADA.id]: { data: ADA }, [BOT.id]: { data: BOT } },
        },
      },
    });
    return new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twitter-webhooks-signature': signature(body, secret) },
      body,
    });
  };

  return {
    adapter: { apiBaseUrl: `http://127.0.0.1:${server.address().port}`, consumerSecret: CONSUMER_SECRET, userAccessToken: ACCESS_TOKEN },
    person: { id: ADA.id, name: ADA.name },
    maxTextLength: LIMIT,
    message: (text) => event(text, CONSUMER_SECRET),
    // Signed, and well, but with a secret that isn't the app's: what anyone who knows the address could send.
    forged: (text) => event(text, SOMEONE_ELSES_SECRET),
    sent() {
      // A direct message is plain text, read as it was sent, and X has no buttons to put on one.
      return calls.splice(0).map((call) => ({ text: String(call.body.text ?? ''), buttons: [], raw: call }));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
