// A stand-in for WhatsApp's Cloud API (Meta's Graph API), as a server on this
// machine: the real WhatsApp adapter talks to it as it talks to Meta. It
// answers the calls a business number makes, records the messages it sends,
// and builds what Meta sends a business: a person's message, and a tap on a
// reply button.
//
// The adapter is pointed here by its own settings: `apiUrl` (where it calls;
// it adds the API's version and the number's ID), `accessToken` (what it
// proves itself with), `phoneNumberId` (the number it sends from) and
// `appSecret` (the key Meta signs every webhook with). `verifyToken` answers
// Meta's one GET when the webhook address is first given: the adapter won't
// start without it, and no test here sends that GET.
import { createHmac } from 'node:crypto';
import http from 'node:http';

// Made up, and put together from parts so that none reads as a real key.
const made = (...parts) => ['made', 'up', ...parts].join('-');
const ACCESS_TOKEN = made('whatsapp', 'access', 'token');
const APP_SECRET = made('meta', 'app', 'secret');
const VERIFY_TOKEN = made('verify', 'token');
const PHONE_NUMBER_ID = '100200300400501';
const ACCOUNT_ID = '100200300400502';
const BUSINESS_NUMBER = '12025550100';
const ADA = { wa_id: '12025550143', name: 'Ada Lovelace' };
const URL_ = 'https://bot.example.com/api/whatsapp';
/** WhatsApp takes 4,096 characters in a text message: it refuses a longer one. */
const LIMIT = 4096;
/** A message with reply buttons has three at most, each with a label of 20 characters and an ID of 256. */
const MAX_BUTTONS = 3;
const MAX_LABEL = 20;
const MAX_BUTTON_ID = 256;
/** An interactive message's body, and a picture's caption, take 1,024 characters; a header or footer 60. */
const MAX_BODY = 1024;
const MAX_HEADER = 60;
/** The kinds of message the Cloud API sends. One that names no kind is a text. */
const KINDS = ['text', 'interactive', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'template', 'reaction'];

/** A refusal in the Graph API's envelope. The codes are WhatsApp's; `details`, which says what part it was, is worded here. */
const refusal = (code, message, details) => ({
  error: {
    message: `(#${code}) ${message}`,
    type: 'OAuthException',
    code,
    ...(details ? { error_data: { messaging_product: 'whatsapp', details } } : {}),
    fbtrace_id: 'MadeUpTrace',
  },
});
const invalid = (details) => refusal(131009, 'Parameter value is not valid', details);

/** What WhatsApp answers a message it won't take, or `null` for one it takes. */
function refused(body) {
  const over = (name, value, max) => (String(value ?? '').length > max ? refusal(100, `Param ${name} must be at most ${max} characters long.`) : null);
  if (!body.to && !body.recipient) return refusal(100, 'The parameter to is required.');
  const kind = body.type ?? 'text';
  if (!KINDS.includes(kind)) return refusal(100, 'Invalid parameter', `No message is of type ${kind}`);
  if (kind === 'text') {
    if (!body.text?.body) return refusal(100, "The parameter text['body'] is required.");
    return over("text['body']", body.text.body, LIMIT);
  }
  if (kind === 'interactive') {
    const { type, header, body: main, footer, action } = body.interactive ?? {};
    if (!main?.text) return refusal(100, "The parameter interactive['body']['text'] is required.");
    const long =
      over("interactive['body']['text']", main.text, MAX_BODY) ??
      over("interactive['header']['text']", header?.text, MAX_HEADER) ??
      over("interactive['footer']['text']", footer?.text, MAX_HEADER);
    if (long || type !== 'button') return long;
    const replies = (action?.buttons ?? []).map((button) => button.reply ?? {});
    if (replies.length < 1 || replies.length > MAX_BUTTONS)
      return invalid(`Invalid buttons count. Min allowed buttons: 1, Max allowed buttons: ${MAX_BUTTONS}`);
    for (const key of ['title', 'id']) {
      const max = key === 'title' ? MAX_LABEL : MAX_BUTTON_ID;
      const values = replies.map((reply) => String(reply[key] ?? ''));
      if (values.some((value) => value.length < 1 || value.length > max)) return invalid(`Button ${key} length invalid. Min length: 1, Max length: ${max}`);
      if (new Set(values).size < values.length) return invalid(`Every button of a message needs its own ${key}`);
    }
    return null;
  }
  return over(`${kind}['caption']`, body[kind]?.caption, MAX_BODY);
}

/** A message's words as the person reads them: a text's body, an interactive message's header, body and footer, a picture's caption. */
function words(body) {
  if ((body.type ?? 'text') === 'text') return String(body.text?.body ?? '');
  if (body.type === 'interactive')
    return [body.interactive?.header?.text, body.interactive?.body?.text, body.interactive?.footer?.text].filter(Boolean).join('\n');
  return String(body[body.type]?.caption ?? '');
}

/** The labels on a message's buttons: its reply buttons, or the one button that opens a link. */
function labels(body) {
  const { type, action } = body.interactive ?? {};
  if (type === 'button') return (action?.buttons ?? []).map((button) => String(button.reply?.title ?? ''));
  if (type === 'cta_url') return [String(action?.parameters?.display_text ?? '')];
  return [];
}

export async function start() {
  const sent = [];
  /** The messages Meta really delivered: only one of these can be marked as read. */
  const delivered = new Set();
  let n = 500;
  const wamid = () => `wamid.${Buffer.from(`made-up-${++n}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`)
        return json(401, {
          error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190, fbtrace_id: 'MadeUpTrace' },
        });
      // Everything the adapter does in a conversation is one call: a POST to the number's messages, under some version of the API.
      if (req.method !== 'POST' || !new RegExp(`^/v\\d+\\.\\d+/${PHONE_NUMBER_ID}/messages$`).test(req.url ?? '')) {
        return json(400, {
          error: {
            message: 'Unsupported request - method type or object not supported',
            type: 'GraphMethodException',
            code: 100,
            error_subcode: 33,
            fbtrace_id: 'MadeUpTrace',
          },
        });
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}
      if (body.messaging_product !== 'whatsapp') return json(400, refusal(100, 'The parameter messaging_product is required.'));
      // A read receipt, which "typing" rides on: for a message the person sent, and not a message itself.
      if (body.status === 'read')
        return delivered.has(body.message_id)
          ? json(200, { success: true })
          : json(400, refusal(100, 'Invalid parameter', 'Not a message this number received'));
      const no = refused(body);
      if (no) return json(400, no);
      const id = wamid();
      // A reaction lands on a message already there: the person reads nothing new.
      if (body.type !== 'reaction') sent.push({ path: req.url, body, id });
      return json(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // Meta signs the body it sends with the app's secret, and says so in a header: "sha256=" and the HMAC in hex.
  const webhook = (message, secret = APP_SECRET) => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: ACCOUNT_ID,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: BUSINESS_NUMBER, phone_number_id: PHONE_NUMBER_ID },
                contacts: [{ profile: { name: ADA.name }, wa_id: ADA.wa_id }],
                messages: [message],
              },
            },
          ],
        },
      ],
    });
    return new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
      body,
    });
  };
  // Every WhatsApp conversation is one person and the business, so the bot answers whatever is written: no mention.
  const from = (more) => ({ from: ADA.wa_id, id: wamid(), timestamp: String(Math.floor(Date.now() / 1000)), ...more });
  const written = (text) => from({ type: 'text', text: { body: text } });
  const deliver = (message) => {
    delivered.add(message.id);
    return webhook(message);
  };

  return {
    adapter: {
      accessToken: ACCESS_TOKEN,
      appSecret: APP_SECRET,
      phoneNumberId: PHONE_NUMBER_ID,
      verifyToken: VERIFY_TOKEN,
      apiUrl: `http://127.0.0.1:${server.address().port}`,
    },
    person: { id: ADA.wa_id, name: ADA.name },
    maxTextLength: LIMIT,
    message: (text) => deliver(written(text)),
    // Signed, but with a key that isn't the app's: what anyone who knows the address can send.
    forged: (text) => webhook(written(text), made('somebody', 'elses', 'secret')),
    sent() {
      return sent.splice(0).map((call) => ({ text: words(call.body), buttons: labels(call.body), raw: call }));
    },
    click(item, label) {
      const button = (item.raw.body.interactive?.action?.buttons ?? []).find((b) => b.reply?.title === label);
      if (!button) throw new Error(`That message has no "${label}" button to tap.`);
      // A tap comes back as a message of the person's own: the button's ID and label, and which message it was on.
      return deliver(
        from({
          context: { from: BUSINESS_NUMBER, id: item.raw.id },
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: button.reply.id, title: button.reply.title } },
        }),
      );
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
