// A Voiceflow agent in Teams, end to end on this machine: the real Teams
// adapter and core's agent, against a stand-in for the Bot Framework API and a
// scripted Voiceflow runtime. Requests arrive as Teams sends them, and every
// call the bot makes is checked for its access token. Nothing leaves this machine.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';
import { inspect } from 'node:util';
import { createMemoryState } from '@chat-adapter/state-memory';
import * as teamsAdapterModule from '@chat-adapter/teams';
import { createChannels } from '@voiceflow/channelkit';
import { fakeVoiceflow, waiter } from '@voiceflow/channelkit/testing';
import { CONTEXT_VARIABLES, createTeamsExtension, MAX_TEXT, teams, teamsLogger } from '../dist/index.js';
import { ADA, ADA_EMAIL, APP_PASSWORD, buttonsOf, CHANNEL, CHAT, fakeTeams, GRACE, TEAM, TENANT } from './helpers/fake-teams.mjs';

// Microsoft's Teams SDK prints its own warnings (one on every start, for an option the adapter always passes).
// They say nothing of these tests: only its errors are shown.
process.env.LOG_LEVEL = 'error';

const URL_ = 'https://bot.example.com/api/teams';
const text = (message) => ({ type: 'text', payload: { message, slate: { id: 's', content: [] }, messageID: 'm' } });
const silent = { child: () => silent, debug() {}, info() {}, warn() {}, error() {} };

// Whatever the adapter or Microsoft's SDK reaches for beyond this machine is stopped and written down.
const outside = [];
for (const transport of [http, https]) {
  const request = transport.request;
  transport.request = function guarded(...args) {
    const req = request.apply(this, args);
    const host = String(req.getHeader?.('host') ?? req.host ?? '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      outside.push(`${req.method} ${host}${req.path}`);
      req.destroy(new Error('the tests reach nothing outside this machine'));
    }
    return req;
  };
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
  outside.push(`${init?.method ?? 'GET'} ${url}`);
  return Promise.reject(new Error('the tests reach nothing outside this machine'));
};

/** The stand-ins a test started: each is closed when the test ends, passed or failed, so a failure never leaves the run waiting. */
const started = [];

async function setup({ options = {}, api = {}, answer, logger = silent, bare = false } = {}) {
  const fake = await fakeTeams(api);
  started.push(fake);
  const errors = [];
  const voiceflow = fakeVoiceflow(
    answer ??
      ((action) => {
        if (action.type === 'path-track') return [text('It ships **tomorrow**.')];
        return [
          text(`You said: ${typeof action.payload === 'string' ? action.payload : action.type}`),
          {
            type: 'choice',
            payload: { buttons: [{ name: 'Track order', request: { type: 'path-track', payload: { label: 'Track order' } } }, { name: 'Talk to someone' }] },
          },
        ];
      }),
  );
  const channels = await createChannels({
    voiceflow: { apiKey: 'VF.DM.teams-contract', projectID: 'proj1', environment: 'development', fetch: voiceflow.fetch },
    channels: [
      bare
        ? { slug: 'teams', module: teamsAdapterModule, options: { ...fake.adapter, ...(logger ? { logger } : {}) } }
        : teams({ ...options, adapter: { ...fake.adapter, ...(logger ? { logger } : {}), ...options.adapter } }),
    ],
    state: createMemoryState(),
    onError: (error) => errors.push(error),
  });
  const wait = waiter();
  const send = async (activity, how) => {
    const response = await channels.webhook('teams', fake.request(URL_, activity, how), wait.options);
    await wait.settle();
    // The adapter answers Teams, then goes on: give what it started a moment to finish.
    for (let quiet = 0, seen = -1; quiet < 2; ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await wait.settle();
      const now = fake.messages.size + voiceflow.interacts.length;
      quiet = now === seen ? quiet + 1 : 0;
      seen = now;
    }
    return response;
  };
  /** The messages the bot sent since the last look, typing aside. */
  const sent = () =>
    fake
      .taken()
      .filter((call) => call.method === 'POST' && /\/activities$/.test(call.path) && call.body?.type !== 'typing')
      .map((call) => call.body);
  return { fake, voiceflow, errors, channels, send, sent, said: () => voiceflow.interacts.map((turn) => turn.action) };
}

test.afterEach(async () => {
  await Promise.all(started.splice(0).map((fake) => fake.close()));
  assert.deepEqual(outside.splice(0), [], 'nothing was reached outside this machine');
});

test('a request that is not from Teams is refused, and nothing happens', async () => {
  const t = await setup();
  const response = await t.send(t.fake.chat('hello'), { signed: false });
  assert.equal(response.status, 401);
  assert.equal(t.voiceflow.interacts.length, 0);
  assert.deepEqual(t.fake.taken(), []);
});

test('a chat message is answered, with its choices as buttons', async () => {
  const t = await setup();
  const response = await t.send(t.fake.chat('where is my order?'));
  assert.equal(response.status, 200);
  assert.deepEqual(t.said(), [{ type: 'text', payload: 'where is my order?' }]);
  const calls = t.fake.taken();
  assert.ok(
    calls.every((call) => call.authorized),
    'every call carries the access token',
  );
  assert.ok(
    calls.some((call) => call.body?.type === 'typing'),
    'the bot shows it is typing',
  );
  const messages = calls.filter((call) => call.method === 'POST' && call.body?.type === 'message').map((call) => call.body);
  assert.equal(messages[0].text, 'You said: where is my order?');
  assert.deepEqual(
    buttonsOf(messages[1]).map((button) => button.title),
    ['Track order', 'Talk to someone'],
  );
  assert.ok(
    calls.every((call) => call.path.includes(`/conversations/${CHAT}/`)),
    'it answers in the chat',
  );
  assert.deepEqual(t.errors, []);
});

test('a click on a button reaches the agent as its choice, and the buttons come off', async () => {
  const t = await setup();
  await t.send(t.fake.chat('hello'));
  const [card] = [...t.fake.messages.values()].filter((message) => buttonsOf(message).length);
  t.fake.taken();
  await t.send(t.fake.click(CHAT, card.id, buttonsOf(card)[0].data));
  assert.deepEqual(t.said().at(-1), { type: 'path-track', payload: { label: 'Track order' } });
  const after = t.fake.messages.get(card.id);
  assert.ok(after.edited, 'the message that had the buttons was replaced');
  assert.deepEqual(buttonsOf(after), [], 'and has none now');
  assert.match(JSON.stringify(after), /Track order/, 'it says what was chosen');
  assert.match(t.sent().at(-1).text, /It ships \*\*tomorrow\*\*\./);
  assert.deepEqual(t.errors, []);
});

test("in a channel the bot's own mention is no part of what was asked, whatever the bot is called", async () => {
  // The bot is "Acme Support" in Teams; nothing on the server says so.
  const t = await setup();
  const post = t.fake.inChannel("where's my order?");
  await t.send(post);
  assert.deepEqual(t.said(), [{ type: 'text', payload: "where's my order?" }]);
  // The answer is a reply in the thread on that post.
  const replies = t.fake.taken().filter((call) => call.method === 'POST');
  assert.ok(replies.length >= 2);
  assert.ok(replies.every((call) => call.path.includes(`/conversations/${CHANNEL};messageid=${post.id}/`)));
});

test('a mention a person shortened is taken out too, and a mention of someone else is kept', async () => {
  const t = await setup();
  await t.send(t.fake.inChannel('ask @Grace Hopper about my order', { as: 'Acme' }));
  assert.deepEqual(t.said(), [{ type: 'text', payload: 'ask @Grace Hopper about my order' }]);
});

test('a message that is only the mention is sent as it is, not as nothing', async () => {
  const t = await setup();
  await t.send(t.fake.inChannel(''));
  assert.deepEqual(t.said(), [{ type: 'text', payload: '@Acme Support' }]);
});

test('a thread the bot is in needs no mention, and a post elsewhere in the channel is not for the bot', async () => {
  const t = await setup();
  const post = t.fake.inChannel('I need help');
  await t.send(post);
  await t.send(t.fake.inChannel('and when will it arrive?', { root: post.id, mention: false }));
  assert.deepEqual(t.said().at(-1), { type: 'text', payload: 'and when will it arrive?' });
  const turns = t.voiceflow.interacts.length;
  t.fake.taken();
  // With the permission that lets it read a thread's replies, Teams sends the bot every message in the channel.
  await t.send(t.fake.inChannel('lunch?', { mention: false }));
  assert.equal(t.voiceflow.interacts.length, turns, 'no turn');
  assert.deepEqual(t.fake.taken(), [], 'and nothing sent');
});

test('who and where are set as variables: in a chat, in a channel, and on a click', async () => {
  const t = await setup();
  const message = t.fake.chat('hello');
  await t.send(message);
  const chat = t.voiceflow.interacts.at(-1).variables;
  assert.deepEqual(Object.keys(CONTEXT_VARIABLES).sort(), Object.keys(chat).sort(), 'every variable, every turn');
  assert.deepEqual(chat, {
    teams_user_id: ADA.id,
    teams_user_aad_id: ADA.aadObjectId,
    teams_user_name: ADA.name,
    teams_user_email: ADA_EMAIL,
    teams_tenant_id: TENANT,
    teams_team_id: '',
    teams_channel_id: '',
    teams_conversation_type: 'personal',
    teams_message_id: message.id,
  });

  const post = t.fake.inChannel('hello');
  await t.send(post);
  const channel = t.voiceflow.interacts.at(-1).variables;
  assert.equal(channel.teams_conversation_type, 'channel');
  assert.equal(channel.teams_team_id, TEAM);
  assert.equal(channel.teams_channel_id, CHANNEL);
  assert.equal(channel.teams_message_id, post.id);

  // A click says who clicked and where, and no more: the rest is what the last message there said.
  const card = [...t.fake.messages.values()].filter((sent) => buttonsOf(sent).length).at(-1);
  await t.send(t.fake.click(`${CHANNEL};messageid=${post.id}`, card.id, buttonsOf(card)[0].data));
  const click = t.voiceflow.interacts.at(-1).variables;
  assert.equal(t.said().at(-1).type, 'path-track');
  assert.deepEqual({ ...click }, { ...channel, teams_message_id: '' }, 'the same person and place, and no message');

  // A click by someone the bot has had no message from. The adapter can say who they are only by asking Microsoft
  // Graph, which a bot may not read without an admin's consent: so they are their ID, and never the last person.
  const again = t.fake.inChannel('once more');
  await t.send(again);
  const second = [...t.fake.messages.values()].filter((sent) => buttonsOf(sent).length).at(-1);
  await t.send(t.fake.click(`${CHANNEL};messageid=${again.id}`, second.id, buttonsOf(second)[0].data, GRACE));
  const other = t.voiceflow.interacts.at(-1).variables;
  assert.equal(other.teams_user_id, GRACE.id);
  assert.equal(other.teams_user_name, '');
  assert.equal(other.teams_user_email, '');
  assert.equal(other.teams_user_aad_id, '');
  assert.equal(other.teams_team_id, TEAM, 'in the same team');
  // That asking is the one thing here that leaves this machine, and it is stopped: said, so it isn't a surprise.
  assert.deepEqual(outside.splice(0), [`GET graph.microsoft.com/v1.0/users/${GRACE.aadObjectId}`]);

  // A message that names its team and not its channel: the channel is the conversation's own, without the thread's post.
  const bare = t.fake.inChannel('where am I?', { more: { channelData: { tenant: { id: TENANT }, team: { id: TEAM } } } });
  await t.send(bare);
  assert.equal(t.voiceflow.interacts.at(-1).variables.teams_channel_id, CHANNEL);
  assert.deepEqual(t.errors, []);
});

test('context: false sets no variables', async () => {
  const t = await setup({ options: { context: false } });
  await t.send(t.fake.chat('hello'));
  assert.deepEqual(t.voiceflow.interacts.at(-1).variables ?? {}, {});
});

test('a long answer goes as several messages, each one Teams takes, and none of it is lost', async () => {
  const sentences = Array.from({ length: 2600 }, (_, i) => `Sentence number ${i + 1} of a long answer about the returns policy.`);
  const long = sentences.join(' ');
  assert.ok(long.length > 150_000, 'longer than Teams takes in one message');
  const t = await setup({ answer: () => [text(long)] });
  await t.send(t.fake.chat('tell me everything'));
  const parts = t.sent().map((message) => message.text);
  assert.ok(parts.length >= 8, `in ${parts.length} messages`);
  assert.ok(
    parts.every((part) => part.length <= MAX_TEXT),
    'each within the limit',
  );
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long, 'the whole answer, in order');
  assert.deepEqual(t.errors, [], 'and Teams refused none of it');
});

test('without the limit Teams refuses the whole answer: what the limit is for', async () => {
  const long = Array.from({ length: 2600 }, (_, i) => `Sentence number ${i + 1} of a long answer about the returns policy.`).join(' ');
  const fake = await fakeTeams();
  started.push(fake);
  const errors = [];
  const voiceflow = fakeVoiceflow(() => [text(long)]);
  // The adapter alone, as the core runs any catalog adapter: no Teams package.
  const channels = await createChannels({
    voiceflow: { apiKey: 'VF.DM.teams-contract', projectID: 'proj1', environment: 'development', fetch: voiceflow.fetch },
    channels: [{ slug: 'teams', options: { ...fake.adapter, logger: silent } }],
    state: createMemoryState(),
    onError: (error) => errors.push(error),
  });
  const wait = waiter();
  await channels.webhook('teams', fake.request(URL_, fake.chat('tell me everything')), wait.options);
  await wait.settle();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await wait.settle();
  const messages = fake
    .taken()
    .filter((call) => call.method === 'POST' && call.body?.type === 'message')
    .map((call) => call.body.text);
  assert.equal(messages.length, 2, 'the answer, refused, and then an apology');
  assert.match(messages[1], /went wrong/i);
  assert.equal(errors.length, 1);
});

test('a heading is sent as a bold line, since Teams shows no headings', async () => {
  const answer = () => [text('## Your order\n\nIt ships tomorrow.\n\n```md\n# not a heading\n```')];
  const t = await setup({ answer });
  await t.send(t.fake.chat('status?'));
  const [message] = t.sent();
  assert.match(message.text, /^\*\*Your order\*\*/);
  assert.match(message.text, /# not a heading/, 'code is left as it is');

  // Turned off, the adapter sends the heading's words as a plain line.
  const off = await setup({ answer, options: { headings: false } });
  await off.send(off.fake.chat('status?'));
  assert.doesNotMatch(off.sent()[0].text, /\*\*Your order\*\*/);
});

test('a card goes as a card, with its picture and its button', async () => {
  const card = {
    title: 'Plan A',
    description: { text: 'The basic plan' },
    imageUrl: 'https://example.com/a.png',
    buttons: [{ name: 'Pick A', request: { type: 'pick-a' } }],
  };
  const t = await setup({ answer: () => [text('Here is the plan:'), { type: 'cardV2', payload: card }] });
  await t.send(t.fake.chat('show me'));
  const [intro, shown] = t.sent();
  assert.equal(intro.text, 'Here is the plan:');
  const content = shown.attachments[0].content;
  assert.equal(shown.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.ok(JSON.stringify(content.body).includes('https://example.com/a.png'));
  assert.deepEqual(
    buttonsOf(shown).map((button) => button.title),
    ['Pick A'],
  );
  assert.deepEqual(t.errors, []);
});

test("a failed call to Teams is logged in a line, without the bot's access token or its secret", async () => {
  const lines = [];
  const capture =
    (level) =>
    (message, ...args) =>
      lines.push(`${level} ${message} ${JSON.stringify(args)}`);
  const base = { child: () => base, debug() {}, info() {}, warn: capture('warn'), error: capture('error') };
  const t = await setup({ logger: teamsLogger(base) });
  t.fake.refuse((call) =>
    call.method === 'POST' && call.body?.type === 'message'
      ? { status: 400, body: { error: { code: 'BadArgument', message: 'Activity was not valid.' } } }
      : undefined,
  );
  await t.send(t.fake.chat('hello'));
  const logged = lines.join('\n');
  assert.match(logged, /error Teams API: send failed/);
  assert.match(logged, /"status":400/);
  assert.match(logged, /BadArgument: Activity was not valid\./, 'what Teams answered is there');
  assert.ok(!logged.includes(t.fake.accessToken), 'the access token is not');
  assert.ok(!logged.includes(APP_PASSWORD));
  assert.doesNotMatch(logged, /Authorization|Bearer|"stack"|"config"/);
  assert.ok(logged.length < 4000, `a few lines, not a page: ${logged.length} characters`);
  assert.equal(t.errors.length >= 1, true, 'the turn failed and said so');
});

test('a logger of your own gets the same lines, with no access token in them', async () => {
  const lines = [];
  // As the Chat SDK's console logger prints: the message, and each argument as Node shows an object.
  const capture = (message, ...args) => lines.push(`${message} ${args.map((arg) => inspect(arg, { depth: 8 })).join(' ')}`);
  const raw = { child: () => raw, debug: capture, info: capture, warn: capture, error: capture };
  const t = await setup({ logger: raw });
  t.fake.refuse((call) =>
    call.method === 'POST' && call.body?.type === 'message'
      ? { status: 400, body: { error: { code: 'BadArgument', message: 'Activity was not valid.' } } }
      : undefined,
  );
  await t.send(t.fake.chat('hello'));
  const logged = lines.join('\n');
  assert.match(logged, /Teams API: send failed/, 'the failure is logged');
  assert.match(logged, /BadArgument/, 'with what Teams answered');
  assert.ok(!logged.includes(t.fake.accessToken), 'and without the access token the failed request carried');
  assert.ok(!logged.includes(APP_PASSWORD));
  assert.doesNotMatch(logged, /Authorization|Bearer ey/);
});

test('Teams through the core alone, with no package of its own, logs no access token either', async () => {
  const printed = [];
  const real = { info: console.info, error: console.error, debug: console.debug, warn: console.warn, log: console.log };
  for (const level of Object.keys(real))
    console[level] = (...args) => printed.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 8 }))).join(' '));
  let t;
  try {
    // The adapter by its name in the catalog, and its own console logger: what an app without this package has.
    t = await setup({ bare: true, logger: null });
    t.fake.refuse((call) =>
      call.method === 'POST' && call.body?.type === 'message'
        ? { status: 400, body: { error: { code: 'BadArgument', message: 'Activity was not valid.' } } }
        : undefined,
    );
    await t.send(t.fake.chat('hello'));
  } finally {
    Object.assign(console, real);
  }
  const logged = printed.join('\n');
  assert.match(logged, /Teams API: send failed/, 'the failure is printed on the console');
  assert.ok(!logged.includes(t.fake.accessToken), 'without the access token');
  assert.ok(!logged.includes(APP_PASSWORD), "or the app's secret");
  assert.doesNotMatch(logged, /Authorization|Bearer ey/);
});

test('the extension is the Teams one, and says what the core needs of it', () => {
  const extension = createTeamsExtension();
  assert.equal(extension.slug, 'teams');
  assert.equal(extension.maxTextLength, MAX_TEXT);
  assert.equal(typeof extension.adapterDefaults.logger.warn, 'function');
  assert.equal(teams().slug, 'teams');
  assert.ok(teams().module.createTeamsAdapter, "the adapter's module rides along, for a bundled server");
});
