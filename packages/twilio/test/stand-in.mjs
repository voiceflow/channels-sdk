// A stand-in for Twilio's Messages API, as a server on this machine: the real
// Twilio adapter talks to it as it talks to Twilio. It answers the one call a
// bot makes in a conversation by text message (create a message), records
// what the bot sends, and builds what Twilio sends a bot: a person's SMS to
// the bot's number, as a signed form.
//
// The adapter is pointed here by its own settings: `apiUrl` (where it calls),
// `accountSid` and `authToken` (who it calls as, and the key Twilio signs
// with) and `webhookUrl` (the address Twilio was given, which is part of what
// it signs: a server behind a proxy or a tunnel is asked at another).
//
// A text message has no buttons, no cards and no "typing": a choice reaches
// the person as a numbered list, and they answer with the number.
import { createHmac } from 'node:crypto';
import http from 'node:http';

// Both made up, and put together from parts so that neither reads as a real key: an account's SID is "AC" and
// 32 hex characters, its auth token 32 hex characters.
const ACCOUNT_SID = `AC${'feed'.repeat(8)}`;
const AUTH_TOKEN = `${'c0ffee'.repeat(5)}c0`;
/** Somebody else's auth token: what a request that isn't Twilio's would be signed with. */
const OTHER_TOKEN = `${'decaf0'.repeat(5)}de`;
/** The bot's number and a person's, both from the numbers kept for stories (555-01xx). */
const BOT = '+12025550100';
const ADA = '+12025550143';
const URL_ = 'https://bot.example.com/api/twilio';
const API = '2010-04-01';
/** Twilio takes 1,600 characters in a message's body: it refuses a longer one. */
const LIMIT = 1600;

/** How many SMS a text travels as: one of up to 160 characters, else pieces of 153. */
const segments = (text) => String(text.length <= 160 ? 1 : Math.ceil(text.length / 153));
/** A time as Twilio writes one: "Tue, 24 Nov 2026 10:15:00 +0000". */
const stamp = () => new Date().toUTCString().replace('GMT', '+0000');

export async function start() {
  const accepted = [];
  let n = 500;
  /** A message's ID: "SM" and 32 hex characters, for one sent and one received alike. */
  const sid = () => `SM${String(++n).padStart(32, '0')}`;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      // A refusal as Twilio words one: its own error code, a line about it, and the status again.
      const refuse = (status, code, message) => json(status, { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status });
      const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Every call is made as the account: its SID and its auth token, as HTTP Basic.
      if (req.headers.authorization !== `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`) return refuse(401, 20003, 'Authenticate');
      if (req.method !== 'POST' || pathname !== `/${API}/Accounts/${ACCOUNT_SID}/Messages.json`)
        return refuse(404, 20404, `The requested resource ${pathname} was not found`);
      // A message is a form. Sent as anything else, Twilio finds no fields in it.
      const isForm = /^application\/x-www-form-urlencoded\b/.test(req.headers['content-type'] ?? '');
      const form = new URLSearchParams(isForm ? Buffer.concat(chunks).toString('utf8') : '');
      // A picture goes by its address, and a message can carry several: `MediaUrl` once for each.
      const body = { ...Object.fromEntries(form), ...(form.has('MediaUrl') ? { MediaUrl: form.getAll('MediaUrl') } : {}) };
      const text = body.Body ?? '';
      if (!body.To) return refuse(400, 21604, "A 'To' phone number is required.");
      if (!body.From) return refuse(400, 21603, "A 'From' phone number is required.");
      // A bot texts from a number its account holds: here, the one the person wrote to.
      if (body.From !== BOT)
        return refuse(400, 21606, `The From phone number ${body.From} is not a valid, SMS-capable inbound phone number or short code for your account.`);
      if (!text && !body.MediaUrl) return refuse(400, 21619, 'A text message body or media urls must be specified.');
      if (text.length > LIMIT) return refuse(400, 21617, `The concatenated message body exceeds the ${LIMIT} character limit.`);
      // Only what Twilio took is kept: a message it refused reached nobody.
      accepted.push({ method: req.method, path: pathname, body });
      const id = sid();
      const now = stamp();
      return json(201, {
        sid: id,
        account_sid: ACCOUNT_SID,
        api_version: API,
        body: text,
        from: body.From,
        to: body.To,
        direction: 'outbound-api',
        status: 'queued',
        num_segments: segments(text),
        num_media: String(body.MediaUrl?.length ?? 0),
        messaging_service_sid: null,
        date_created: now,
        date_updated: now,
        date_sent: null,
        error_code: null,
        error_message: null,
        price: null,
        price_unit: 'USD',
        uri: `/${API}/Accounts/${ACCOUNT_SID}/Messages/${id}.json`,
        subresource_uris: { media: `/${API}/Accounts/${ACCOUNT_SID}/Messages/${id}/Media.json` },
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  /**
   * Twilio's signature, which it sends as `X-Twilio-Signature`: the address it was given, then every field's
   * name and value in the names' order with nothing between them, as an HMAC-SHA1 under the account's auth
   * token, in base64.
   */
  const signature = (fields, token) =>
    createHmac('sha1', token)
      .update(
        URL_ +
          Object.keys(fields)
            .sort()
            .map((name) => name + fields[name])
            .join(''),
      )
      .digest('base64');
  /** An SMS from the person to the bot's number, as Twilio posts one to the address it was given. */
  const texted = (text, token = AUTH_TOKEN, { at = URL_, headers = {} } = {}) => {
    const id = sid();
    const fields = {
      AccountSid: ACCOUNT_SID,
      ApiVersion: API,
      Body: text,
      From: ADA,
      FromCountry: 'US',
      MessageSid: id,
      NumMedia: '0',
      NumSegments: segments(text),
      SmsMessageSid: id,
      SmsSid: id,
      SmsStatus: 'received',
      To: BOT,
      ToCountry: 'US',
    };
    return new Request(at, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-twilio-signature': signature(fields, token), ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  };

  return {
    adapter: { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, apiUrl: `http://127.0.0.1:${server.address().port}`, webhookUrl: URL_ },
    // A text message says who it is from by their number, and gives no name.
    person: { id: ADA },
    maxTextLength: LIMIT,
    // A text message shows text as it was sent: Markdown's marks would be read as asterisks and brackets.
    literal: true,
    message: (text) => texted(text),
    /** The address Twilio was given, and signs for. */
    url: URL_,
    /**
     * The same message as it reaches a server behind a tunnel or a proxy: signed for the public address, and
     * arriving at the server's own, with what the proxy says of the request it passed on.
     */
    proxied: (text, at, headers) => texted(text, AUTH_TOKEN, { at, headers }),
    // The same message, signed with a token that isn't the account's.
    forged: (text) => texted(text, OTHER_TOKEN),
    sent() {
      // An SMS shows its body as it was sent, every character: there is no formatting to read through.
      return accepted.splice(0).map((call) => ({ text: call.body.Body ?? '', buttons: [], raw: call }));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
