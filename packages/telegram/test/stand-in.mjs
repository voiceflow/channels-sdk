// A stand-in for Telegram's Bot API, as a server on this machine: the real
// Telegram adapter talks to it as it talks to Telegram. It answers the calls a
// bot makes, records what the bot sends, and builds what Telegram sends a bot:
// a person's message in a private chat, and a click on a button.
//
// The adapter is pointed here by its own settings: `apiUrl` (where it calls),
// `secretToken` (what Telegram proves itself with, in a header) and
// `mode: 'webhook'` (so it waits to be sent updates and never polls for them).
import http from 'node:http';

const BOT_TOKEN = '110201543:made-up-telegram-bot-token';
const SECRET = 'made-up-webhook-secret';
const ADA = { id: 1001, is_bot: false, first_name: 'Ada', last_name: 'Lovelace', username: 'ada' };
const URL_ = 'https://bot.example.com/api/telegram';
/** Telegram takes 4,096 characters in a message of text, and 32,768 in a "rich message": it refuses a longer one. */
const LIMIT = 4096;
const RICH_LIMIT = 32768;

/** A message's text as a person reads it: Telegram's MarkdownV2 puts a backslash before every mark. */
const read = (text, mode) => (mode === 'MarkdownV2' ? String(text ?? '').replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1') : String(text ?? ''));

export async function start() {
  const calls = [];
  let n = 500;
  /** The bot's webhook, as setWebhook left it: none until then. */
  let webhook;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const at = new RegExp(`^/bot${BOT_TOKEN}/(\\w+)$`).exec(req.url ?? '');
      if (!at) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {}
      const method = at[1];
      calls.push({ method, body });
      if (method === 'setWebhook') {
        // Telegram takes an https address, and a secret of 1 to 256 letters, digits, "_" and "-".
        if (!/^https:\/\//.test(String(body.url ?? '')))
          return json(400, { ok: false, error_code: 400, description: 'Bad Request: bad webhook: An HTTPS URL must be provided for webhook' });
        if (body.secret_token !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(String(body.secret_token))) {
          return json(400, { ok: false, error_code: 400, description: 'Bad Request: secret token contains unallowed characters' });
        }
        webhook = { url: body.url, secret_token: body.secret_token, allowed_updates: body.allowed_updates };
        return json(200, { ok: true, result: true, description: 'Webhook was set' });
      }
      if (method === 'deleteWebhook') {
        webhook = undefined;
        return json(200, { ok: true, result: true, description: 'Webhook was deleted' });
      }
      if (method === 'getMe')
        return json(200, {
          ok: true,
          result: { id: 110201543, is_bot: true, first_name: 'Acme Support', username: 'acme_support_bot', can_join_groups: true },
        });
      const tooLong = body.rich_message ? String(body.rich_message.markdown ?? '').length > RICH_LIMIT : String(body.text ?? '').length > LIMIT;
      if (tooLong) return json(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' });
      if (/^(send|edit)/.test(method) && method !== 'sendChatAction') {
        return json(200, {
          ok: true,
          result: {
            message_id: body.message_id ?? ++n,
            date: Math.floor(Date.now() / 1000),
            chat: { id: body.chat_id, type: 'private' },
            from: { id: 110201543, is_bot: true, first_name: 'Acme Support' },
            text: body.text,
          },
        });
      }
      return json(200, { ok: true, result: true });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const update = (more, { signed = true, secret = SECRET } = {}) =>
    new Request(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(signed ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
      body: JSON.stringify({ update_id: ++n, ...more }),
    });
  const written = (text) => ({
    message: {
      message_id: ++n,
      from: ADA,
      chat: { id: ADA.id, type: 'private', first_name: ADA.first_name, last_name: ADA.last_name, username: ADA.username },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });

  return {
    adapter: { botToken: BOT_TOKEN, apiUrl: `http://127.0.0.1:${server.address().port}`, secretToken: SECRET, mode: 'webhook' },
    person: { id: String(ADA.id), name: 'Ada Lovelace' },
    maxTextLength: LIMIT,
    message: (text) => update(written(text)),
    /** The bot's webhook as Telegram holds it, or nothing when it has none. */
    webhook: () => webhook,
    /** A message sent with the secret the bot's webhook was set with, as Telegram sends once it has one. */
    viaWebhook: (text) => update(written(text), { secret: webhook?.secret_token }),
    forged: (text) => update(written(text), { signed: false }),
    sent() {
      return calls
        .splice(0)
        .filter((call) => /^send/.test(call.method) && call.method !== 'sendChatAction')
        .map((call) => ({
          // The adapter sends text as a "rich message" of markdown where the bot can, and as plain text with marks where not.
          text: call.body.rich_message ? String(call.body.rich_message.markdown ?? '') : read(call.body.text ?? call.body.caption, call.body.parse_mode),
          buttons: (call.body.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.text),
          raw: call,
        }));
    },
    click(item, label) {
      const button = (item.raw.body.reply_markup?.inline_keyboard ?? []).flat().find((b) => b.text === label);
      return update({
        callback_query: {
          id: `cb${++n}`,
          from: ADA,
          chat_instance: 'made-up',
          data: button?.callback_data,
          message: { message_id: 501, date: 0, chat: { id: ADA.id, type: 'private' }, text: item.text },
        },
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
