// A stand-in for the Bot Framework API a Teams bot calls, as a server on this
// machine: the real Teams adapter talks to it as it talks to Teams. It keeps
// the messages a bot sends as they stand, checks the bot's access token on
// every call, and records each call. It also builds what Teams sends a bot:
// a chat message, a channel post that mentions it, a reply, a button's click.
//
// Three of the adapter's own settings point it here, and nothing is patched:
// `apiUrl` (where it calls), `token` (an access token of its own making, in
// place of one from Microsoft) and `webhookVerifier` (who a request is from,
// in place of Microsoft's signed token).
import http from 'node:http';

export const APP_ID = '11111111-1111-4111-8111-111111111111';
export const TENANT = '22222222-2222-4222-8222-222222222222';
export const APP_PASSWORD = 'teams-app-password-never-printed';
export const ADA = { id: '29:1-ada', name: 'Ada Lovelace', aadObjectId: '33333333-3333-4333-8333-333333333333' };
export const ADA_EMAIL = 'ada@example.com';
/** Someone the bot has never had a message from. */
export const GRACE = { id: '29:1-grace', name: 'Grace Hopper', aadObjectId: '44444444-4444-4444-8444-444444444444' };
export const GRACE_EMAIL = 'grace@example.com';
const PEOPLE = { [ADA.id]: { ...ADA, email: ADA_EMAIL }, [GRACE.id]: { ...GRACE, email: GRACE_EMAIL } };
export const TEAM = '19:team-general@thread.tacv2';
export const CHANNEL = '19:channel-support@thread.tacv2';
export const CHAT = 'a:1-ada-and-bot';
export const GROUP_CHAT = '19:group-of-three@thread.v2';
/** What a request carries when it is Teams': the stand-in's own, checked by the adapter's `webhookVerifier`. */
export const SECRET = 'fake-teams-shared-secret';
/** What Teams was seen to refuse: a message near 100 KB. */
export const TOO_LARGE = 100_000;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function fakeTeams(options = {}) {
  const botName = options.botName ?? 'Acme Support';
  const bot = { id: `28:${APP_ID}`, name: botName };
  // In the shape of Microsoft's access token (the Teams SDK reads its claims), and signed by nobody.
  const accessToken = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ aud: 'https://api.botframework.com', appid: APP_ID, tid: TENANT, exp: Math.floor(Date.now() / 1000) + 3600 })}.${Buffer.from('unsigned-by-anyone').toString('base64url')}`;
  const state = {
    calls: [],
    /** Messages the bot sent, by ID, as they stand: an edit replaces one. */
    messages: new Map(),
    /** Answers a call another way: return a status (and a body) to refuse it. */
    refuse: options.refuse ?? (() => undefined),
    n: 1700000000100,
  };
  const next = () => String(++state.n);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const path = decodeURIComponent(req.url ?? '');
      const call = { method: req.method, path, body, bytes: Buffer.byteLength(raw), authorized: req.headers.authorization === `Bearer ${accessToken}` };
      state.calls.push(call);
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (!call.authorized) return json(401, { error: { code: 'Unauthorized', message: 'Authorization has been denied for this request.' } });
      const refused = state.refuse(call);
      if (refused) return json(refused.status, refused.body ?? { error: { code: 'BadSyntax', message: 'The stand-in refused this call.' } });
      const sent = /\/v3\/conversations\/([^/]+)\/activities$/.exec(path);
      if (req.method === 'POST' && sent) {
        // Typing is taken and shows nothing.
        if (body?.type === 'typing') return json(202, {});
        if (call.bytes > TOO_LARGE) return json(413, { error: { code: 'MessageSizeTooBig', message: 'Message size too large.' } });
        const id = next();
        state.messages.set(id, { ...body, id, conversation: sent[1] });
        return json(201, { id });
      }
      const one = /\/v3\/conversations\/([^/]+)\/activities\/([^/]+)$/.exec(path);
      if (one && req.method === 'PUT') {
        if (!state.messages.has(one[2])) return json(404, { error: { code: 'NotFound', message: 'No such activity.' } });
        state.messages.set(one[2], { ...body, id: one[2], conversation: one[1], edited: true });
        return json(200, { id: one[2] });
      }
      if (one && req.method === 'DELETE') {
        state.messages.delete(one[2]);
        return json(200, {});
      }
      const member = /\/members\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && member) {
        const person = PEOPLE[member[1]];
        if (!person) return json(404, { error: { code: 'MemberNotFoundInConversation', message: 'No such member.' } });
        return json(200, { ...person, userPrincipalName: person.email, tenantId: TENANT, userRole: 'user' });
      }
      if (req.method === 'GET' && /\/members\/?$/.test(path)) return json(200, [{ ...ADA, email: ADA_EMAIL, userPrincipalName: ADA_EMAIL }]);
      return json(200, {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}/`;

  /** What every activity Teams sends carries. Its `serviceUrl` is the stand-in: the adapter calls there too. */
  const activity = (conversation, more = {}) => ({
    type: 'message',
    id: next(),
    timestamp: new Date().toISOString(),
    serviceUrl: apiUrl,
    channelId: 'msteams',
    from: ADA,
    recipient: bot,
    conversation: { tenantId: TENANT, ...conversation },
    textFormat: 'plain',
    locale: 'en-US',
    entities: [{ type: 'clientInfo', locale: 'en-US', country: 'US', platform: 'Web', timezone: 'America/Toronto' }],
    channelData: { tenant: { id: TENANT } },
    ...more,
  });
  const inTeam = { tenant: { id: TENANT }, team: { id: TEAM }, channel: { id: CHANNEL }, teamsChannelId: CHANNEL, teamsTeamId: TEAM };

  return {
    apiUrl,
    bot,
    accessToken,
    /** The adapter's config that points it here. */
    adapter: {
      appId: APP_ID,
      appPassword: APP_PASSWORD,
      appTenantId: TENANT,
      apiUrl,
      token: () => accessToken,
      webhookVerifier: (request) => request.headers.get('x-fake-teams') === SECRET,
    },
    next,
    messages: state.messages,
    /** The calls since the last look. */
    taken: () => state.calls.splice(0),
    refuse(how) {
      state.refuse = how ?? (() => undefined);
    },
    /** A request as Teams sends one. `signed: false` is one from somebody else. */
    request(url, body, { signed = true } = {}) {
      return new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(signed ? { 'x-fake-teams': SECRET } : {}) },
        body: JSON.stringify(body),
      });
    },
    /** A message in the person's chat with the bot. */
    chat: (text, more = {}) => activity({ conversationType: 'personal', id: CHAT }, { text, ...more }),
    /**
     * A message in a team's channel: a new post, or a reply in the thread on post `root`. `mention` puts the
     * bot's mention first, as Teams writes one: `as` is the words it was written with, when a person shortened it.
     */
    inChannel(text, { root, mention = true, as = botName, more = {} } = {}) {
      const id = next();
      return activity(
        { conversationType: 'channel', id: `${CHANNEL};messageid=${root ?? id}`, isGroup: true },
        {
          id,
          text: mention ? `<at>${as}</at> ${text}`.trim() : text,
          entities: [...(mention ? [{ type: 'mention', mentioned: bot, text: `<at>${as}</at>` }] : []), { type: 'clientInfo', locale: 'en-US' }],
          channelData: inTeam,
          ...more,
        },
      );
    },
    /** A message in a chat of several people, the bot mentioned. */
    inGroupChat: (text) =>
      activity(
        { conversationType: 'groupChat', id: GROUP_CHAT, isGroup: true },
        { text: `<at>${botName}</at> ${text}`, entities: [{ type: 'mention', mentioned: bot, text: `<at>${botName}</at>` }] },
      ),
    /** A click on a button of the bot's message `messageId`, as Teams sends one: a message with a value and no text. */
    click(conversation, messageId, data, from = ADA) {
      const channel = conversation.startsWith(CHANNEL);
      return activity(channel ? { conversationType: 'channel', id: conversation, isGroup: true } : { conversationType: 'personal', id: conversation }, {
        id: `f:${next()}`,
        from,
        text: undefined,
        value: data,
        replyToId: messageId,
        channelData: channel ? { ...inTeam, legacy: { replyToId: messageId } } : { tenant: { id: TENANT }, legacy: {} },
      });
    },
    /** Stops the stand-in, and whatever connections the adapter left open to it. */
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The buttons of a message the bot sent, as the card holds them. */
export function buttonsOf(message) {
  const content = message?.attachments?.[0]?.content;
  return [...(content?.actions ?? []), ...(content?.body ?? []).flatMap((part) => part.actions ?? [])];
}
