// A stand-in for Google Chat, as a server on this machine: the real Google Chat
// adapter talks to it as it talks to Google. It answers what a Chat app reaches
// Google for (an access token for its service account, the Chat API's calls,
// the certificates Google Chat signs with), records what the bot sends, and
// builds what Google Chat sends a bot: a person's message in a direct message,
// where a Chat app is sent every message and needs no mention, and a click on
// a card's button.
//
// The adapter is pointed here by its own settings: `apiUrl` (where it calls the
// Chat API), `auth` (how it signs in: Google's own service-account client for a
// made-up account, whose request for a token is sent here) and
// `googleChatProjectNumber` (who Google Chat signs its requests for). One call
// no setting moves: the adapter fetches Google Chat's certificates from a fixed
// address with `fetch`. While a stand-in is open, `fetch` is wrapped for that
// one address, and it is put back when the last stand-in closes.
import { createHash, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { auth } from '@googleapis/chat';

const URL_ = 'https://bot.example.com/api/gchat';
const PROJECT_NUMBER = '100200300400';
const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const CERTS_PATH = `/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;
const CERTS_URL = `https://www.googleapis.com${CERTS_PATH}`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCOUNT = 'acme-support@made-up-project.iam.gserviceaccount.com';
const BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';
const SPACE = {
  name: 'spaces/AAAAmadeUp1',
  type: 'DM',
  singleUserBotDm: true,
  spaceThreadingState: 'UNTHREADED_MESSAGES',
  spaceType: 'DIRECT_MESSAGE',
  spaceHistoryState: 'HISTORY_ON',
};
const ADA = { name: 'users/100000000000000001001', displayName: 'Ada Lovelace', email: 'ada@example.com', type: 'HUMAN', domainId: 'made-up' };
const BOT = { name: 'users/100000000000000002002', displayName: 'Acme Support', type: 'BOT' };
/** Google Chat takes 4,096 characters of text in a message, and 32,000 bytes for a whole message, cards and all: it refuses more. */
const LIMIT = 4096;
const BYTES = 32000;

// Three made-up keys, made as the tests start: Google Chat's, which signs what it sends a bot; the bot's service
// account's, which signs its request for a token; and a stranger's, for a request that isn't Google's.
const key = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const GOOGLE = key();
const BOT_KEY = key();
const STRANGER = key();

// Google publishes the key it signs with as an X.509 certificate, under a key ID. This is as much of DER as one takes.
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const length = body.length < 128 ? [body.length] : body.length < 256 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 255];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const seq = (...parts) => der(0x30, ...parts);
const SHA256_RSA = seq(der(0x06, Buffer.from('2a864886f70d01010b', 'hex')), der(0x05));
const named = (name) => seq(der(0x31, seq(der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from(name)))));
/** A time as a certificate writes it: 261124153217Z. */
function time(ms) {
  const digits = new Date(ms).toISOString().replace(/\D/g, '');
  return der(0x17, Buffer.from(`${digits.slice(2, 14)}Z`));
}
function certificate({ publicKey, privateKey }, name) {
  const valid = seq(time(Date.now() - 86_400_000), time(Date.now() + 30 * 86_400_000));
  const body = seq(der(0x02, Buffer.from([1])), SHA256_RSA, named(name), valid, named(name), publicKey.export({ type: 'spki', format: 'der' }));
  const whole = seq(body, SHA256_RSA, der(0x03, Buffer.from([0]), createSign('RSA-SHA256').update(body).sign(privateKey)));
  const lines = whole
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return { kid: createHash('sha1').update(whole).digest('hex'), pem: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n` };
}
const CERT = certificate(GOOGLE, CHAT_ISSUER);

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/**
 * What Google Chat proves itself with, in the Authorization header of every request: a token for the bot's project
 * number, signed with Chat's own key. A forged one says the same and is signed with a key that isn't Google's.
 */
function bearer(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: 'RS256', kid: CERT.kid, typ: 'JWT' })}.${b64({ aud: PROJECT_NUMBER, exp: now + 3600, iat: now, iss: CHAT_ISSUER })}`;
  return `${signed}.${createSign('RSA-SHA256').update(signed).sign(privateKey, 'base64url')}`;
}

/** Whether Google's token endpoint grants a service account's request: one its key signed, for this endpoint, to act as a Chat app. */
function granted(form) {
  const [head, claims, signature] = String(form.get('assertion') ?? '').split('.');
  if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !signature) return false;
  if (!createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(BOT_KEY.publicKey, signature, 'base64url')) return false;
  const { iss, aud, exp, scope } = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  return iss === ACCOUNT && aud === TOKEN_URL && exp > Date.now() / 1000 && String(scope).split(' ').includes(BOT_SCOPE);
}

const widgetsOf = (card) => (card?.sections ?? []).flatMap((section) => section.widgets ?? []);
const buttonsOf = (body) => (body.cardsV2 ?? []).flatMap((entry) => widgetsOf(entry.card)).flatMap((widget) => widget.buttonList?.buttons ?? []);
/** A message as a person reads it: its text, then each card's title and paragraphs, a line each. A button's label is not text. */
const read = (body) =>
  [
    body.text,
    ...(body.cardsV2 ?? []).flatMap(({ card }) => [
      card?.header?.title,
      card?.header?.subtitle,
      ...widgetsOf(card).flatMap((widget) => [widget.textParagraph?.text, widget.decoratedText?.topLabel, widget.decoratedText?.text]),
    ]),
  ]
    .filter(Boolean)
    .join('\n');

// The stand-ins open now. A fetch of Google Chat's certificates is answered by the newest; every other fetch goes
// on as it was.
const open = [];
let fetchBefore;
function bringCertificatesTo(base) {
  if (!open.length) {
    fetchBefore = globalThis.fetch;
    globalThis.fetch = (input, init) => fetchBefore(String(input?.url ?? input) === CERTS_URL ? `${open.at(-1)}${CERTS_PATH}` : input, init);
  }
  open.push(base);
}
function letGo(base) {
  if (!open.includes(base)) return;
  open.splice(open.indexOf(base), 1);
  if (!open.length) globalThis.fetch = fetchBefore;
}

export async function start() {
  const calls = [];
  const tokens = new Set();
  const messages = new Map();
  let n = 500;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const sent = Buffer.concat(chunks);
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify(value));
      };
      // Google's errors have one shape. The words here are the stand-in's own.
      const refuse = (code, status, message) => json(code, { error: { code, message, status } });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === CERTS_PATH) return json(200, { [CERT.kid]: CERT.pem });
      if (req.method === 'POST' && url.pathname === '/token') {
        if (!granted(new URLSearchParams(sent.toString('utf8')))) return json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        const token = `made-up-access-token-${++n}`;
        tokens.add(token);
        return json(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      }
      // The Chat API. Every call carries a token from above, and the bot is in one conversation: Ada's.
      if (!tokens.has(String(req.headers.authorization).replace(/^Bearer /, '')))
        return refuse(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
      const at = /^\/v1\/(spaces\/[\w-]+)\/messages(?:\/([\w.-]+))?$/.exec(url.pathname);
      const edits = (req.method === 'PUT' || req.method === 'PATCH') && messages.has(url.pathname.slice('/v1/'.length));
      if (at?.[1] !== SPACE.name || !(edits || (req.method === 'POST' && !at[2]))) return refuse(404, 'NOT_FOUND', 'Requested entity was not found.');
      let body = {};
      try {
        body = JSON.parse(sent.toString('utf8') || '{}');
      } catch {}
      if (String(body.text ?? '').length > LIMIT || sent.length > BYTES) return refuse(400, 'INVALID_ARGUMENT', 'The message is too long.');
      if (!body.text && !body.cardsV2?.length) return refuse(400, 'INVALID_ARGUMENT', 'Message cannot be empty.');
      // A message in a direct message starts a thread of its own, unless it names one.
      const id = `made-up-${++n}`;
      const thread = body.thread?.name ?? `${SPACE.name}/threads/${id}`;
      const message = edits
        ? { ...messages.get(url.pathname.slice('/v1/'.length)), ...body, lastUpdateTime: new Date().toISOString() }
        : {
            name: `${SPACE.name}/messages/${thread.split('/').at(-1)}.${id}`,
            sender: BOT,
            createTime: new Date().toISOString(),
            ...body,
            thread: { name: thread },
            space: SPACE,
          };
      messages.set(message.name, message);
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, message });
      return json(200, message);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  bringCertificatesTo(base);

  // What Google Chat sends an app built in the Google Cloud console: a Google Workspace add-on's event.
  const event = (chat, { parameters, signedBy = GOOGLE, to = URL_ } = {}) =>
    new Request(to, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', authorization: `Bearer ${bearer(signedBy.privateKey)}` },
      body: JSON.stringify({
        commonEventObject: {
          userLocale: 'en',
          hostApp: 'CHAT',
          platform: 'WEB',
          timeZone: { id: 'Europe/London', offset: 0 },
          ...(parameters ? { parameters } : {}),
        },
        chat: { user: ADA, eventTime: new Date().toISOString(), ...chat },
      }),
    });
  const written = (text) => {
    const id = `made-up-${++n}`;
    const message = {
      name: `${SPACE.name}/messages/${id}.${id}`,
      sender: ADA,
      createTime: new Date().toISOString(),
      text,
      argumentText: text,
      formattedText: text,
      thread: { name: `${SPACE.name}/threads/${id}` },
      space: SPACE,
    };
    return { messagePayload: { message, space: SPACE } };
  };

  return {
    adapter: {
      apiUrl: base,
      // Given a service account's credentials, the adapter makes this client itself, and its request for a token goes
      // to Google at an address no setting moves. Made here instead, the client's own transport sends that request here.
      auth: new auth.JWT({
        email: ACCOUNT,
        key: BOT_KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        scopes: [BOT_SCOPE],
        transporterOptions: { fetchImplementation: (input, init) => fetch(String(input) === TOKEN_URL ? `${base}/token` : input, init) },
      }),
      googleChatProjectNumber: PROJECT_NUMBER,
    },
    person: { id: ADA.name, name: ADA.displayName },
    maxTextLength: LIMIT,
    message: (text) => event(written(text)),
    forged: (text) => event(written(text), { signedBy: STRANGER }),
    sent() {
      return calls
        .splice(0)
        .filter((call) => call.method === 'POST')
        .map((call) => ({ text: read(call.body), buttons: buttonsOf(call.body).map((button) => button.text), raw: call }));
    },
    click(item, label) {
      // Google Chat sends a click to the address the button names, with the button's own parameters and the message
      // it is on. A button that names no address can't be clicked through to a server.
      const action = buttonsOf(item.raw.body).find((button) => button.text === label)?.onClick?.action;
      if (!/^https:\/\//.test(action?.function ?? '')) throw new Error(`The button "${label}" names no address for Google Chat to send its click to.`);
      const parameters = Object.fromEntries((action.parameters ?? []).map(({ key, value }) => [key, value]));
      return event({ buttonClickedPayload: { message: item.raw.message, space: SPACE, isDialogEvent: false } }, { parameters, to: action.function });
    },
    close: () =>
      new Promise((resolve) => {
        letGo(base);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
