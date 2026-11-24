// A stand-in for Discord's HTTP API, as a server on this machine: the real
// Discord adapter, and connect, talk to it as they talk to Discord. It keeps
// an application, its commands, channels, threads and messages, checks the
// bot's token on every call, and records each call.
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';

export const BOT_TOKEN = 'discord-bot-token-never-printed.abc.def';
export const APP_ID = '111111111111111111';
export const GUILD = '222222222222222222';
export const CHANNEL = '333333333333333333';
export const DM = '555555555555555555';
const REAL_API = 'https://discord.com/api/v10';
export const ADA = { id: '444444444444444444', username: 'ada', global_name: 'Ada Lovelace', discriminator: '0' };

export async function fakeDiscord(options = {}) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const state = {
    app: {
      id: APP_ID,
      name: 'Support Bot',
      verify_key: publicKey,
      /** Who made the application. */
      owner: { id: ADA.id, username: ADA.username },
      flags: options.flags ?? 0,
      interactions_endpoint_url: options.endpoint ?? null,
      /** The application's icon and the bot's picture, as Discord gives them: a hash, or null for none. */
      icon: options.icon ?? null,
      bot: { id: APP_ID, username: 'support-bot', global_name: null, avatar: options.avatar ?? null, bot: true },
      // As Discord's is: brought up to date once a day, so it says nothing of a bot added since. Always behind here.
      approximate_guild_count: 0,
    },
    /** How many servers the bot is in, as its own list of them says. */
    servers: options.servers ?? 0,
    /** After this many looks at that list, someone has added the bot to a server. Never, by default. */
    joinsAfter: options.joinsAfter ?? Number.POSITIVE_INFINITY,
    looks: 0,
    /** Whether the application's owner takes direct messages from the bot. */
    denyDm: options.denyDm ?? false,
    commands: structuredClone(options.commands ?? []),
    /** Threads by ID, with the channel each was started in. */
    threads: new Map(),
    calls: [],
    /** What Discord does when asked to take an address: by default it takes it. */
    verify: options.verify ?? (() => true),
    denyThreads: options.denyThreads ?? false,
    denyFlags: options.denyFlags ?? false,
    denyRename: options.denyRename ?? false,
    /** Refuses a new name for the bot, with what Discord says: it allows two changes an hour. */
    denyName: options.denyName ?? false,
    /** Whether Discord takes an image as the bot's picture, and as the application's icon: by default any PNG, JPG or GIF. */
    takesAvatar: options.takesAvatar ?? (() => true),
    takesIcon: options.takesIcon ?? (() => true),
    /** The images given, as they were sent. */
    pictures: { avatar: null, icon: null },
    /** The bot can't read a channel's messages back: it lacks Read Message History there. */
    denyRead: options.denyRead ?? false,
    /** Messages by ID, as they stand: an edit changes only what it names, as Discord's does. */
    messages: new Map(),
    /** How many more of an interaction's answers are refused: Discord hasn't taken the deferred answer yet. */
    unknownWebhook: options.unknownWebhook ?? 0,
  };
  let ids = 900000000000000000n;
  const next = () => String(++ids);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const path = req.url.replace(/^\/api\/v10/, '').replace(/\?.*$/, '');
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(status === 204 ? undefined : JSON.stringify(value));
      };
      const call = { method: req.method, path, body, agent: req.headers['user-agent'] };
      state.calls.push(call);
      // An interaction's own webhook carries no bot token: its token is in the path.
      const webhook = /^\/webhooks\/\d+\/[^/]+/.test(path) || /^\/interactions\//.test(path);
      if (!webhook && req.headers.authorization !== `Bot ${BOT_TOKEN}`) return json(401, { message: '401: Unauthorized', code: 0 });
      // As Discord does: an embed with nothing to show is refused, and so is a message with nothing in it.
      const refused = () => {
        const errors = {};
        (body?.embeds ?? []).forEach((embed, i) => {
          const shows = ['title', 'description', 'fields', 'image', 'thumbnail', 'author', 'footer', 'video', 'provider'].some((key) =>
            Array.isArray(embed[key]) ? embed[key].length : embed[key],
          );
          if (!shows) errors[i] = { description: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }] } };
        });
        if (Object.keys(errors).length) return { message: 'Invalid Form Body', code: 50035, errors: { embeds: errors } };
        // And a message over 2,000 characters.
        if ((body?.content?.length ?? 0) > 2000)
          return {
            message: 'Invalid Form Body',
            code: 50035,
            errors: { content: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2000 or fewer in length.' }] } },
          };
        return null;
      };
      const empty = () => !body?.content && !body?.embeds?.length && !body?.components?.length;
      const message = (channel_id, more = {}) => {
        const made = {
          id: next(),
          channel_id,
          author: state.app.bot,
          content: body?.content ?? '',
          timestamp: new Date().toISOString(),
          embeds: body?.embeds ?? [],
          components: body?.components ?? [],
          ...more,
        };
        state.messages.set(made.id, made);
        return made;
      };
      /** An edit: only what it names changes. Buttons it says nothing of stay. */
      const edited = (channel_id, id) => {
        const was = state.messages.get(id) ?? { id, channel_id, author: state.app.bot, content: '', embeds: [], components: [] };
        const now = {
          ...was,
          ...Object.fromEntries(['content', 'embeds', 'components'].filter((k) => body && k in body).map((k) => [k, body[k] ?? (k === 'content' ? '' : [])])),
        };
        state.messages.set(id, now);
        return now;
      };
      let m;
      if (req.method === 'GET' && path === '/users/@me') return json(200, state.app.bot);
      if (req.method === 'GET' && path === '/users/@me/guilds') {
        state.looks += 1;
        if (state.servers === 0 && state.looks > state.joinsAfter) state.servers = 1;
        return json(
          200,
          Array.from({ length: state.servers }, (_, i) => ({ id: String(BigInt(GUILD) + BigInt(i)), name: i ? `Server ${i + 1}` : 'Acme HQ' })),
        );
      }
      // The bot's own conversation with a person: opened, then written in.
      if (req.method === 'POST' && path === '/users/@me/channels') return json(200, { id: DM, type: 1, recipients: [{ id: body?.recipient_id }] });
      const invalid = (field, code, message) => json(400, { code: 50035, message: 'Invalid Form Body', errors: { [field]: { _errors: [{ code, message }] } } });
      const image = (data) => /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/.test(data ?? '');
      if (req.method === 'PATCH' && path === '/users/@me') {
        if ('username' in body) {
          // As Discord does: 2 to 32 characters, some of them never, and only so often.
          if (state.denyName) return invalid('username', 'USERNAME_RATE_LIMIT', 'You are changing your username or Discord Tag too fast. Try again later.');
          if (typeof body.username !== 'string' || body.username.length < 2 || body.username.length > 32)
            return invalid('username', 'BASE_TYPE_BAD_LENGTH', 'Must be between 2 and 32 in length.');
          if (/[@#:]|```|discord/i.test(body.username)) return invalid('username', 'USERNAME_INVALID_CONTAINS', 'Username cannot contain "discord"');
          state.app.bot.username = body.username;
        }
        if ('avatar' in body) {
          if (!image(body.avatar) || !state.takesAvatar(body.avatar)) return invalid('avatar', 'IMAGE_INVALID', 'Invalid image data');
          state.app.bot.avatar = 'a1b2c3';
          state.pictures.avatar = body.avatar;
        }
        return json(200, state.app.bot);
      }
      if (req.method === 'GET' && (m = path.match(/^\/users\/(\d+)$/)))
        return m[1] === ADA.id ? json(200, ADA) : json(404, { message: 'Unknown User', code: 10013 });
      if (path === '/applications/@me' && req.method === 'GET') return json(200, state.app);
      if (path === '/applications/@me' && req.method === 'PATCH') {
        if ('icon' in body) {
          if (!image(body.icon) || !state.takesIcon(body.icon)) return invalid('icon', 'IMAGE_INVALID', 'Invalid image data');
          state.app.icon = 'd4e5f6';
          state.pictures.icon = body.icon;
        }
        if ('flags' in body) {
          if (state.denyFlags) return json(403, { message: 'Missing Access', code: 50001 });
          state.app.flags = body.flags;
        }
        if ('interactions_endpoint_url' in body) {
          if (body.interactions_endpoint_url && !(await state.verify(body.interactions_endpoint_url))) {
            return json(400, {
              code: 50035,
              message: 'Invalid Form Body',
              errors: {
                interactions_endpoint_url: {
                  _errors: [
                    { code: 'APPLICATION_INTERACTIONS_ENDPOINT_URL_INVALID', message: 'The specified interactions endpoint url could not be verified.' },
                  ],
                },
              },
            });
          }
          state.app.interactions_endpoint_url = body.interactions_endpoint_url;
        }
        return json(200, state.app);
      }
      if ((m = path.match(/^\/applications\/(\d+)\/commands$/))) {
        if (req.method === 'GET') return json(200, state.commands);
        if (req.method === 'POST') {
          // As Discord does: a command of the same name is replaced, the others are left.
          const made = { id: next(), application_id: m[1], type: 1, ...body };
          state.commands = [...state.commands.filter((c) => c.name !== body.name), made];
          return json(201, made);
        }
      }
      if (req.method === 'DELETE' && (m = path.match(/^\/applications\/\d+\/commands\/(\d+)$/))) {
        state.commands = state.commands.filter((c) => c.id !== m[1]);
        return json(204);
      }
      if ((m = path.match(/^\/channels\/(\d+)$/))) {
        const thread = state.threads.get(m[1]);
        if (req.method === 'PATCH' && state.denyRename) return json(403, { message: 'Missing Permissions', code: 50013 });
        if (req.method === 'PATCH' && thread) Object.assign(thread, body);
        if (thread) return json(200, { id: m[1], type: 11, guild_id: GUILD, parent_id: thread.parent, name: thread.name });
        return json(200, { id: m[1], type: m[1] === DM ? 1 : 0, guild_id: m[1] === DM ? undefined : GUILD, name: 'general', parent_id: null });
      }
      if (req.method === 'POST' && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/))) {
        if (state.denyThreads) return json(403, { message: 'Missing Permissions', code: 50013 });
        // As Discord does: a thread started from a message has that message's ID.
        state.threads.set(m[2], { parent: m[1], name: body?.name ?? '' });
        return json(201, { id: m[2], type: 11, guild_id: GUILD, parent_id: m[1], name: body?.name ?? '' });
      }
      if (req.method === 'GET' && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
        if (state.denyRead) return json(403, { message: 'Missing Access', code: 50001 });
        const found = state.messages.get(m[2]);
        return found ? json(200, found) : json(404, { message: 'Unknown Message', code: 10008 });
      }
      if (req.method === 'POST' && (m = path.match(/^\/channels\/(\d+)\/messages$/))) {
        if (m[1] === DM && state.denyDm) return json(403, { message: 'Cannot send messages to this user', code: 50007 });
        if (refused()) return json(400, refused());
        if (empty()) return json(400, { message: 'Cannot send an empty message', code: 50006 });
        return json(200, message(m[1]));
      }
      if (req.method === 'PATCH' && (m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
        return refused() ? json(400, refused()) : json(200, edited(m[1], m[2]));
      }
      if (req.method === 'POST' && /^\/channels\/\d+\/typing$/.test(path)) return json(204);
      if (req.method === 'POST' && /^\/interactions\/\d+\/[^/]+\/callback/.test(path)) return json(204);
      if (/^\/webhooks\/\d+\/[^/]+/.test(path)) {
        // An interaction is answered "an answer is coming" in the reply to Discord's own request. Until Discord has
        // that reply it knows of no such interaction: an answer that gets there first is refused, however it's sent.
        if (state.unknownWebhook > 0) {
          state.unknownWebhook -= 1;
          return json(404, { message: 'Unknown Webhook', code: 10015 });
        }
        if (refused()) return json(400, refused());
        return json(200, message(CHANNEL));
      }
      return json(200, {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}/api/v10`;

  // The adapter answers an interaction through Discord's own address, whatever `apiUrl` it was given. So while this
  // stand-in is up, a call to Discord's API comes here, and one to anywhere else of Discord's fails: no test reaches it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(REAL_API)) return realFetch(`${apiUrl}${url.slice(REAL_API.length)}`, init);
    if (/(^|\.)discord(app)?\.com$/.test(new URL(url).hostname)) throw new Error(`A test reached for the real Discord: ${url}`);
    return realFetch(input, init);
  };

  /** A request signed as Discord signs one: an interaction to your server. */
  const signed = (url, payload, { forged = false } = {}) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = forged ? generateKeyPairSync('ed25519').privateKey : keys.privateKey;
    const signature = sign(null, Buffer.from(timestamp + body), key).toString('hex');
    return new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
      body,
    });
  };
  /** A Gateway event passed on to your server, as the adapter's listener passes one. */
  const forwarded = (url, type, data, token = BOT_TOKEN) =>
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-discord-gateway-token': token },
      body: JSON.stringify({ type, timestamp: Date.now(), data }),
    });
  /** A message someone wrote, as the Gateway sends it. Discord has it too: the bot can read it back. */
  const written = (content, more = {}) => {
    const message = {
      id: next(),
      channel_id: CHANNEL,
      channel_type: 0,
      guild_id: GUILD,
      author: ADA,
      member: { roles: [] },
      content,
      timestamp: new Date().toISOString(),
      mentions: content.includes(`<@${APP_ID}>`) ? [state.app.bot] : [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      components: [],
      type: 0,
      ...more,
    };
    state.messages.set(message.id, message);
    return message;
  };
  return {
    state,
    apiUrl,
    publicKey,
    next,
    signed,
    forwarded,
    written,
    /** The calls made since the last time this was asked, each as "METHOD /path". */
    taken: () => state.calls.splice(0),
    close: () => {
      globalThis.fetch = realFetch;
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
